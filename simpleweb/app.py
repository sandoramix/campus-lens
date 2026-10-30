import json
import logging
import os
import glob
import gzip
import hashlib
import mimetypes
import threading
from urllib.parse import urlsplit
from flask import Flask, Response, jsonify, render_template, request, send_from_directory
import time
from datetime import datetime, timedelta, timezone
from collections import defaultdict
import numbers
import re
import requests

from api import API

log = logging.getLogger("campus-lens.web")

if os.environ.get("CAMPUS_LENS_IMG_LOG", "").strip().lower() not in ("1", "true", "yes", "on"):
	log.setLevel(logging.WARNING)

	class _HideImgAccessLog(logging.Filter):
		def filter(self, record):
			return '"GET /img' not in record.getMessage()

	logging.getLogger("werkzeug").addFilter(_HideImgAccessLog())

SERVER_PORT = 8080

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("CAMPUS_LENS_DATA_DIR", os.path.join(ROOT_DIR, "data"))
CONFIG_PATH = os.path.join(ROOT_DIR, "config.json")
if (not os.path.exists(DATA_DIR)):
	os.mkdir(DATA_DIR)
USER_CACHE_PATH = os.path.join(DATA_DIR, "cached_users.json")
CAMPUSES_PATH = os.path.join(DATA_DIR, "campuses.json")
DEFAULT_STUDENTS_PATH = os.path.join(DATA_DIR, "students.json")
CACHE_EXPIRATION_HOURS = 6

CPISCINE_FINAL_EXAM_NAME = "C Piscine Final Exam"

# Fields computed by the server for every student (meaningful only after a fullscan)
DERIVED_FIELDS = [
	{"name": "average_exam_final_mark", "type": "number", "description": "Average final mark of the matching exams."},
	{"name": "average_project_final_mark", "type": "number", "description": "Average final mark of the matching projects."},
	{"name": "average_mark", "type": "number", "description": "Average final mark of every exam and project."},
	{"name": "cpiscine_final_mark", "type": "number", "description": f"Final mark of the '{CPISCINE_FINAL_EXAM_NAME}'."},
	{"name": "stage", "type": "string", "description": "'upcoming' (subscribed to a 42cursus that has not started yet), 'pisciner' (C Piscine is their only cursus), 'cadet' (enrolled in 42cursus) or 'other'."},
	{"name": "cursus_start", "type": "string", "description": "Start date of the 42cursus, only for students whose common core has not started yet."},
	{"name": "cursus", "type": "array", "description": "Slugs of every cursus the student is enrolled in."},
	{"name": "level", "type": "number", "description": "Level in the main cursus (42cursus if present, otherwise the highest)."},
	{"name": "cursus_status", "type": "string", "description": "In the 42cursus: 'upcoming', 'active', 'blackholed' (cursus ended at the blackhole), 'left' (ended otherwise) or 'graduated'."},
	{"name": "cursus_end", "type": "string", "description": "Day the 42cursus ended, for blackholed or left students."},
	{"name": "exams_passed", "type": "number", "description": "Number of validated exams."},
	{"name": "projects_passed", "type": "number", "description": "Number of validated projects."},
]
DERIVED_FIELD_NAMES = {f["name"] for f in DERIVED_FIELDS}

CONDITION_HELP = "Accepts >=, <=, >, <, ==, != prefixes (e.g. >=80); without a prefix it means 'contains'."

CUSTOM_FILTERS = [
	{"name": "fullscan", "type": "boolean", "description": f"Load every exam and project of each student. Profiles never fetched are fetched from the 42 API; cached ones are kept, even when older than {CACHE_EXPIRATION_HOURS}h."},
	{"name": "rescan", "type": "string", "description": f"Fetch again before searching: 'students' (the campus student list), 'profiles' (the matching profiles, with fullscan) or 'students,profiles'; '1' means 'profiles'. Only what is older than {CACHE_EXPIRATION_HOURS}h is fetched, unless 'force' is set."},
	{"name": "force", "type": "boolean", "description": "With rescan: fetch everything again, however recent."},
	{"name": "campus_id", "type": "string", "description": "Campus whose students file to use."},
	{"name": "examname", "type": "string", "description": "Exam name (or slug) contains; separate alternatives with '|'."},
	{"name": "exam_mark", "type": "string", "description": f"Final mark of a matching exam. {CONDITION_HELP}"},
	{"name": "exam_status", "type": "string", "description": "Status of a matching exam (finished, in_progress, ...)."},
	{"name": "exam_validated", "type": "boolean", "description": "Whether a matching exam is validated."},
	{"name": "exam_required", "type": "boolean", "description": "Keep only students with at least one matching exam."},
	{"name": "projectname", "type": "string", "description": "Project name (or slug) contains; separate alternatives with '|'."},
	{"name": "project_mark", "type": "string", "description": f"Final mark of a matching project. {CONDITION_HELP}"},
	{"name": "project_status", "type": "string", "description": "Status of a matching project (finished, in_progress, ...)."},
	{"name": "project_validated", "type": "boolean", "description": "Whether a matching project is validated."},
	{"name": "project_required", "type": "boolean", "description": "Keep only students with at least one matching project."},
	{"name": "sortby", "type": "string", "description": "Sort by any field, including the computed ones."},
	{"name": "order", "type": "string", "description": "Sort order: 'asc' or 'desc'."},
]
# Parameters only used by the web client (never treated as filters)
CLIENT_PARAMS = {"view", "display", "q", "page"}
CUSTOM_FILTER_NAMES = {f["name"] for f in CUSTOM_FILTERS} | CLIENT_PARAMS

app = Flask("server", root_path=os.path.dirname(os.path.abspath(__file__)))

#------------------------------------------------------------------------------
# STUDENTS FILES

def load_config():
	try:
		with open(CONFIG_PATH, "r") as f:
			return json.load(f)
	except Exception:
		return {}

def campus_students_path(campus_id):
	return os.path.join(DATA_DIR, f"campus_{campus_id}_students.json")

def available_campus_ids():
	ids = []
	for path in glob.glob(os.path.join(DATA_DIR, "campus_*_students.json")):
		match = re.match(r"campus_(\d+)_students\.json$", os.path.basename(path))
		if match:
			ids.append(int(match.group(1)))
	return sorted(ids)

def resolve_students_file(campus_id=None):
	"""Returns (path, campus_id) of the students file to use, or (None, campus_id) if missing.

	Without an explicit campus: data/students.json, then the default campus from
	config.json, then the first campus file found."""
	if campus_id is not None:
		path = campus_students_path(campus_id)
		return (path if os.path.exists(path) else None), campus_id
	if os.path.exists(DEFAULT_STUDENTS_PATH):
		return DEFAULT_STUDENTS_PATH, None
	default_campus = load_config().get("defaultCampus")
	if default_campus is not None and os.path.exists(campus_students_path(default_campus)):
		return campus_students_path(default_campus), int(default_campus)
	ids = available_campus_ids()
	if ids:
		return campus_students_path(ids[0]), ids[0]
	return None, None

_students_file_cache = {}

def load_students_file(path):
	"""Loads a students file (cached by modification time). Returns (students, basic_keys)."""
	mtime = os.path.getmtime(path)
	cached = _students_file_cache.get(path)
	if not cached or cached[0] != mtime:
		with open(path, 'r') as file:
			data = json.load(file)
		keys = set()
		for student in data:
			keys.update(flatten_keys(student).keys())
		cached = (mtime, data, keys)
		_students_file_cache[path] = cached
	# shallow copies: request handling adds computed fields to each student
	return [dict(s) for s in cached[1]], cached[2]

def load_campuses():
	names = {}
	try:
		with open(CAMPUSES_PATH, "r") as f:
			for campus in json.load(f).get("data", []):
				names[campus["id"]] = campus
	except Exception:
		pass
	result = []
	for campus_id in available_campus_ids():
		campus = names.get(campus_id, {})
		result.append({
			"id": campus_id,
			"name": campus.get("name", f"Campus {campus_id}"),
			"country": campus.get("country"),
		})
	return result

def parse_campus_id(value):
	try:
		return int(str(value))
	except (TypeError, ValueError):
		return None

@app.route("/api/students")
def StudentsAPI():
	path, _ = resolve_students_file(parse_campus_id(request.args.get('campus_id')))
	if not path:
		return []
	try:
		return load_students_file(path)[0]
	except Exception as e:
		logging.exception(e)
		return []

@app.route("/api/students/keys")
def StudentsKeysAPI():
	return students_keys(StudentsAPI())

def students_keys(students, sample_size=500):
	if not students:
		return []

	field_types = defaultdict(set)
	field_nullable = defaultdict(lambda: False)

	for student in students[:sample_size]:
		flat = flatten_keys(student)
		for key, typ in flat.items():
			if typ == "null":
				field_nullable[key] = True
			else:
				field_types[key].add(typ)
		# Mark missing keys as nullable
		seen_keys = set(flat.keys())
		all_keys_so_far = set(field_types.keys())
		for key in all_keys_so_far - seen_keys:
			field_nullable[key] = True

	result = []
	for key in sorted(set(field_types.keys()) | set(field_nullable.keys())):
		types = sorted(field_types[key]) or ["null"]
		result.append({
			"name": key,
			"type": types[0] if len(types) == 1 else "|".join(types),
			"nullable": field_nullable[key],
			"description": None
		})

	return result


#------------------------------------------------------------------------------
# JSON KEYS RETRIEVAL


def infer_type(value):
	if isinstance(value, bool):
		return "boolean"
	elif isinstance(value, numbers.Number):
		return "number"
	elif isinstance(value, dict):
		return "object"
	elif isinstance(value, list):
		return "array"
	elif value is None:
		return "null"
	else:
		return "string"

def flatten_keys(obj, parent_key=""):
	items = {}
	if isinstance(obj, dict):
		for k, v in obj.items():
			new_key = f"{parent_key}.{k}" if parent_key else k
			if isinstance(v, dict):
				items.update(flatten_keys(v, new_key))
			elif isinstance(v, list):
				# If list, flatten first non-null item
				if v:
					# Try multiple entries to get consistent shape
					for i in v:
						if isinstance(i, dict):
							items.update(flatten_keys(i, new_key))
							#break
					#else:
					#	items[new_key] = infer_type(v)
				else:
					items[new_key] = "array"
			else:
				items[new_key] = infer_type(v)
	else:
		items[parent_key] = infer_type(obj)
	return items

#------------------------------------------------------------------------------
# FETCH STUDENT DATA

def is_exam(entry):
	return 'exam' in ((entry.get('project') or {}).get('slug') or '').lower()

API_SERVER_RETRIES = 5

def short_api_error(e):
	"""API42 errors carry the whole response body: keep an HTML error page down to its <title>."""
	msg = str(e)
	if "<html" in msg.lower():
		title = re.search(r"<title>(.*?)</title>", msg, re.I | re.S)
		msg = msg[:msg.find("<")].strip() + (f" ({title.group(1).strip()})" if title else "")
	return msg[:300]

def is_transient_api_error(e):
	"""5xx answers and network errors from the 42 API usually go away when retried."""
	return isinstance(e, requests.RequestException) or bool(re.match(r"Error: 5\d\d\b", str(e)))

def getStudData(user, idx = -1):
	"""Fetches the full profile of a student, or returns None if the 42 API fails."""
	attempt = 0
	while True:
		try:
			_ = API.getUserByID(user["id"])
			break
		except Exception as e:
			if is_transient_api_error(e) and attempt < API_SERVER_RETRIES:
				attempt += 1
				logging.warning(f'Retry {attempt}/{API_SERVER_RETRIES} for {user["id"]=}\t{user["login"]=}: {short_api_error(e)}')
				time.sleep(2 ** attempt)
				continue
			logging.warning(f'Failed to fetch user data for {user["id"]=}\t{user["login"]=}: {short_api_error(e)}')
			return None
	if (not _):
		return None
	_['failedFetchExams'] = False
	_['all_projects'] = [i for i in _.get('projects_users', []) if 'project' in i and 'slug' in i['project']]
	print(f'parsed-[{idx}]\t{user["id"]=}\t{user["login"]=}\t{len(_.get("all_projects", []))=}')
	return _

#-------------------------------------------------------------------------------
# CACHING FUNCTIONS

_user_cache_memo = (None, {})

def load_user_cache():
	"""The user cache, parsed again only when its file changes. Callers must not modify the entries."""
	global _user_cache_memo
	if not os.path.exists(USER_CACHE_PATH):
		return {}
	try:
		mtime = os.path.getmtime(USER_CACHE_PATH)
		if _user_cache_memo[0] != mtime:
			with open(USER_CACHE_PATH, 'r') as f:
				_user_cache_memo = (mtime, json.load(f))
		return dict(_user_cache_memo[1])
	except Exception as e:
		logging.exception(f"Failed to load user cache: {e}")
		return {}

_cache_freshness = (None, {})

def cached_user_timestamps():
	"""{user_id: lastSave} of the user cache, reloaded only when the file changes."""
	global _cache_freshness
	if not os.path.exists(USER_CACHE_PATH):
		return {}
	mtime = os.path.getmtime(USER_CACHE_PATH)
	if _cache_freshness[0] != mtime:
		_cache_freshness = (mtime, {k: v.get('lastSave') for k, v in load_user_cache().items()})
	return _cache_freshness[1]

def save_user_cache(cache):
	try:
		# atomic: searches read the cache while background jobs write it
		write_json_atomic(USER_CACHE_PATH, cache)
	except Exception as e:
		logging.exception(f"Failed to save user cache: {e}")

def is_cache_expired(timestamp_str):
	try:
		last_saved = float(timestamp_str)
		age_hours = (time.time() - last_saved) / (60 * 60)
		return age_hours > CACHE_EXPIRATION_HOURS
	except:
		return True

# Which cached profiles get fetched again (cached profiles are never dropped):
#   missing  - only the profiles never fetched
#   outdated - also the ones older than CACHE_EXPIRATION_HOURS
#   all      - every profile, however recent (forced rescan)
FETCH_MODES = ("missing", "outdated", "all")

def needs_fetch(timestamp_str, mode="missing"):
	if timestamp_str is None or mode == "all":
		return True
	return mode == "outdated" and is_cache_expired(timestamp_str)

def fetch_mode(force):
	return "all" if force else "outdated"

def cache_counts(ids, timestamps):
	"""(cached, outdated) among `ids`: cached profiles of any age, and those older than CACHE_EXPIRATION_HOURS."""
	cached = outdated = 0
	for i in ids:
		ts = timestamps.get(str(i))
		if ts is None:
			continue
		cached += 1
		if is_cache_expired(ts):
			outdated += 1
	return cached, outdated

CACHE_LOCK = threading.Lock()

def merge_into_user_cache(entries):
	"""Adds fetched profiles to the cache file without losing entries written meanwhile."""
	if not entries:
		return
	with CACHE_LOCK:
		cache = load_user_cache()
		cache.update(entries)
		save_user_cache(cache)
		print(f'Cache updated. Size: {len(cache)}')

def fetch_profile(user, idx=-1):
	"""Fetched profile stamped with its fetch time, or None if fetching failed (nothing to cache)."""
	fetched_user = getStudData(user, idx)
	if fetched_user is None:
		return None
	fetched_user['lastSave'] = str(time.time())
	return fetched_user

# Progress of the search currently fetching from the 42 API (polled by the page while it waits).
# `phase` is 'students' while the student list is fetched again, then 'profiles'.
SCAN_PROGRESS = {"active": False, "phase": None, "done": 0, "total": 0, "failed": 0, "startedAt": None}

def invalidateCache(filteredList: "list"=[], mode="missing"):
	"""Full profiles of `filteredList`: cached ones as they are, the ones `mode` selects fetched again."""
	cache = load_user_cache()
	stale = {str(u['id']) for u in filteredList if needs_fetch((cache.get(str(u['id'])) or {}).get('lastSave'), mode)}
	SCAN_PROGRESS.update(active=bool(stale), phase="profiles", done=0, total=len(stale), failed=0, startedAt=time.time())
	pending = {}

	result = []

	try:
		for idx, user in enumerate(filteredList):
			user_id = str(user['id'])
			if user_id in stale:
				fetched_user = fetch_profile(user, idx)
				SCAN_PROGRESS["done"] += 1
				if fetched_user is None:
					SCAN_PROGRESS["failed"] += 1
					# keep the old profile if there is one, never overwrite it with a failure
					old = cache.get(user_id)
					result.append(dict(old) if old else {**user, 'failedFetchExams': True})
					continue
				pending[user_id] = fetched_user
				result.append(dict(fetched_user))
				# save as we go: an interrupted scan keeps what it fetched
				if len(pending) >= 25:
					merge_into_user_cache(pending)
					pending = {}
			else:
				result.append(dict(cache[user_id]))
	finally:
		merge_into_user_cache(pending)
		SCAN_PROGRESS["active"] = False
	return result

#-------------------------------------------------------------------------------


def nested(obj: object, attr_path: str, first=False, flatten=True, as_set=False):
	parts = attr_path.split(".")

	def parse_key(part):
		"""Handles list indices like 'key[0]' or just 'key'"""
		match = re.match(r"(\w+\??)(?:\[(\d+)\])?$", part)
		if not match:
			return part, None
		key, idx = match.groups()
		return key, int(idx) if idx is not None else None

	def _extract(current, keys):
		if not keys:
			return current

		key_part = keys[0]
		rest = keys[1:]
		key, idx = parse_key(key_part)

		if isinstance(current, dict):
			if key not in current:
				return None
			next_item = current[key]
			if idx is not None:
				if isinstance(next_item, list) and 0 <= idx < len(next_item):
					return _extract(next_item[idx], rest)
				return None
			return _extract(next_item, rest)

		elif isinstance(current, list):
			results = [_extract(item, keys) for item in current]
			if flatten:
				flattened = []
				for r in results:
					if isinstance(r, list):
						flattened.extend(r)
					elif r is not None:
						flattened.append(r)
				return flattened if flattened else None
			else:
				return results

		return None

	result = _extract(obj, parts)

	if first:
		if isinstance(result, list):
			return result[0] if result else None
	if as_set and isinstance(result, list):
		return list(set(result))
	return result


def to_number(value):
	if isinstance(value, bool):
		return None
	if isinstance(value, numbers.Number):
		return float(value)
	try:
		return float(str(value).strip())
	except (TypeError, ValueError):
		return None

def normalize(value):
	if value is None:
		return ""
	if isinstance(value, bool):
		return "true" if value else "false"
	return str(value)

COMPARATORS = {
	">=": lambda a, b: a >= b,
	"<=": lambda a, b: a <= b,
	"==": lambda a, b: a == b,
	"!=": lambda a, b: a != b,
	">": lambda a, b: a > b,
	"<": lambda a, b: a < b,
}

def split_condition(condition):
	condition = str(condition)
	for op in COMPARATORS:  # two-char operators are listed first
		if condition.startswith(op):
			return op, condition[len(op):]
	return None, condition

def conditional(value, condition):
	"""Checks `value` against `condition` ('>=80', '==kind', '!=x', 'substring').

	Numbers are compared numerically, text case-insensitively. For list values the
	condition must hold for any element (for every element with '!=')."""
	op, expected = split_condition(condition)
	if isinstance(value, list):
		if not value:
			value = [None]
		if op == "!=":
			return all(conditional(v, condition) for v in value)
		return any(conditional(v, condition) for v in value)

	if op is None:
		return expected.lower() in normalize(value).lower()

	left, right = to_number(value), to_number(expected)
	if left is not None and right is not None:
		return COMPARATORS[op](left, right)
	if op in ("==", "!="):
		return COMPARATORS[op](normalize(value).lower(), expected.lower())
	if value is None or expected == "":
		return False
	return COMPARATORS[op](normalize(value).lower(), expected.lower())

def is_truthy(value):
	return str(value).lower() not in ("", "0", "false", "no", "off")

def get_average_final_mark(entries):
	marks = [e['final_mark'] for e in entries if isinstance(e.get('final_mark'), numbers.Number)]
	if not marks:
		return None
	return round(sum(marks) / len(marks), 2)

def get_level(user):
	cursus_users = user.get('cursus_users') or []
	main = next((c for c in cursus_users if (c.get('cursus') or {}).get('slug') == '42cursus'), None)
	if main is not None:
		return main.get('level')
	levels = [c.get('level') for c in cursus_users if isinstance(c.get('level'), numbers.Number)]
	return max(levels) if levels else None

# The 42 API ids/slugs of the main curriculum and of the C Piscine
CADET_CURSUS = {21: "42cursus", 1: "42"}
CPISCINE_CURSUS = {9: "c-piscine"}

def cursus_slugs(user):
	slugs = []
	for c in user.get('cursus_users') or []:
		cursus = c.get('cursus') or {}
		slug = cursus.get('slug') or CADET_CURSUS.get(c.get('cursus_id')) or CPISCINE_CURSUS.get(c.get('cursus_id'))
		if slug:
			slugs.append(slug)
	return slugs

def upcoming_cadet_start(user):
	"""Start date of the main curriculum when every enrollment in it begins in the future (common core not started yet), else None."""
	now = datetime.now(timezone.utc).isoformat()
	begins = [c.get('begin_at') or '' for c in user.get('cursus_users') or []
		if ((c.get('cursus') or {}).get('slug') or CADET_CURSUS.get(c.get('cursus_id'))) in CADET_CURSUS.values()]
	if begins and all(b > now for b in begins):
		return min(begins)
	return None

def get_stage(slugs, upcoming=False):
	"""'upcoming' if subscribed to a main curriculum not started yet, 'cadet' if in it, 'pisciner' if the C Piscine is the only cursus, else 'other'."""
	if not slugs:
		return None
	if upcoming:
		return "upcoming"
	if any(s in CADET_CURSUS.values() for s in slugs):
		return "cadet"
	if all(s in CPISCINE_CURSUS.values() for s in slugs):
		return "pisciner"
	return "other"

def sort_by(users: list, sortBy: str, reverse: bool = False):
	def safe_sort_key(user):
		value = nested(user, sortBy)
		if isinstance(value, list):
			value = value[0] if value else None
		if value is None:
			return (0, 0, 0)
		number = to_number(value)
		if number is not None:
			return (1, 0, number)
		return (1, 1, normalize(value).lower())
	# missing values always go last
	present = [u for u in users if safe_sort_key(u)[0] == 1]
	missing = [u for u in users if safe_sort_key(u)[0] == 0]
	return sorted(present, key=safe_sort_key, reverse=reverse) + missing

#-------------------------------------------------------------------------------
# EXAM / PROJECT CRITERIA

def entry_criteria(args, prefix, name_param):
	names = [n.strip().lower() for n in args.get(name_param, "").split("|") if n.strip()]
	criteria = {
		"names": names,
		"mark": args.get(f"{prefix}_mark", ""),
		"status": args.get(f"{prefix}_status", ""),
		"validated": args.get(f"{prefix}_validated", ""),
	}
	# Any criteria besides the name narrows the students too
	required_param = f"{prefix}_required"
	criteria["required"] = (required_param in args and is_truthy(args.get(required_param) or "true")) or any(
		criteria[k] for k in ("mark", "status", "validated"))
	return criteria

def match_entries(entries, criteria):
	result = []
	for entry in entries:
		project = entry.get('project') or {}
		if criteria["names"]:
			name = (project.get('name') or '').lower()
			slug = (project.get('slug') or '').lower()
			if not any(n in name or n in slug for n in criteria["names"]):
				continue
		if criteria["mark"] and not conditional(entry.get('final_mark'), criteria["mark"]):
			continue
		if criteria["status"] and not conditional(entry.get('status'), criteria["status"]):
			continue
		if criteria["validated"] and not conditional(entry.get('validated?'), criteria["validated"]):
			continue
		result.append(entry)
	return result

def parse_iso(value):
	try:
		return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
	except (TypeError, ValueError):
		return None

CURSUS_PROGRESS_FIELDS = ("cursus_status", "cursus_end")

def cursus_progress(user):
	"""Status in the main curriculum: 'upcoming', 'active', 'blackholed' (cursus ended at the blackhole date), 'left' or 'graduated'.

	The API's blackhole date outlives the old rules (the intra now uses milestones), so only a cursus that
	actually ended near that date counts as absorbed. `cursus_end` is the day it ended."""
	result = dict.fromkeys(CURSUS_PROGRESS_FIELDS)
	entries = [c for c in user.get('cursus_users') or []
		if ((c.get('cursus') or {}).get('slug') or CADET_CURSUS.get(c.get('cursus_id'))) in CADET_CURSUS.values()]
	if not entries:
		return result
	mc = max(entries, key=lambda c: c.get('begin_at') or '')
	now = datetime.now(timezone.utc)
	begin, end, bh = parse_iso(mc.get('begin_at')), parse_iso(mc.get('end_at')), parse_iso(mc.get('blackholed_at'))
	if begin is None or begin > now:
		result['cursus_status'] = 'upcoming'
	elif end and end <= now:
		result['cursus_status'] = 'blackholed' if bh and abs((end - bh).days) <= 10 else 'left'
		result['cursus_end'] = end.date().isoformat()
	elif user.get('alumni?'):
		result['cursus_status'] = 'graduated'
	else:
		result['cursus_status'] = 'active'
	return result
def enrich(user, exam_criteria, project_criteria):
	all_projects = user.get('all_projects') or []
	exams = [e for e in all_projects if is_exam(e)]
	projects = [e for e in all_projects if not is_exam(e)]
	user['exams'] = match_entries(exams, exam_criteria)
	user['projects'] = match_entries(projects, project_criteria)
	user['average_exam_final_mark'] = get_average_final_mark(user['exams'])
	user['average_project_final_mark'] = get_average_final_mark(user['projects'])
	user['average_mark'] = get_average_final_mark(all_projects)
	cpiscine_exam = next((e for e in all_projects if (e.get('project') or {}).get('name') == CPISCINE_FINAL_EXAM_NAME), None)
	user['cpiscine_final_mark'] = cpiscine_exam.get('final_mark') if cpiscine_exam else None
	user['level'] = get_level(user)
	slugs = cursus_slugs(user)
	user['cursus'] = slugs or None
	user['cursus_start'] = upcoming_cadet_start(user)
	user['stage'] = get_stage(slugs, user['cursus_start'] is not None)
	user.update(cursus_progress(user))
	user['exams_passed'] = sum(1 for e in exams if e.get('validated?')) if all_projects else None
	user['projects_passed'] = sum(1 for e in projects if e.get('validated?')) if all_projects else None

ENTRY_KEYS = ("id", "final_mark", "status", "validated?", "occurrence", "cursus_ids", "marked_at", "created_at", "updated_at", "current_team_id")

def slim_entry(entry):
	"""The fields of an exam/project attempt the page uses."""
	slim = {k: entry[k] for k in ENTRY_KEYS if k in entry}
	project = entry.get('project') or {}
	slim['project'] = {k: project.get(k) for k in ('id', 'name', 'slug', 'parent_id')}
	return slim

def client_payload(user):
	"""Removes duplicated lists: the client rebuilds them from `all_projects`."""
	payload = {k: v for k, v in user.items() if k not in ('projects_users', 'exams', 'projects')}
	if 'all_projects' in payload:
		payload['all_projects'] = [slim_entry(e) for e in payload['all_projects']]
	if payload.get('cursus_users'):
		# each cursus repeats the whole user
		payload['cursus_users'] = [{k: v for k, v in c.items() if k != 'user'} for c in payload['cursus_users']]
	payload['matched_exams'] = [e.get('id') for e in user.get('exams', [])]
	payload['matched_projects'] = [e.get('id') for e in user.get('projects', [])]
	return payload

#-------------------------------------------------------------------------------
# SEARCH

def rescan_targets(args):
	"""{'students', 'profiles'} requested with `rescan` ('1'/'true' alone means the profiles)."""
	raw = str(args.get("rescan") or "").lower()
	if not raw or not is_truthy(raw):
		return set()
	targets = {t.strip() for t in raw.split(",")} & {"students", "profiles"}
	return targets or {"profiles"}

def rescan_student_list(campus_id, force):
	"""Fetches the campus student list again for a search, reporting progress like a full scan."""
	SCAN_PROGRESS.update(active=True, phase="students", done=0, total=0, failed=0, startedAt=time.time())
	def progress(done, total):
		SCAN_PROGRESS.update(done=done, total=total or done)
	try:
		return fetch_campus_students(campus_id, progress, force=force)
	finally:
		SCAN_PROGRESS["active"] = False

def search(args):
	campus_id = parse_campus_id(args.get('campus_id'))
	path, resolved_campus = resolve_students_file(campus_id)
	rescan = rescan_targets(args)
	force = "force" in args and is_truthy(args.get("force") or "true")
	rescanned = {}
	if "students" in rescan:
		target = resolved_campus if resolved_campus is not None else campus_id
		if target is None:
			rescanned["studentsError"] = "The default students.json has no campus to fetch again"
		else:
			try:
				rescanned["students"] = rescan_student_list(target, force)
			except Exception as e:
				logging.exception(e)
				rescanned["studentsError"] = str(e)
			path, resolved_campus = resolve_students_file(campus_id)
	meta = {
		"campusId": resolved_campus,
		"requestedCampusId": campus_id,
		"file": os.path.relpath(path, ROOT_DIR) if path else None,
		"campuses": load_campuses(),
		"defaultCampus": load_config().get("defaultCampus"),
		"hasDefaultFile": os.path.exists(DEFAULT_STUDENTS_PATH),
		"fullscan": args.get("fullscan") is not None and is_truthy(args.get("fullscan") or "true"),
		"customFilters": CUSTOM_FILTERS,
		"derivedFields": DERIVED_FIELDS,
		"total": 0,
		"count": 0,
		"fields": [],
		"basicFields": [],
		"unknownKeys": [],
		"needsFullscan": [],
		"cachedCount": 0,
		"outdatedCount": 0,
		"cacheHours": CACHE_EXPIRATION_HOURS,
		"jobsActive": bool(JOBS["current"] or JOBS["queue"]),
		"studentsFetchedAt": os.path.getmtime(path) if path else None,
		"rescanned": rescanned or None,
		"error": None,
	}
	if not path:
		meta["error"] = "missing_data"
		return meta, []
	try:
		students, basic_keys = load_students_file(path)
	except Exception as e:
		logging.exception(e)
		meta["error"] = "invalid_data"
		return meta, []
	meta["total"] = len(students)
	meta["basicFields"] = sorted(basic_keys)

	pending = {k: v for k, v in args.items() if k not in CUSTOM_FILTER_NAMES and v != ''}

	# 1. Basic filters, before the (slow) fullscan
	filtered = students
	for arg, val in list(pending.items()):
		if arg in basic_keys:
			filtered = [stud for stud in filtered if conditional(nested(stud, arg, as_set=True), val)]
			del pending[arg]

	exam_criteria = entry_criteria(args, "exam", "examname")
	project_criteria = entry_criteria(args, "project", "projectname")

	timestamps = cached_user_timestamps()
	meta["cachedCount"], meta["outdatedCount"] = cache_counts((u.get('id') for u in filtered), timestamps)
	meta["fetching"] = meta["fullscan"]

	# 2. Profiles: fullscan fetches the missing ones; otherwise the cached ones are shown, whatever their age
	if meta["fetching"]:
		mode = fetch_mode(force) if "profiles" in rescan else "missing"
		filtered = invalidateCache(filteredList=filtered, mode=mode)
		if "profiles" in rescan:
			rescanned["profiles"] = {"fetched": SCAN_PROGRESS["total"] - SCAN_PROGRESS["failed"], "failed": SCAN_PROGRESS["failed"], "mode": mode}
	elif meta["cachedCount"]:
		cache = load_user_cache()
		filtered = [dict(cache[str(u['id'])]) if str(u['id']) in cache else u for u in filtered]

	for user in filtered:
		enrich(user, exam_criteria, project_criteria)

	# the client shows profile data (levels, exams, projects...) as soon as some profiles exist
	profiled = [u for u in filtered if 'all_projects' in u]
	meta["fullscan"] = meta["fetching"] or bool(profiled)
	meta["unfetchedCount"] = len(filtered) - len(profiled)

	# 3. Filters on fetched or computed fields (students without a profile can't match them)
	needs = {k for k in args if args.get(k) and re.match(r"(exam|project)_", k)}
	needs |= {k for k in pending if k in DERIVED_FIELD_NAMES}
	if meta["fullscan"]:
		fetched_keys = profile_keys(profiled)[0]
		for arg, val in list(pending.items()):
			if arg in fetched_keys:
				filtered = [stud for stud in filtered if conditional(nested(stud, arg, as_set=True), val)]
				del pending[arg]
		if exam_criteria["required"]:
			filtered = [u for u in filtered if u['exams']]
		if project_criteria["required"]:
			filtered = [u for u in filtered if u['projects']]
		if needs and not meta["fetching"]:
			meta["unfetchedExcluded"] = meta["unfetchedCount"]
	else:
		meta["needsFullscan"] = sorted(needs)
		for k in needs:
			pending.pop(k, None)

	sortBy = args.get("sortby")
	if sortBy:
		filtered = sort_by(filtered, sortBy, reverse=args.get("order") == "desc")

	meta["rescanned"] = rescanned or None
	meta["unknownKeys"] = sorted(pending.keys())
	meta["count"] = len(filtered)
	meta["fields"] = profile_keys(profiled)[1] if meta["fullscan"] else students_keys(students)
	return meta, [client_payload(u) for u in filtered]

_profile_keys_memo = {}

def profile_keys(profiled):
	"""(field names, field descriptions) of the fetched profiles, inferred from a sample once per cache change."""
	key = (USER_CACHE_PATH, os.path.exists(USER_CACHE_PATH) and os.path.getmtime(USER_CACHE_PATH))
	if key not in _profile_keys_memo:
		sample = profiled[:200]
		names = set(DERIVED_FIELD_NAMES)
		for user in sample:
			names.update(flatten_keys(user).keys())
		_profile_keys_memo.clear()
		_profile_keys_memo[key] = (names, students_keys(sample))
	return _profile_keys_memo[key]

LAZY_LOCK = threading.Lock()
LAZY_BATCH = 12

@app.route("/api/profiles/fetch", methods=["POST"])
def FetchProfilesAPI():
	"""Fetches the profiles of a few students the page is showing (never fetched ones only) and returns them."""
	ids = [str(i) for i in ((request.get_json(silent=True) or {}).get("ids") or []) if str(i).isdigit()][:LAZY_BATCH]
	if not LAZY_LOCK.acquire(blocking=False):
		return jsonify({"busy": True, "profiles": {}, "failed": []})
	try:
		cache = load_user_cache()
		fetched, failed = {}, []
		for i in ids:
			if i in cache:
				continue
			profile = fetch_profile({"id": int(i), "login": i})
			if profile is None:
				failed.append(i)
			else:
				fetched[i] = profile
		merge_into_user_cache(fetched)
		payload = {}
		for i, profile in fetched.items():
			enrich(profile, entry_criteria({}, "exam", "examname"), entry_criteria({}, "project", "projectname"))
			payload[i] = client_payload(profile)
		return jsonify({"busy": False, "profiles": payload, "failed": failed})
	finally:
		LAZY_LOCK.release()

@app.route("/api/search")
def SearchAPI():
	meta, students = search(request.args)
	body = json.dumps({"meta": meta, "students": students}, separators=(",", ":"), default=str).encode()
	response = Response(mimetype="application/json")
	if "gzip" in request.headers.get("Accept-Encoding", ""):
		body = gzip.compress(body, 3)
		response.headers["Content-Encoding"] = "gzip"
	response.set_data(body)
	return response

#-------------------------------------------------------------------------------
# CAMPUSES: catalog, local files and background fetch jobs

def load_campus_catalog():
	try:
		with open(CAMPUSES_PATH, "r") as f:
			data = json.load(f)
		return data.get("data", []), data.get("lastFetch")
	except Exception:
		return [], None

_count_cache = {}

def campus_file_info(campus_id):
	path = campus_students_path(campus_id)
	if not os.path.exists(path):
		return None
	mtime = os.path.getmtime(path)
	cached = _count_cache.get(path)
	if not cached or cached[0] != mtime:
		try:
			with open(path, "r") as f:
				ids = [str(u.get("id")) for u in json.load(f)]
		except Exception:
			ids = []
		cached = (mtime, ids)
		_count_cache[path] = cached
	ids = cached[1]
	detailed, outdated = cache_counts(ids, cached_user_timestamps())
	return {"count": len(ids), "fetchedAt": mtime, "outdatedList": is_cache_expired(mtime), "detailed": detailed, "outdated": outdated}

def campuses_overview():
	catalog, catalog_fetched_at = load_campus_catalog()
	default_campus = load_config().get("defaultCampus")
	by_id = {c["id"]: c for c in catalog}
	ids = sorted(set(by_id) | set(available_campus_ids()))
	result = []
	for campus_id in ids:
		campus = by_id.get(campus_id, {})
		result.append({
			"id": campus_id,
			"name": campus.get("name", f"Campus {campus_id}"),
			"city": campus.get("city"),
			"country": campus.get("country"),
			"usersCount": campus.get("users_count"),
			"active": campus.get("active", True),
			"local": campus_file_info(campus_id),
			"isDefault": campus_id == default_campus,
		})
	return {"campuses": result, "catalogFetchedAt": catalog_fetched_at, "cacheHours": CACHE_EXPIRATION_HOURS}

def api_paginated(path, on_page=None):
	"""GETs every page of a 42 API listing (rate-limit aware, keeps pages already fetched)."""
	data = []
	page = 1
	auth_retries = 0
	# 5xx and network errors are usually transient on the 42 API: retry a page a few times
	server_retries = 0
	while True:
		try:
			r = API.session.get(f"{API.api_url}{path}", params={"per_page": 100, "page": page}, timeout=60)
		except requests.RequestException as e:
			if server_retries < API_SERVER_RETRIES:
				server_retries += 1
				logging.warning("42 API request failed (%s), retry %d/%d", e, server_retries, API_SERVER_RETRIES)
				time.sleep(2 ** server_retries)
				continue
			raise RuntimeError(f"42 API unreachable: {e}") from e
		if r.status_code == 429:
			time.sleep(1)
			continue
		if r.status_code == 401 and auth_retries < 2:
			auth_retries += 1
			API.session.headers.update(API._Api42__getTokenHeader())
			continue
		if r.status_code >= 500 and server_retries < API_SERVER_RETRIES:
			server_retries += 1
			logging.warning("42 API responded %d on %s page %d, retry %d/%d", r.status_code, path, page, server_retries, API_SERVER_RETRIES)
			time.sleep(2 ** server_retries)
			continue
		if r.status_code != 200:
			body = "" if r.text.lstrip().startswith("<") else f": {r.text[:200]}"
			raise RuntimeError(f"42 API responded {r.status_code} on {path} page {page}{body}")
		auth_retries = 0
		server_retries = 0
		items = r.json()
		data += items
		if on_page:
			total = r.headers.get("X-Total")
			on_page(len(data), int(total) if total and total.isdigit() else None)
		if len(items) < 100:
			return data
		page += 1

JOBS_LOCK = threading.Lock()
JOBS = {"current": None, "queue": [], "history": []}
_job_counter = 0
_job_worker = None

def write_json_atomic(path, data, **kwargs):
	tmp = path + ".tmp"
	with open(tmp, "w") as f:
		json.dump(data, f, **kwargs)
	os.replace(tmp, path)

# Only what the campus manager needs from the campus list
CAMPUS_FIELDS = ("id", "name", "city", "country", "users_count", "active", "public")

class JobCancelled(Exception):
	pass

def merge_students(new, old):
	"""The fetched student list, plus the old records the 42 API no longer returns (never dropped)."""
	fetched_ids = {u.get("id") for u in new}
	return new + [u for u in old if u.get("id") not in fetched_ids]

def student_list_outdated(campus_id):
	path = campus_students_path(campus_id)
	return not os.path.exists(path) or is_cache_expired(os.path.getmtime(path))

def fetch_campus_students(campus_id, progress, force=True):
	"""Fetches the student list of a campus and merges it into its file.

	Without `force`, a list fetched less than CACHE_EXPIRATION_HOURS ago is kept as it is.
	Returns {count, kept, skipped}: students fetched, older ones kept, and whether nothing was fetched."""
	path = campus_students_path(campus_id)
	old = []
	if os.path.exists(path):
		try:
			old = load_students_file(path)[0]
		except Exception as e:
			logging.exception(e)
	if not force and old and not student_list_outdated(campus_id):
		return {"count": len(old), "kept": 0, "skipped": True}
	users = api_paginated(f"/campus/{campus_id}/users", progress)
	merged = merge_students(users, old)
	write_json_atomic(path, merged, indent=2)
	return {"count": len(users), "kept": len(merged) - len(users), "skipped": False}

def fetch_campus_details(job, progress):
	"""Fetches the full profiles of a campus's students (same cache as fullscan).

	The missing and outdated profiles are fetched; with `force`, every profile is fetched again."""
	path = campus_students_path(job["campusId"])
	if not os.path.exists(path):
		raise RuntimeError("Fetch the students of this campus first")
	students, _ = load_students_file(path)
	timestamps = cached_user_timestamps()
	mode = fetch_mode(job.get("force"))
	todo = [u for u in students if needs_fetch(timestamps.get(str(u.get("id"))), mode)]
	job["skipped"] = len(students) - len(todo)
	job["failed"] = 0
	progress(0, len(todo))
	pending = {}
	try:
		for idx, user in enumerate(todo):
			if job.get("cancel"):
				raise JobCancelled()
			fetched = fetch_profile(user, idx)
			if fetched is None:
				job["failed"] += 1
			else:
				pending[str(user["id"])] = fetched
			progress(idx + 1, len(todo))
			if len(pending) >= 25:
				merge_into_user_cache(pending)
				pending = {}
	finally:
		# keep whatever was fetched, even when cancelled or failing midway
		merge_into_user_cache(pending)
	job["fetched"] = len(todo) - job["failed"]

def run_job(job):
	def progress(done, total):
		with JOBS_LOCK:
			job["done"] = done
			job["total"] = total
	if job["type"] == "campus":
		job.update(fetch_campus_students(job["campusId"], progress, force=job.get("force", True)))
	elif job["type"] == "catalog":
		campuses = api_paginated("/campus", progress)
		slim = [{k: c.get(k) for k in CAMPUS_FIELDS} for c in campuses]
		write_json_atomic(CAMPUSES_PATH, {"lastFetch": time.time(), "data": slim}, indent=2)
		job["count"] = len(slim)
	elif job["type"] == "details":
		fetch_campus_details(job, progress)

def job_worker():
	global _job_worker
	while True:
		with JOBS_LOCK:
			if not JOBS["queue"]:
				JOBS["current"] = None
				_job_worker = None
				return
			job = JOBS["queue"].pop(0)
			job.update(status="running", startedAt=time.time())
			JOBS["current"] = job
		try:
			run_job(job)
			job["status"] = "done"
		except JobCancelled:
			job["status"] = "cancelled"
		except Exception as e:
			logging.exception(e)
			job.update(status="error", error=str(e))
		job["finishedAt"] = time.time()
		with JOBS_LOCK:
			JOBS["current"] = None
			JOBS["history"] = [job] + JOBS["history"][:29]

def enqueue_jobs(new_jobs):
	global _job_counter, _job_worker
	with JOBS_LOCK:
		pending = [j for j in JOBS["queue"] + ([JOBS["current"]] if JOBS["current"] else [])]
		for job in new_jobs:
			if any(j["type"] == job["type"] and j.get("campusId") == job.get("campusId") for j in pending):
				continue
			_job_counter += 1
			job.update(id=_job_counter, status="queued", queuedAt=time.time(), done=0, total=None)
			JOBS["queue"].append(job)
		if _job_worker is None and JOBS["queue"]:
			_job_worker = threading.Thread(target=job_worker, daemon=True)
			_job_worker.start()

def jobs_snapshot():
	with JOBS_LOCK:
		return json.loads(json.dumps(JOBS))

@app.route("/api/campuses")
def CampusesAPI():
	return jsonify({**campuses_overview(), "jobs": jobs_snapshot()})

@app.route("/api/scan")
def ScanProgressAPI():
	return jsonify(SCAN_PROGRESS)

@app.route("/api/jobs")
def JobsAPI():
	return jsonify(jobs_snapshot())

@app.route("/api/campuses/fetch", methods=["POST"])
def FetchCampusesAPI():
	"""Queues fetches for campuses: `what` is 'students', 'details' or 'both'.

	Without `force`, only what is missing or older than CACHE_EXPIRATION_HOURS is fetched;
	with it, the student list and every profile are fetched again. Details of a campus
	without a student list fetch the list first."""
	body = request.get_json(silent=True) or {}
	names = {c["id"]: c["name"] for c in campuses_overview()["campuses"]}
	ids = [parse_campus_id(i) for i in body.get("ids", [])]
	ids = [i for i in ids if i is not None]
	if not ids:
		return jsonify({"error": "No campus selected"}), 400
	what = body.get("what") or "students"
	if what == "rescan":
		what = "both"
	if what not in ("students", "details", "both"):
		return jsonify({"error": f"Unknown fetch '{what}'"}), 400
	force = bool(body.get("force"))
	jobs = []
	for i in ids:
		base = {"campusId": i, "name": names.get(i, f"Campus {i}"), "force": force}
		has_list = os.path.exists(campus_students_path(i))
		if what in ("students", "both") or not has_list:
			jobs.append({**base, "type": "campus"})
		if what in ("details", "both"):
			jobs.append({**base, "type": "details"})
	enqueue_jobs(jobs)
	return jsonify(jobs_snapshot())

@app.route("/api/students/<int:user_id>/refresh", methods=["POST"])
def RefreshStudentAPI(user_id):
	"""Fetches one student's profile again, whatever its age."""
	fetched = fetch_profile({"id": user_id, "login": str(user_id)})
	if fetched is None:
		return jsonify({"error": "The 42 API didn't return this profile"}), 502
	merge_into_user_cache({str(user_id): fetched})
	return jsonify({"lastSave": fetched["lastSave"]})

@app.route("/api/jobs/cancel", methods=["POST"])
def CancelJobAPI():
	job_id = (request.get_json(silent=True) or {}).get("id")
	with JOBS_LOCK:
		for job in list(JOBS["queue"]):
			if job["id"] == job_id:
				JOBS["queue"].remove(job)
				job.update(status="cancelled", finishedAt=time.time())
				JOBS["history"] = [job] + JOBS["history"][:29]
		if JOBS["current"] and JOBS["current"]["id"] == job_id:
			JOBS["current"]["cancel"] = True
	return jsonify(jobs_snapshot())

@app.route("/api/campuses/catalog", methods=["POST"])
def RefreshCatalogAPI():
	enqueue_jobs([{"type": "catalog", "name": "Campus list"}])
	return jsonify(jobs_snapshot())

@app.route("/api/campuses/default", methods=["POST"])
def DefaultCampusAPI():
	campus_id = parse_campus_id((request.get_json(silent=True) or {}).get("id"))
	if campus_id is None:
		return jsonify({"error": "Invalid campus"}), 400
	config = load_config()
	config["defaultCampus"] = campus_id
	write_json_atomic(CONFIG_PATH, config, indent=2)
	return jsonify(campuses_overview())

@app.route("/")
def Homepage():
	return render_template("index.html")

#-------------------------------------------------------------------------------
# IMAGE PROXY

IMG_CACHE_DIR = os.path.join(DATA_DIR, "img_cache")
IMG_MAX_BYTES = 10 * 1024 * 1024
IMG_TIMEOUT = (5, 15)
IMG_CACHE_MAX_BYTES = int(os.environ.get("CAMPUS_LENS_IMG_CACHE_MB", "1024")) * 1024 * 1024
IMG_RESP_HEADERS = {
	"Cache-Control": "public, max-age=86400",
	"X-Content-Type-Options": "nosniff",
}

def _parse_img_hosts(raw):
	hosts = {h.strip().lower() for h in raw.split(",") if h.strip()}
	return hosts or {".42.fr"}

IMG_ALLOWED_HOSTS = _parse_img_hosts(os.environ.get("CAMPUS_LENS_IMG_HOSTS", ".42.fr"))

def img_is_allowed(url):
	try:
		parts = urlsplit(url)
	except ValueError:
		return False
	if parts.scheme != "https":
		return False
	host = (parts.hostname or "").lower()
	if not host:
		return False
	for entry in IMG_ALLOWED_HOSTS:
		if entry.startswith("."):
			if host == entry[1:] or host.endswith(entry):
				return True
		elif host == entry:
			return True
	return False

def img_cache_path(url):
	digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
	ext = os.path.splitext(urlsplit(url).path)[1].lower()
	if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
		ext = ".jpg"
	return os.path.join(IMG_CACHE_DIR, digest + ext)

_img_evict_lock = threading.Lock()
_img_last_evict = 0.0
IMG_EVICT_INTERVAL = 30

def img_cache_evict():
	global _img_last_evict
	if IMG_CACHE_MAX_BYTES <= 0:
		return
	if (time.monotonic() - _img_last_evict) < IMG_EVICT_INTERVAL:
		return
	if not _img_evict_lock.acquire(blocking=False):
		return
	try:
		_img_last_evict = time.monotonic()
		entries, total = [], 0
		try:
			with os.scandir(IMG_CACHE_DIR) as it:
				for e in it:
					if e.name.endswith(".tmp") or not e.is_file():
						continue
					try:
						st = e.stat()
					except OSError:
						continue
					entries.append((st.st_mtime, st.st_size, e.path))
					total += st.st_size
		except FileNotFoundError:
			return
		if total <= IMG_CACHE_MAX_BYTES:
			return
		low_water = int(IMG_CACHE_MAX_BYTES * 0.9)
		entries.sort()
		freed = removed = 0
		for _mtime, size, path in entries:
			if total - freed <= low_water:
				break
			try:
				os.remove(path)
				freed += size
				removed += 1
			except OSError:
				pass
		if removed:
			log.info("img_proxy: evicted %d files (%d bytes); cache ~%d/%d bytes",
			         removed, freed, total - freed, IMG_CACHE_MAX_BYTES)
	finally:
		_img_evict_lock.release()

@app.route("/img")
def img_proxy():
	url = request.args.get("u", "")
	if not img_is_allowed(url):
		log.info("img_proxy: rejected disallowed url: %r", url[:200])
		return Response(status=400)

	cache_path = img_cache_path(url)
	cached_ctype = mimetypes.guess_type(cache_path)[0] or "image/jpeg"

	if os.path.exists(cache_path):
		try:
			with open(cache_path, "rb") as f:
				body = f.read()
			try:
				os.utime(cache_path, None)
			except OSError:
				pass
			log.debug("img_proxy: HIT %s (%d bytes) %s", os.path.basename(cache_path), len(body), url)
			return Response(body, content_type=cached_ctype, headers=IMG_RESP_HEADERS)
		except OSError as e:
			log.warning("img_proxy: cache read failed for %s, re-fetching: %s", cache_path, e)

	log.debug("img_proxy: MISS %s", url)
	started = time.monotonic()
	try:
		r = API.session.get(url, headers=API._Api42__getTokenHeader(),
		                    timeout=IMG_TIMEOUT, stream=True, allow_redirects=False)
	except requests.RequestException as e:
		log.warning("img_proxy: upstream request failed for %s: %s", url, e)
		return Response(status=502)

	with r:
		elapsed_ms = (time.monotonic() - started) * 1000
		if r.status_code != 200:
			level = logging.INFO if r.status_code == 404 else logging.WARNING
			log.log(level, "img_proxy: upstream %d in %.0fms for %s", r.status_code, elapsed_ms, url)
			return Response(status=502 if 300 <= r.status_code < 400 else r.status_code)

		ctype = (r.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
		if not ctype.startswith("image/"):
			log.warning("img_proxy: upstream returned non-image %r for %s", ctype, url)
			return Response(status=502)

		buf = bytearray()
		try:
			for chunk in r.iter_content(65536):
				buf.extend(chunk)
				if len(buf) > IMG_MAX_BYTES:
					log.warning("img_proxy: upstream body exceeded %d bytes for %s", IMG_MAX_BYTES, url)
					return Response(status=502)
		except requests.RequestException as e:
			log.warning("img_proxy: upstream read failed for %s: %s", url, e)
			return Response(status=502)

	body = bytes(buf)
	log.info("img_proxy: FETCH 200 (%d bytes, %s) in %.0fms %s", len(body), ctype, elapsed_ms, url)

	try:
		os.makedirs(IMG_CACHE_DIR, exist_ok=True)
		tmp = f"{cache_path}.{os.getpid()}.{threading.get_ident()}.tmp"
		with open(tmp, "wb") as f:
			f.write(body)
		os.replace(tmp, cache_path)
		img_cache_evict()
	except OSError as e:
		log.warning("img_proxy: could not cache %s: %s", url, e)

	return Response(body, content_type=ctype, headers=IMG_RESP_HEADERS)

#-------------------------------------------------------------------------------

@app.route('/favicon.ico')
def favicon():
	return send_from_directory(os.path.join(app.root_path, 'static'), '42.jpg')

@app.route("/<page>")
def Other(page):
	return render_template(f"{page}.html")

if __name__ == '__main__':
	app.run(debug=True, host='0.0.0.0', port=SERVER_PORT)
