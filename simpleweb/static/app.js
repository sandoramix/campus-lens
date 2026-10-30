'use strict';

(() => {
	/* =========================================================================
	   Helpers
	   ========================================================================= */

	const $ = (sel, root = document) => root.querySelector(sel);
	const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
	const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
	const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

	const store = {
		get(key, fallback) {
			try {
				const v = localStorage.getItem('campus-lens.' + key);
				return v === null ? fallback : JSON.parse(v);
			} catch (e) { return fallback; }
		},
		set(key, value) {
			try { localStorage.setItem('campus-lens.' + key, JSON.stringify(value)); } catch (e) { }
		},
	};

	const debounce = (fn, ms) => {
		let t;
		return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
	};

	const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
	const looksNumeric = (v) => v !== '' && v !== null && v !== undefined && typeof v !== 'boolean' && !Number.isNaN(Number(v));

	function fmtNum(v, digits = 0) {
		if (!isNum(v)) return '—';
		return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
	}
	function fmtDate(iso) {
		if (!iso) return '—';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return esc(iso);
		return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
	}
	function fmtDuration(ms) {
		const s = Math.floor(ms / 1000);
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}
	const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	const REL_UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
	/** "3 days ago", "in 2 weeks"… for an ISO date or a Date. */
	function fmtRel(when) {
		const d = when instanceof Date ? when : new Date(when);
		if (!when || Number.isNaN(d.getTime())) return '';
		const s = (d.getTime() - Date.now()) / 1000;
		for (const [unit, secs] of REL_UNITS) if (Math.abs(s) >= secs) return RTF.format(Math.round(s / secs), unit);
		return 'just now';
	}
	function fmtDateTime(iso) {
		const d = new Date(iso);
		if (!iso || Number.isNaN(d.getTime())) return '—';
		return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
	/** Date with its relative time; the exact time is in the tooltip. */
	const dateRel = (iso) => iso ? `<span class="date-rel" title="${esc(fmtDateTime(iso))}">${fmtDate(iso)} <span class="muted">· ${esc(fmtRel(iso))}</span></span>` : '<span class="muted">—</span>';
	const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
	const daysUntil = (iso) => (new Date(iso).getTime() - Date.now()) / 86400000;

	const intraUrl = (login) => `https://profile.intra.42.fr/users/${encodeURIComponent(login)}`;
	/** The intra page of a project attempt (a team's page). */
	const projectUrl = (e) => e?.project?.slug && e.id ? `https://projects.intra.42.fr/projects/${encodeURIComponent(e.project.slug)}/projects_users/${e.id}` : null;
	const extLink = (href, text, title = '') => `<a class="ext" href="${esc(href)}" target="_blank" rel="noreferrer" ${title ? `title="${esc(title)}"` : ''}>${text}<i class="fa fa-external-link"></i></a>`;
	const mailLink = (email) => email ? `<a class="ext" href="mailto:${esc(email)}" title="Write to ${esc(email)}"><i class="fa fa-envelope-o"></i></a>` : '';
	/** API links need a token: the users ones are opened as intra profiles, the others aren't links. */
	function browsableUrl(url) {
		const m = /^https:\/\/api\.intra\.42\.fr\/v2\/users\/([^/?#]+)$/.exec(url);
		if (m) return intraUrl(decodeURIComponent(m[1]));
		return /^https?:\/\/api\.intra\.42\.fr\//.test(url) ? null : url;
	}

	const humanize = (s) => s ? String(s).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—';
	const plural = (n, word, many = word + 's') => `${fmtNum(n)} ${n === 1 ? word : many}`;

	function getPath(obj, path) {
		let values = [obj];
		for (const part of path.split('.')) {
			const next = [];
			for (const v of values) {
				if (v === null || v === undefined) continue;
				const item = v[part];
				if (Array.isArray(item)) next.push(...item);
				else if (item !== undefined) next.push(item);
			}
			values = next;
			if (!values.length) return null;
		}
		return values[0] ?? null;
	}

	function compareValues(a, b) {
		if (typeof a === 'number' && typeof b === 'number') return a - b;
		if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b);
		return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
	}

	/** Sorts by `getter`; null/undefined/'' always go last whatever the direction. */
	function sortBy(list, getter, dir) {
		const sign = dir === 'desc' ? -1 : 1;
		return list
			.map((item, i) => ({ item, i, v: getter(item) }))
			.sort((x, y) => {
				const xn = x.v === null || x.v === undefined || x.v === '';
				const yn = y.v === null || y.v === undefined || y.v === '';
				if (xn || yn) return xn === yn ? x.i - y.i : (xn ? 1 : -1);
				return compareValues(x.v, y.v) * sign || x.i - y.i;
			})
			.map((x) => x.item);
	}

	async function copyText(text) {
		try {
			await navigator.clipboard.writeText(text);
		} catch (e) {
			const ta = document.createElement('textarea');
			ta.value = text;
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			ta.remove();
		}
		toast('Copied to clipboard');
	}

	/* =========================================================================
	   Constants
	   ========================================================================= */

	const CLIENT_PARAMS = ['view', 'display', 'q', 'sortby', 'order', 'page'];
	const VIEWS = ['students', 'cursus', 'graph', 'exams', 'projects'];
	const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
	const OPS = [['~', 'contains'], ['==', 'is'], ['!=', 'is not'], ['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤']];
	const OP_SYMBOL = { '~': '∋', '==': '=', '!=': '≠', '>': '>', '>=': '≥', '<': '<', '<=': '≤' };
	const KNOWN_STATUSES = ['finished', 'in_progress', 'waiting_for_correction', 'searching_a_group', 'creating_group', 'waiting_to_start', 'parent'];
	const ACTIVE_STATUSES = ['in_progress', 'waiting_for_correction', 'searching_a_group', 'creating_group', 'waiting_to_start'];
	const MONITOR_INTERVALS = [60, 300, 600, 1800, 3600];
	const fmtInterval = (s) => s >= 3600 ? `${s / 3600}h` : s >= 60 ? `${s / 60}m` : `${s}s`;

	const KIND = {
		exams: { name: 'examname', prefix: 'exam', label: 'Exam', labels: 'Exams', icon: 'fa-graduation-cap' },
		projects: { name: 'projectname', prefix: 'project', label: 'Project', labels: 'Projects', icon: 'fa-folder-open-o' },
	};

	const PARAM_LABELS = {
		fullscan: 'Full scan',
		campus_id: 'Campus',
		examname: 'Exam',
		exam_mark: 'Exam mark',
		exam_status: 'Exam status',
		exam_validated: 'Exam passed',
		exam_required: 'Has matching exam',
		projectname: 'Project',
		project_mark: 'Project mark',
		project_status: 'Project status',
		project_validated: 'Project passed',
		project_required: 'Has matching project',
	};
	const FLAG_PARAMS = new Set(['fullscan', 'exam_required', 'project_required']);

	const FIELD_LABELS = {
		level: 'Level',
		stage: 'Stage',
		cursus_start: 'Cursus start',
		cursus: 'Cursus',
		wallet: 'Wallet',
		correction_point: 'Eval points',
		average_exam_final_mark: 'Exam avg',
		average_project_final_mark: 'Project avg',
		average_mark: 'Overall avg',
		cpiscine_final_mark: 'C Piscine final',
		exams_passed: 'Exams passed',
		projects_passed: 'Projects passed',
		pool: 'Pool',
		pool_year: 'Pool year',
		pool_month: 'Pool month',
		login: 'Login',
		displayname: 'Name',
		location: 'Location',
		kind: 'Kind',
		created_at: 'Created',
		updated_at: 'Updated',
	};
	const fieldLabel = (k) => FIELD_LABELS[k] || k;

	const STAGES = {
		upcoming: { label: 'Common core not started', short: 'Starts soon', cls: 'info', hint: 'Subscribed to a 42cursus that has not started yet' },
		pisciner: { label: 'C Piscine only', short: 'Pisciner', cls: 'warn', hint: 'The C Piscine is their only cursus' },
		cadet: { label: 'Cadets', short: 'Cadet', cls: 'accent', hint: 'Enrolled in 42cursus' },
		other: { label: 'Other', short: 'Other', cls: '', hint: 'Other cursus only (e.g. Discovery Piscine)' },
	};
	function stageBadge(u) {
		const st = STAGES[u.stage];
		const start = u.stage === 'upcoming' && u.cursus_start ? ` ${esc(String(u.cursus_start).slice(0, 10))}` : '';
		const extra = u.cursus_status === 'blackholed' || u.cursus_status === 'left' ? cursusBadge(u)
			: '';
		return st ? `<span class="badge ${st.cls}" title="${esc(st.hint)}">${fv('stage', u.stage, esc(st.short))}${start}</span>${extra}` : '';
	}

	const SORT_PRESETS = [
		['login', 'Login'], ['displayname', 'Name'], ['pool', 'Pool'], ['wallet', 'Wallet'], ['correction_point', 'Eval points'],
		['location', 'Location'], ['created_at', 'Created'], ['updated_at', 'Updated'],
	];
	const SORT_PRESETS_FULLSCAN = [
		['level', 'Level'], ['average_exam_final_mark', 'Exam average'], ['average_project_final_mark', 'Project average'],
		['average_mark', 'Overall average'], ['cpiscine_final_mark', 'C Piscine final exam'], ['exams_passed', 'Exams passed'],
		['projects_passed', 'Projects passed'], ['cursus_start', 'Cursus start'],
	];

	function parseCond(raw) {
		const v = String(raw ?? '');
		for (const op of ['>=', '<=', '==', '!=', '>', '<']) {
			if (v.startsWith(op)) return { op, val: v.slice(op.length) };
		}
		return { op: '~', val: v };
	}
	const buildCond = (op, val) => (op === '~' ? val : op + val);

	/* =========================================================================
	   State
	   ========================================================================= */

	const newExplorer = () => ({
		sel: new Set(), facetQ: '', status: '', result: '', min: '', max: '', best: false,
		mode: 'list', sort: { key: 'date', dir: 'desc' }, page: 1,
	});

	const S = {
		meta: null,
		students: [],
		byId: new Map(),
		entries: { exams: [], projects: [] },
		loadedKey: null,
		error: null,

		applied: [],   // server params currently loaded: [[key, value]]
		staged: [],    // server params being edited (not yet applied)

		view: 'students',
		display: store.get('display', 'grid'),
		q: '',
		sort: { key: '', dir: 'asc' },
		page: 1,
		pageSize: { grid: 48, table: 50, cursus: 50, exams: 100, projects: 100, matrix: 100, ...store.get('pageSize', {}) },
		explorer: { exams: newExplorer(), projects: newExplorer() },

		drawer: { id: null, tab: 'overview', q: '', status: '', onlyMatching: false, sort: { key: 'date', dir: 'desc' }, nav: [] },
		monitor: { on: false, interval: [60, 300, 600, 1800, 3600].includes(store.get('monitorInterval', 300)) ? store.get('monitorInterval', 300) : 300, timer: null, ticking: false, lastTick: null, lastError: null, changed: new Set() },
		panelOpen: false,
		fieldRows: [],
		menu: null,
		lightbox: null,
		// what the Rescan button fetches again; `force` is never remembered
		rescan: { students: true, profiles: true, ...store.get('rescan', {}), force: false },
		noticeDismissed: store.get('dismissed', {}),
		cursus: { status: 'active', sort: { key: 'date', dir: 'desc' }, page: 1 },
		graph: { me: store.get('me', ''), sel: null, zoom: 1, minPeople: 3, onlyActive: true, show: {}, sort: 'level' },
	};

	/** Profiles fetched in the background for the students on screen (the lazy "full scan"). */
	const LZ = { on: store.get('autoFetch', true), busy: false, failed: new Set(), timer: null, flushTimer: null, left: 0, stash: {} };
	const LAZY_BATCH = 12;       // profiles per request (the server accepts as many)
	const LAZY_MAX_VIEW = 400;   // the cursus and graph views fetch everything on screen up to this many students
	const MAIN_CURSUS = new Set([21, 1]);
	const hasProfile = (u) => Array.isArray(u.all_projects);

	/* =========================================================================
	   Params & URL
	   ========================================================================= */

	const customParamNames = () => new Set([...(S.meta?.customFilters || []).map((f) => f.name), ...CLIENT_PARAMS]);

	function paramsKey(pairs) {
		return pairs.filter(([k, v]) => v !== '' || FLAG_PARAMS.has(k)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).sort().join('&');
	}
	const getParam = (pairs, key) => (pairs.find(([k]) => k === key) || [])[1];
	function setParam(pairs, key, value) {
		const idx = pairs.findIndex(([k]) => k === key);
		if (value === null || value === undefined || value === '' && !FLAG_PARAMS.has(key)) {
			if (idx >= 0) pairs.splice(idx, 1);
		} else if (idx >= 0) {
			pairs[idx] = [key, String(value)];
		} else {
			pairs.push([key, String(value)]);
		}
	}
	const clonePairs = (pairs) => pairs.map(([k, v]) => [k, v]);
	const isDirty = () => paramsKey(S.staged) !== paramsKey(S.applied);

	function readUrl() {
		const params = new URLSearchParams(location.search);
		const applied = [];
		for (const [k, v] of params.entries()) {
			if (CLIENT_PARAMS.includes(k)) continue;
			// one-shot: never kept in the URL, so a reload doesn't rescan again
			if (k === 'rescan' || k === 'force') continue;
			if (v === '' && !FLAG_PARAMS.has(k)) continue;
			setParam(applied, k, v);
		}
		S.applied = applied;
		S.view = VIEWS.includes(params.get('view')) ? params.get('view') : 'students';
		if (['grid', 'table'].includes(params.get('display'))) S.display = params.get('display');
		S.q = params.get('q') || '';
		S.sort = { key: params.get('sortby') || '', dir: params.get('order') === 'desc' ? 'desc' : 'asc' };
		S.page = Math.max(1, parseInt(params.get('page'), 10) || 1);
		$('#quick-search').value = S.q;
	}

	function buildUrl(applied = S.applied) {
		const params = new URLSearchParams();
		for (const [k, v] of applied) params.append(k, v);
		if (S.view !== 'students') params.set('view', S.view);
		if (S.q) params.set('q', S.q);
		if (S.sort.key) {
			params.set('sortby', S.sort.key);
			params.set('order', S.sort.dir);
		}
		if (S.page > 1 && S.view === 'students') params.set('page', S.page);
		const qs = params.toString().replace(/fullscan=(&|$)/, 'fullscan$1');
		return location.pathname + (qs ? '?' + qs : '');
	}

	function syncUrl(push = false) {
		const url = buildUrl();
		if (url === location.pathname + location.search) return;
		history[push ? 'pushState' : 'replaceState'](null, '', url);
	}

	/* =========================================================================
	   Data loading
	   ========================================================================= */

	let loadController = null;
	let loadingTimer = null;

	/** `rescan`: null, or { students, profiles, force } to fetch again before searching. */
	async function load({ keepStaged = null, rescan = null, silent = false } = {}) {
		const key = paramsKey(S.applied);
		if (key === S.loadedKey && !S.error && !rescan) {
			S.staged = keepStaged || clonePairs(S.applied);
			renderAll();
			return;
		}
		loadController?.abort();
		const controller = new AbortController();
		loadController = controller;

		const fullscan = getParam(S.applied, 'fullscan') !== undefined;
		const started = Date.now();
		clearInterval(loadingTimer);
		const showLoading = silent ? null : setTimeout(() => {
			$('#loading').hidden = false;
			$('#loading-title').textContent = rescan ? 'Rescanning…' : fullscan ? 'Running full scan…' : 'Loading students…';
			const bar = $('#loading-progress');
			bar.hidden = true;
			// the last progress seen: kept between polls so the text is written once per tick, never reset
			let scan = null;
			let polling = false;
			const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
			const paint = () => {
				const elapsed = fmtDuration(Date.now() - started);
				if (!scan) { setText($('#loading-sub'), `Elapsed ${elapsed}`); return; }
				if (scan.phase === 'students') {
					setText($('#loading-title'), 'Fetching the student list again…');
					setText($('#loading-sub'), `${fmtNum(scan.done)}${scan.total ? ' of ' + fmtNum(scan.total) : ''} students · ${elapsed}`);
				} else {
					const left = scan.total - scan.done;
					setText($('#loading-title'), rescan ? 'Fetching profiles again…' : 'Running full scan…');
					setText($('#loading-sub'), `Fetched ${fmtNum(scan.done)} of ${plural(scan.total, 'profile')} from the 42 API · ${left ? scanEta(scan, left) + ' left' : 'finishing'} · ${elapsed}`);
				}
				bar.hidden = false;
				bar.firstElementChild.style.width = `${scan.total ? scan.done / scan.total * 100 : 0}%`;
			};
			const updateSub = async () => {
				paint();
				// one poll at a time: a slow answer must not land after a newer one
				if ((!fullscan && !rescan) || polling) return;
				polling = true;
				try {
					const next = await (await fetch('/api/scan')).json();
					if (loadController !== controller) return;
					// between the list and the profiles nothing is active: keep the last progress
					if (next.active) { scan = next; paint(); }
				} catch (e) { /* keep the last progress */ } finally { polling = false; }
			};
			updateSub();
			loadingTimer = setInterval(updateSub, 1000);
		}, 180);

		try {
			const params = new URLSearchParams(S.applied);
			if (rescan) {
				params.set('rescan', ['students', 'profiles'].filter((k) => rescan[k]).join(','));
				if (rescan.force) params.set('force', '1');
			}
			const qs = params.toString();
			const res = await fetch('/api/search' + (qs ? '?' + qs : ''), { signal: controller.signal });
			if (!res.ok) throw new Error(`Server responded ${res.status}`);
			const data = await res.json();
			ingest(data);
			S.loadedKey = key;
			S.error = null;
			if (rescan && !silent) reportRescan(data.meta.rescanned);
		} catch (e) {
			if (e.name === 'AbortError') return;
			console.error(e);
			S.error = e.message || String(e);
		} finally {
			if (loadController === controller) {
				clearTimeout(showLoading);
				clearInterval(loadingTimer);
				$('#loading').hidden = true;
			}
		}
		S.staged = keepStaged ? keepStaged.filter(([k]) => k !== '') : clonePairs(S.applied);
		renderAll();
	}

	function isExamEntry(e) {
		return String(e?.project?.slug || '').toLowerCase().includes('exam');
	}

	function ingest({ meta, students }) {
		S.meta = meta;
		if (meta.jobsActive && !CM.timer) refreshJobs();
		S.students = students;
		S.byId = new Map();
		S.entries = { exams: [], projects: [] };
		for (const u of students) {
			S.byId.set(u.id, u);
			const all = Array.isArray(u.all_projects) ? u.all_projects : [];
			u._exams = all.filter(isExamEntry);
			u._projects = all.filter((e) => !isExamEntry(e));
			u._matched = new Set([...(u.matched_exams || []), ...(u.matched_projects || [])]);
			u._now = all.filter((e) => ACTIVE_STATUSES.includes(e.status) && (e.cursus_ids || []).some((c) => MAIN_CURSUS.has(c)));
			u._begin = (u.cursus_users || []).filter((c) => MAIN_CURSUS.has(c.cursus_id) && c.begin_at).map((c) => Date.parse(c.begin_at)).sort((a, b) => b - a)[0] ?? null;
			u._search = [u.login, u.displayname, u.usual_full_name, u.email, u.first_name, u.last_name]
				.filter(Boolean).join(' ').toLowerCase();
			const month = MONTHS.indexOf(String(u.pool_month || '').toLowerCase());
			u.pool = u.pool_year ? Number(u.pool_year) * 100 + (month + 1) : null;
			for (const kind of ['exams', 'projects']) {
				const list = kind === 'exams' ? u._exams : u._projects;
				for (const e of list) {
					S.entries[kind].push({
						u, e,
						name: e.project?.name || e.project?.slug || '—',
						mark: isNum(e.final_mark) ? e.final_mark : null,
						ok: e['validated?'] === true ? true : e['validated?'] === false ? false : null,
						status: e.status || '',
						occ: isNum(e.occurrence) ? e.occurrence : null,
						date: e.marked_at || e.updated_at || null,
					});
				}
			}
		}
		visibleCache = null;
	}

	/* =========================================================================
	   Derived data
	   ========================================================================= */

	let visibleCache = null;

	/** Students matching the quick search, sorted. */
	function visibleStudents() {
		const cacheKey = `${S.q}|${S.sort.key}|${S.sort.dir}`;
		if (visibleCache && visibleCache.key === cacheKey && visibleCache.src === S.students) return visibleCache.list;
		const tokens = S.q.toLowerCase().split(/\s+/).filter(Boolean);
		let list = tokens.length ? S.students.filter((u) => tokens.every((t) => u._search.includes(t))) : S.students;
		if (S.sort.key) list = sortBy(list, (u) => getPath(u, S.sort.key), S.sort.dir);
		visibleCache = { key: cacheKey, src: S.students, list, ids: new Set(list.map((u) => u.id)) };
		return list;
	}
	const visibleIds = () => (visibleStudents(), visibleCache.ids);

	function bestEntry(list) {
		let best = null;
		for (const e of list) {
			if (!best) { best = e; continue; }
			const a = isNum(e.final_mark) ? e.final_mark : -1;
			const b = isNum(best.final_mark) ? best.final_mark : -1;
			if (a > b || (a === b && (e.marked_at || '') > (best.marked_at || ''))) best = e;
		}
		return best;
	}

	function bestByName(list) {
		const groups = new Map();
		for (const e of list) {
			const name = e.project?.name || e.project?.slug;
			if (!groups.has(name)) groups.set(name, []);
			groups.get(name).push(e);
		}
		return [...groups.entries()].map(([name, items]) => ({ name, best: bestEntry(items), attempts: items.length }));
	}

	/* =========================================================================
	   Small render helpers
	   ========================================================================= */

	function initials(u) {
		const a = (u.first_name || u.login || '?')[0] || '?';
		const b = (u.last_name || '')[0] || '';
		return esc((a + b).toUpperCase());
	}

	const proxied = (url) => url ? `/img?u=${encodeURIComponent(url)}` : null;
	const photoUrl = (u) => proxied(u.image?.versions?.medium || u.image?.link);
	const largePhotoUrl = (u) => proxied(u.image?.versions?.large || u.image?.link) || photoUrl(u);

	/** Uncropped photo on top of a blurred copy of itself; clicking it opens the lightbox. */
	function photo(u) {
		const src = photoUrl(u);
		if (!src) return `<span class="initials">${initials(u)}</span>`;
		return `
			<span class="initials">${initials(u)}</span>
			<img class="photo-fill" src="${esc(src)}" alt="" loading="lazy" aria-hidden="true" onerror="this.remove()">
			<img class="photo-main" src="${esc(src)}" alt="${esc(u.login)}" loading="lazy" onerror="this.remove()">
			<span class="photo-zoom"><i class="fa fa-search-plus"></i></span>`;
	}
	const zoomAttrs = (u) => photoUrl(u) ? `data-act="zoom" data-id="${u.id}" title="Enlarge photo"` : '';

	function avatar(u, size = '') {
		const src = proxied(u.image?.versions?.small || u.image?.link);
		return `<span class="avatar ${size}">${initials(u)}${src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
	}

	function entryThumb(u) {
		const src = photoUrl(u);
		if (!src) return `<span class="ethumb noimg">${initials(u)}</span>`;
		return `<span class="ethumb" ${zoomAttrs(u)}>${initials(u)}` +
			`<img src="${esc(src)}" alt="${esc(u.login)}" loading="lazy" onerror="this.closest('.ethumb').classList.add('noimg');this.remove()">` +
			`<span class="ethumb-zoom"><i class="fa fa-search-plus"></i></span></span>`;
	}

	/** A value that can be added to the filters (Ctrl+click, Alt+click or the funnel icon). */
	function fv(key, value, text = null, cls = '') {
		const shown = text ?? (value === null || value === undefined || value === '' ? '—' : esc(value));
		const v = value === null || value === undefined ? '' : String(value);
		return `<span class="fv ${cls}" data-k="${esc(key)}" data-v="${esc(v)}" title="Ctrl+click: filter · Alt+click: exclude"><span class="fv-text">${shown}</span><button class="fv-btn" type="button" tabindex="-1" aria-label="Filter by ${esc(key)}"><i class="fa fa-filter"></i></button></span>`;
	}

	/** An exam/project name that can be turned into an exam/project filter. */
	function fvEntry(kind, name, text = null) {
		return `<span class="fv" data-entry="${kind}" data-v="${esc(name)}" title="Ctrl+click: students who took it · Alt+click: students who passed it"><span class="fv-text">${text ?? esc(name)}</span><button class="fv-btn" type="button" tabindex="-1" aria-label="Filter by ${esc(name)}"><i class="fa fa-filter"></i></button></span>`;
	}

	function markPill(mark, ok) {
		const cls = ok === true ? 'ok' : ok === false ? 'bad' : (isNum(mark) ? '' : 'none');
		return `<span class="mark ${cls}">${isNum(mark) ? mark : '—'}</span>`;
	}

	function markBar(mark, ok, max = 125) {
		const pct = isNum(mark) ? Math.max(0, Math.min(100, (mark / max) * 100)) : 0;
		const cls = ok === true ? 'ok' : ok === false ? 'bad' : '';
		return `<div class="markbar">${markPill(mark, ok)}<span class="bar"><i class="${cls}" style="width:${pct}%"></i></span></div>`;
	}

	function resultBadge(ok) {
		if (ok === true) return '<span class="badge ok"><i class="fa fa-check"></i>Passed</span>';
		if (ok === false) return '<span class="badge bad"><i class="fa fa-times"></i>Failed</span>';
		return '<span class="badge">Not graded</span>';
	}

	function statusBadge(status) {
		const cls = status === 'finished' ? '' : status === 'in_progress' ? 'info' : 'warn';
		return `<span class="badge ${cls}">${esc(humanize(status))}</span>`;
	}

	function sortHeader(scope, key, label, current, cls = '') {
		const active = current.key === key;
		const icon = active ? (current.dir === 'desc' ? 'fa-sort-desc' : 'fa-sort-asc') : 'fa-sort';
		return `<th class="sortable ${active ? 'sorted' : ''} ${cls}" data-act="th-sort" data-scope="${scope}" data-key="${esc(key)}">${esc(label)}<i class="fa ${icon} sort-ind"></i></th>`;
	}

	function pager(scope, total, page, size, sizes) {
		const pages = Math.max(1, Math.ceil(total / size));
		const from = total ? (page - 1) * size + 1 : 0;
		const to = Math.min(total, page * size);
		const nums = [];
		const add = (n) => nums.push(n);
		for (let n = 1; n <= pages; n++) {
			if (n === 1 || n === pages || Math.abs(n - page) <= 1) add(n);
			else if (nums[nums.length - 1] !== '…') add('…');
		}
		return `
			<div class="pager">
				<div>Showing <b class="num">${fmtNum(from)}–${fmtNum(to)}</b> of <b class="num">${fmtNum(total)}</b></div>
				<div class="pager-pages">
					<button data-act="page" data-scope="${scope}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Previous page"><i class="fa fa-chevron-left"></i></button>
					${nums.map((n) => n === '…' ? '<span class="gap">…</span>' : `<button data-act="page" data-scope="${scope}" data-page="${n}" class="${n === page ? 'active' : ''}">${n}</button>`).join('')}
					<button data-act="page" data-scope="${scope}" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Next page"><i class="fa fa-chevron-right"></i></button>
				</div>
				<label class="toolbar-group"><span class="label">Per page</span>
					<select class="select select-sm" data-bind="pagesize" data-scope="${scope}">
						${sizes.map((n) => `<option value="${n}" ${n === size ? 'selected' : ''}>${n}</option>`).join('')}
					</select>
				</label>
			</div>`;
	}

	function clampPage(page, total, size) {
		return Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / size)));
	}

	/** Re-renders while keeping the focused input (and caret) alive. */
	function keepFocus(fn) {
		const el = document.activeElement;
		const bind = el?.dataset?.bind;
		const idx = el?.dataset?.i;
		let start = null, end = null;
		try { start = el.selectionStart; end = el.selectionEnd; } catch (e) { }
		fn();
		if (!bind) return;
		const sel = `[data-bind="${bind}"]${idx !== undefined ? `[data-i="${idx}"]` : ''}`;
		const next = $(sel);
		if (next && next !== el) {
			next.focus();
			try { if (start !== null) next.setSelectionRange(start, end); } catch (e) { }
		}
	}

	/* =========================================================================
	   App bar, tabs, chips, notices
	   ========================================================================= */

	function renderCampus() {
		const m = S.meta;
		const box = $('#campus-select');
		if (!m) { box.innerHTML = ''; return; }
		const options = [];
		if (m.hasDefaultFile) options.push(['', 'Default (students.json)']);
		for (const c of m.campuses) options.push([String(c.id), `${c.name}`]);
		const current = m.requestedCampusId !== null && m.requestedCampusId !== undefined
			? String(m.requestedCampusId)
			: (m.hasDefaultFile ? '' : String(m.campusId ?? ''));
		if (!options.some(([v]) => v === current)) options.push([current, current ? `Campus ${current} (no data)` : 'No data']);
		options.push(['__manage', '＋ Add or update campuses…']);
		box.innerHTML = `
			<select class="select" data-bind="campus" title="Campus — only campuses fetched with ./fetch-students.sh are listed">
				${options.map(([v, label]) => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(label)}</option>`).join('')}
			</select>`;
	}

	function renderTabs() {
		for (const btn of $$('#view-tabs button')) {
			btn.classList.toggle('active', btn.dataset.view === S.view);
			btn.setAttribute('aria-selected', btn.dataset.view === S.view);
		}
		const ids = S.meta ? visibleIds() : new Set();
		const counts = {
			students: S.meta ? visibleStudents().length : '',
			cursus: S.meta ? cursusRows().length : '',
			exams: S.meta?.fullscan ? S.entries.exams.filter((r) => ids.has(r.u.id)).length : '',
			projects: S.meta?.fullscan ? S.entries.projects.filter((r) => ids.has(r.u.id)).length : '',
		};
		for (const el of $$('#view-tabs .tab-count')) {
			const n = counts[el.dataset.count];
			el.textContent = n === '' ? '' : fmtNum(n);
		}
	}

	function renderFilterCount() {
		const n = S.applied.filter(([k]) => k !== 'campus_id' && k !== 'sortby' && k !== 'order').length;
		const el = $('#filter-count');
		el.hidden = !n;
		el.textContent = n;
	}

	function chipLabel(key, value) {
		if (FLAG_PARAMS.has(key)) return `<span class="chip-key">${esc(PARAM_LABELS[key])}</span>`;
		if (key === 'stage') {
			const { op, val } = parseCond(value);
			return `<span class="chip-key">Stage</span><span class="chip-op">${OP_SYMBOL[op]}</span><span class="chip-val">${esc(STAGES[val]?.label || val)}</span>`;
		}
		if (key === 'campus_id') {
			const c = S.meta?.campuses.find((c) => String(c.id) === String(value));
			return `<span class="chip-key">Campus</span><span class="chip-val">${esc(c ? c.name : value)}</span>`;
		}
		if (key.endsWith('_validated')) {
			const yes = /true/i.test(value) && !String(value).startsWith('!=');
			return `<span class="chip-key">${esc(PARAM_LABELS[key])}</span><span class="chip-val">${yes ? 'yes' : 'no'}</span>`;
		}
		const { op, val } = parseCond(value);
		return `<span class="chip-key">${esc(PARAM_LABELS[key] || key)}</span><span class="chip-op">${OP_SYMBOL[op]}</span><span class="chip-val">${val === '' ? '<i>empty</i>' : esc(val)}</span>`;
	}

	function renderChipbar() {
		const bar = $('#chipbar');
		if (!S.meta) { bar.hidden = true; return; }
		const unknown = new Set(S.meta.unknownKeys || []);
		const needs = new Set(S.meta.needsFullscan || []);
		const keys = [...S.applied.map(([k]) => k), ...S.staged.map(([k]) => k)];
		const seen = new Set();
		const chips = [];
		for (const key of keys) {
			if (seen.has(key) || key === 'sortby' || key === 'order') continue;
			seen.add(key);
			const a = getParam(S.applied, key);
			const s = getParam(S.staged, key);
			let cls = '', title = '';
			if (a !== undefined && s === undefined) { cls = 'removed'; title = 'Will be removed — click to restore'; }
			else if (a === undefined && s !== undefined) { cls = 'added'; title = 'Pending — press Apply'; }
			else if (a !== s) { cls = 'added'; title = `Pending change (was ${a})`; }
			else if (unknown.has(key)) { cls = 'warn'; title = 'Unknown field: ignored by the server'; }
			else if (needs.has(key)) { cls = 'warn'; title = 'Needs a full scan: currently ignored'; }
			const value = s !== undefined ? s : a;
			const warnIcon = cls === 'warn' ? '<i class="fa fa-exclamation-triangle" style="color:var(--warn)"></i>' : '';
			chips.push(`
				<span class="chip ${cls}" data-act="${cls === 'removed' ? 'chip-restore' : 'chip-edit'}" data-k="${esc(key)}" title="${esc(title)}">
					${warnIcon}${chipLabel(key, value)}
					${cls === 'removed' ? '' : `<button class="chip-x" data-act="chip-remove" data-k="${esc(key)}" aria-label="Remove filter"><i class="fa fa-times"></i></button>`}
				</span>`);
		}
		const dirty = isDirty();
		if (!chips.length && !dirty) { bar.hidden = true; return; }
		bar.hidden = false;
		const pendingCount = countPending();
		bar.innerHTML = `
			<div class="chipbar-inner">
				<span class="chipbar-label">Filters</span>
				${chips.join('')}
				${!dirty && S.applied.length ? '<button class="btn btn-ghost btn-xs" data-act="clear-all">Clear all</button>' : ''}
				${dirty ? `
					<div class="pending-actions">
						<span class="hint">${plural(pendingCount, 'pending change')}</span>
						<button class="btn btn-ghost btn-sm" data-act="discard">Discard</button>
						<button class="btn btn-primary btn-sm" data-act="apply">Apply <kbd>Ctrl ↵</kbd></button>
					</div>` : ''}
			</div>`;
	}

	function countPending() {
		const keys = new Set([...S.applied.map(([k]) => k), ...S.staged.map(([k]) => k)]);
		let n = 0;
		for (const k of keys) if (getParam(S.applied, k) !== getParam(S.staged, k)) n++;
		return n;
	}


	/** Time left of a running scan, from the pace measured so far (the fixed estimate until a few profiles are done). */
	function scanEta(scan, left) {
		const spent = scan.startedAt ? Date.now() / 1000 - scan.startedAt : 0;
		if (scan.done < 3 || spent < 3) return apiEstimate(left);
		const seconds = Math.round(left * spent / scan.done);
		if (seconds < 60) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s`;
		const m = Math.floor(seconds / 60);
		return m < 10 ? `about ${m} min ${String(seconds % 60).padStart(2, '0')} s` : `about ${m + (seconds % 60 >= 30 ? 1 : 0)} min`;
	}

	function apiEstimate(n) {
		// The 42 API allows ~2 requests per second
		const minutes = n / 2 / 60;
		return minutes < 1 ? 'under a minute' : `about ${Math.ceil(minutes)} min`;
	}

	function renderNotices() {
		const box = $('#notices');
		const m = S.meta;
		const out = [];
		if (S.error) {
			out.push(`
				<div class="notice bad"><i class="fa fa-exclamation-circle"></i>
					<div class="notice-body"><div class="notice-title">Could not load students</div><div class="notice-text">${esc(S.error)}</div></div>
					<div class="notice-actions"><button class="btn btn-sm" data-act="retry"><i class="fa fa-refresh"></i>Retry</button></div>
				</div>`);
		}
		if (m && !m.error) {
			if (m.needsFullscan?.length) {
				out.push(`
					<div class="notice warn"><i class="fa fa-exclamation-triangle"></i>
						<div class="notice-body">
							<div class="notice-title">Some filters need a full scan</div>
							<div class="notice-text">${m.needsFullscan.map((k) => `<code>${esc(k)}</code>`).join(' ')} ${m.needsFullscan.length > 1 ? 'are' : 'is'} ignored until each student's profile is fetched.</div>
						</div>
						<div class="notice-actions"><button class="btn btn-primary btn-sm" data-act="fullscan-on"><i class="fa fa-bolt"></i>Run full scan</button></div>
					</div>`);
			}
			if (m.unknownKeys?.length) {
				out.push(`
					<div class="notice warn"><i class="fa fa-question-circle"></i>
						<div class="notice-body">
							<div class="notice-title">Unknown fields were ignored</div>
							<div class="notice-text">${m.unknownKeys.map((k) => `<code>${esc(k)}</code>`).join(' ')} — not found on any student${m.fullscan ? '' : ' (some fields only exist after a full scan)'}.</div>
						</div>
						<div class="notice-actions"><button class="btn btn-sm" data-act="remove-unknown">Remove</button></div>
					</div>`);
			}
			if (m.unfetchedExcluded && !m.fetching) {
				out.push(`
					<div class="notice warn"><i class="fa fa-filter"></i>
						<div class="notice-body">
							<div class="notice-title">${plural(m.unfetchedExcluded, 'student')} left out</div>
							<div class="notice-text">Filters on levels, exams and projects only match students whose profile is fetched. The others can't be told apart until they are fetched.</div>
						</div>
						<div class="notice-actions"><button class="btn btn-primary btn-sm" data-act="fullscan-on"><i class="fa fa-bolt"></i>Run full scan</button></div>
					</div>`);
			}
			const failed = m.fullscan ? S.students.filter((u) => u.failedFetchExams).length : 0;
			if (failed) {
				out.push(`
					<div class="notice warn"><i class="fa fa-exclamation-triangle"></i>
						<div class="notice-body"><div class="notice-title">${plural(failed, 'profile')} could not be fetched</div>
						<div class="notice-text">Those students have no exam or project data. They're fetched again by the next full scan or <b>Rescan</b>.</div></div>
					</div>`);
			}
		}
		box.innerHTML = out.join('');
	}

	/* =========================================================================
	   Views
	   ========================================================================= */

	function renderView() {
		const root = $('#view');
		const m = S.meta;
		if (!m) { root.innerHTML = S.error ? '' : '<div class="empty"><div class="spinner"></div></div>'; return; }
		if (m.error) { root.innerHTML = renderSetup(); return; }
		const scrolled = $('.graph-scroll');
		const graphPos = scrolled ? [scrolled.scrollLeft, scrolled.scrollTop] : null;
		if (S.view === 'students') root.innerHTML = renderStudents();
		else if (S.view === 'cursus') root.innerHTML = renderCursusView();
		else if (S.view === 'graph') root.innerHTML = renderGraph();
		else root.innerHTML = renderExplorer(S.view);
		const graphScroll = graphPos && S.view === 'graph' ? $('.graph-scroll') : null;
		if (graphScroll) [graphScroll.scrollLeft, graphScroll.scrollTop] = graphPos;
		scheduleLazy(600);
	}

	function renderSetup() {
		const m = S.meta;
		const campus = m.requestedCampusId ?? m.defaultCampus;
		const expected = m.requestedCampusId !== null && m.requestedCampusId !== undefined
			? `data/campus_${m.requestedCampusId}_students.json`
			: `data/students.json or data/campus_&lt;id&gt;_students.json`;
		return `
			<div class="empty">
				<i class="fa fa-database"></i>
				<h3>${m.error === 'invalid_data' ? "The students file couldn't be read" : 'No student data yet'}</h3>
				<p>The app reads students from <code>${expected}</code>. Fetch them from the 42 API first:</p>
				<ol class="steps">
					<li>Put your API credentials in <code>.env</code> (see <code>.env.example</code>).</li>
					<li>Run <code>./fetch-students.sh${campus ? ' ' + esc(campus) : ' &lt;campus_id&gt;'}</code> from the project root.</li>
					<li>Reload this page — the campus appears in the selector at the top.</li>
				</ol>
				<div class="actions"><button class="btn btn-primary" data-act="campuses"><i class="fa fa-cloud-download"></i>Fetch a campus from here</button></div>
				${m.campuses.length ? `<p class="muted">Campuses already fetched: ${m.campuses.map((c) => `<a href="?campus_id=${c.id}"><code>${esc(c.name)}</code></a>`).join(' ')}</p>` : ''}
			</div>`;
	}

	/* ---------- Students ---------- */

	function sortOptions() {
		const fullscan = S.meta?.fullscan;
		const preset = [...SORT_PRESETS, ...SORT_PRESETS_FULLSCAN.map(([k, l]) => [k, fullscan ? l : `${l} (full scan)`])];
		const presetKeys = new Set(preset.map(([k]) => k));
		const fields = (S.meta?.fields || []).map((f) => f.name).filter((k) => !presetKeys.has(k));
		const opt = ([k, l]) => `<option value="${esc(k)}" ${S.sort.key === k ? 'selected' : ''}>${esc(l)}</option>`;
		return `
			<option value="" ${!S.sort.key ? 'selected' : ''}>Default order</option>
			<optgroup label="Common">${preset.map(opt).join('')}</optgroup>
			<optgroup label="All fields">${fields.map((k) => opt([k, k])).join('')}</optgroup>`;
	}

	function stageSwitch() {
		const { op, val } = parseCond(getParam(S.applied, 'stage') || '');
		const current = op === '==' || op === '~' ? val : '';
		return `
			<div class="segmented" role="group" aria-label="Student type">
				${[['', 'Everyone'], ['pisciner', 'Pisciners'], ['cadet', 'Cadets'], ['upcoming', 'Starts soon'], ['other', 'Other']].map(([k, label]) => `
					<button class="${current === k ? 'active' : ''}" data-act="stage" data-stage="${k}" title="${esc(STAGES[k]?.hint || 'No restriction')}">${label}</button>`).join('')}
			</div>`;
	}

	/** What a rescan would fetch with the current options, for the current result. */
	function rescanPlan(opts = S.rescan) {
		const m = S.meta;
		const hours = m.cacheHours;
		const listAge = m.studentsFetchedAt ? Date.now() / 1000 - m.studentsFetchedAt : null;
		const list = {
			available: m.campusId !== null && m.campusId !== undefined,
			age: listAge,
			outdated: listAge === null || listAge > hours * 3600,
		};
		list.fetch = list.available && opts.students && (opts.force || list.outdated);
		list.requests = list.fetch ? Math.max(1, Math.ceil(m.total / 100)) : 0;
		const missing = Math.max(0, m.count - (m.cachedCount || 0));
		const outdated = m.outdatedCount || 0;
		const profiles = { missing, outdated, fetch: opts.profiles ? (opts.force ? m.count : missing + outdated) : 0 };
		return { list, profiles, requests: list.requests + profiles.fetch, hours };
	}

	function rescanButton() {
		const m = S.meta;
		if (!m || m.error) return '';
		const plan = rescanPlan({ students: true, profiles: true, force: false });
		const stale = (plan.list.available && plan.list.outdated ? 1 : 0) + (m.fullscan ? plan.profiles.outdated : 0);
		return `<button class="btn btn-sm" data-act="rescan-menu" title="Fetch the student list and the profiles again from the 42 API"><i class="fa fa-refresh"></i>Rescan${stale ? '<span class="stale-dot" title="Some data is older than ' + m.cacheHours + 'h"></span>' : ''}<i class="fa fa-caret-down muted"></i></button>`;
	}

	function renderRescanMenu() {
		const m = S.meta;
		const o = S.rescan;
		const plan = rescanPlan();
		const { list, profiles, hours } = plan;
		const campus = m.campuses.find((c) => c.id === m.campusId);
		const listDesc = !list.available
			? 'Not available for the default <code>students.json</code>'
			: `${esc(campus?.name || 'Campus ' + m.campusId)} · fetched ${fmtAgo(m.studentsFetchedAt)} · ${list.outdated ? `<span class="warn-text">older than ${hours}h</span>` : 'up to date'}`;
		const profDesc = `${plural(m.count, 'student')} in this result: ${fmtNum(profiles.missing)} never fetched, ${fmtNum(profiles.outdated)} older than ${hours}h${m.fullscan ? '' : ' · <span class="warn-text">turns on full scan</span>'}`;
		const what = [list.fetch && `the student list (${plural(list.requests, 'request')})`, profiles.fetch && plural(profiles.fetch, 'profile')].filter(Boolean);
		const nothing = !what.length;
		return `
			<div class="popover-head"><div class="v">Rescan from the 42 API</div>
				<div class="field-hint">Nothing already fetched is removed.</div></div>
			<div class="rs-opts">
				<label class="switch rs-opt ${list.available ? '' : 'disabled'}"><input type="checkbox" data-bind="rs-students" ${o.students && list.available ? 'checked' : ''} ${list.available ? '' : 'disabled'}><span class="track"></span>
					<span><b>Student list</b><small>${listDesc}</small></span></label>
				<label class="switch rs-opt"><input type="checkbox" data-bind="rs-profiles" ${o.profiles ? 'checked' : ''}><span class="track"></span>
					<span><b>Profiles</b> <span class="muted">exams, projects, cursus</span><small>${profDesc}</small></span></label>
				<label class="switch rs-opt rs-force"><input type="checkbox" data-bind="rs-force" ${o.force ? 'checked' : ''}><span class="track"></span>
					<span><b>Force</b><small>Fetch everything selected again, even what was fetched in the last ${hours}h. Without it, only what is missing or older than ${hours}h is fetched.</small></span></label>
			</div>
			<div class="rs-foot">
				<span class="field-hint">${nothing ? (o.students || o.profiles ? `Everything is up to date — turn on <b>Force</b> to fetch it anyway` : 'Select what to fetch') : `Fetches ${what.join(' and ')} · ${apiEstimate(plan.requests)}`}</span>
				<button class="btn btn-primary btn-sm" data-act="rescan-go" ${nothing ? 'disabled' : ''}><i class="fa fa-refresh"></i>Rescan</button>
			</div>`;
	}

	function openRescanMenu(anchor) {
		closeMenu();
		S.rescanOpen = true;
		S.rescan.force = false;
		const pop = $('#popover');
		pop.classList.add('popover-wide');
		pop.innerHTML = renderRescanMenu();
		placePopover(anchor);
	}

	function startRescan() {
		const plan = rescanPlan();
		if (!plan.requests) return;
		const opts = { students: plan.list.fetch, profiles: S.rescan.profiles, force: S.rescan.force };
		closeMenu();
		const pending = clonePairs(S.staged);
		// profiles only exist with a full scan
		if (opts.profiles && !S.meta.fullscan) {
			setParam(S.applied, 'fullscan', '');
			setParam(pending, 'fullscan', '');
			syncUrl(true);
		}
		load({ rescan: opts, keepStaged: pending });
	}

	function reportRescan(r) {
		if (!r) return;
		if (r.studentsError) toast(`Couldn't fetch the student list: ${esc(r.studentsError)}`, null, 7000);
		const parts = [];
		if (r.students) {
			parts.push(r.students.skipped
				? 'student list already up to date'
				: `${plural(r.students.count, 'student')} in the list${r.students.kept ? ` (+${fmtNum(r.students.kept)} older kept)` : ''}`);
		}
		if (r.profiles) {
			parts.push(r.profiles.fetched || r.profiles.failed ? `${plural(r.profiles.fetched, 'profile')} fetched again` : 'every profile already up to date');
			if (r.profiles.failed) parts.push(`${fmtNum(r.profiles.failed)} failed`);
		}
		if (parts.length) toast(`Rescan done: ${parts.join(', ')}`, null, 6000);
	}

	const entrySig = (r) => `${r.u.id}|${r.name}|${r.occ}`;
	const entryVal = (r) => `${r.mark}|${r.ok}|${r.status}`;

	function snapshotSigs() {
		const m = new Map();
		for (const r of S.entries[S.view] || []) m.set(entrySig(r), entryVal(r));
		return m;
	}

	function diffSigs(before) {
		const changed = new Set();
		for (const r of S.entries[S.view] || []) {
			const sig = entrySig(r);
			if (!before.has(sig) || before.get(sig) !== entryVal(r)) changed.add(sig);
		}
		return changed;
	}

	const monitorActive = () => (S.view === 'exams' || S.view === 'projects') && !!S.meta?.fullscan;

	async function monitorTick() {
		const mon = S.monitor;
		if (!mon.on || mon.ticking || !monitorActive() || document.hidden) return;
		mon.ticking = true;
		renderMonitorBar();
		const before = snapshotSigs();
		try {
			await load({ rescan: { students: false, profiles: true, force: false }, silent: true });
			mon.changed = diffSigs(before);
			mon.lastTick = Date.now();
			mon.lastError = null;
			renderView();
			if (mon.changed.size) toast(`${plural(mon.changed.size, 'change')} since last check`, null, 4000);
		} catch (e) {
			mon.lastError = e.message || String(e);
		} finally {
			mon.ticking = false;
			renderMonitorBar();
		}
	}

	function monitorReschedule() {
		const mon = S.monitor;
		clearInterval(mon.timer);
		mon.timer = mon.on ? setInterval(monitorTick, mon.interval * 1000) : null;
	}

	function setMonitorOn(on) {
		const mon = S.monitor;
		mon.on = on;
		mon.lastError = null;
		if (!on) mon.changed = new Set();
		monitorReschedule();
		renderMonitorBar();
		if (on) monitorTick();
	}

	function setMonitorInterval(seconds) {
		S.monitor.interval = seconds;
		store.set('monitorInterval', seconds);
		monitorReschedule();
		renderMonitorBar();
	}

	document.addEventListener('visibilitychange', () => {
		if (!document.hidden && S.monitor.on && monitorActive()) monitorTick();
	});

	function renderMonitorBar() {
		const el = $('#monitor-bar');
		if (el) el.outerHTML = monitorBarHtml(S.view);
	}

	function renderStudents() {
		const m = S.meta;
		const list = visibleStudents();
		const size = S.pageSize[S.display];
		S.page = clampPage(S.page, list.length, size);
		const slice = list.slice((S.page - 1) * size, S.page * size);
		const sub = S.q
			? `${plural(list.length, 'match', 'matches')} for “${esc(S.q)}” · ${fmtNum(m.count)} filtered · ${fmtNum(m.total)} in campus`
			: `${fmtNum(m.count)} of ${fmtNum(m.total)} in campus`;

		const toolbar = `
			<div class="toolbar">
				<div class="toolbar-title"><h1>Students</h1><span class="sub">${sub}</span></div>
				<label class="toolbar-group"><span class="label">Sort</span>
					<select class="select select-sm" data-bind="sort-key">${sortOptions()}</select>
					<button class="btn btn-sm icon-btn" data-act="sort-dir" title="${S.sort.dir === 'desc' ? 'Descending' : 'Ascending'}" ${S.sort.key ? '' : 'disabled'}>
						<i class="fa fa-sort-amount-${S.sort.dir === 'desc' ? 'desc' : 'asc'}"></i>
					</button>
				</label>
				${m.fullscan ? stageSwitch() : ''}
				${rescanButton()}
				<button class="btn btn-sm" data-act="ex-open" title="Export these students as CSV or JSON (E)" ${list.length ? '' : 'disabled'}><i class="fa fa-download"></i>Export</button>
				<div class="segmented" role="group" aria-label="Display">
					<button class="${S.display === 'grid' ? 'active' : ''}" data-act="display" data-display="grid" title="Cards (G)"><i class="fa fa-th-large"></i>Cards</button>
					<button class="${S.display === 'table' ? 'active' : ''}" data-act="display" data-display="table" title="Detailed list (G)"><i class="fa fa-list"></i>List</button>
				</div>
			</div>`;

		if (!list.length) {
			return toolbar + `
				<div class="empty"><i class="fa fa-user-times"></i><h3>No students match</h3>
					<p>${S.q ? 'Try a different search, or ' : ''}loosen the filters.</p>
					<div class="actions">
						${S.q ? '<button class="btn btn-sm" data-act="clear-q">Clear search</button>' : ''}
						${S.applied.length ? '<button class="btn btn-sm" data-act="clear-all">Clear filters</button>' : ''}
					</div>
				</div>`;
		}
		const body = S.display === 'grid' ? renderCards(slice) : renderStudentTable(slice);
		return toolbar + body + pager('students', list.length, S.page, size, S.display === 'grid' ? [24, 48, 96, 192] : [25, 50, 100]);
	}

	function poolText(u) {
		if (!u.pool_month && !u.pool_year) return '—';
		return `${fv('pool_month', u.pool_month, esc(humanize(u.pool_month)))} ${fv('pool_year', u.pool_year)}`;
	}

	/** " · piscine ends in 3 weeks" for students whose current cursus is a piscine. */
	function piscineEnd(u) {
		const c = (u.cursus_users || []).find((x) => x.cursus?.kind === 'piscine' && x.end_at && daysUntil(x.end_at) > 0);
		return c ? ` · <span title="${esc(fmtDateTime(c.end_at))}">piscine ends ${esc(fmtRel(c.end_at))}</span>` : '';
	}

	function renderCards(list) {
		const fullscan = S.meta.fullscan;
		return `<div class="grid-cards">${list.map((u) => {
			const exams = fullscan ? bestByName(u._exams.filter((e) => u._matched.has(e.id))) : [];
			const shown = exams.slice(0, 3);
			return `
				<article class="card" data-act="open" data-id="${u.id}">
					<div class="card-media photo" ${zoomAttrs(u)}>
						${photo(u)}
						<div class="overlay-top">
							${u.location ? `<span class="badge online"><span class="dot online"></span>${esc(u.location)}</span>` : '<span></span>'}
							${u.kind && u.kind !== 'student' ? `<span class="badge">${esc(u.kind)}</span>` : ''}
						</div>
					</div>
					<div class="card-body">
						<div class="card-name">
							<span class="login">${fv('login', u.login)}</span>
							<span class="display" title="${esc(u.displayname)}">${esc(u.displayname)}</span>
							<a class="card-link" href="${esc(intraUrl(u.login))}" target="_blank" rel="noreferrer" title="Open intra profile"><i class="fa fa-external-link"></i></a>
						</div>
						<div class="card-meta text-2"><i class="fa fa-calendar-o muted"></i>&nbsp;${poolText(u)}${fullscan ? `<span style="margin-left:auto">${stageBadge(u)}</span>` : ''}</div>
						<div class="card-stats">
							<div><div class="k">Level</div><div class="v">${fullscan ? fv('level', u.level, fmtNum(u.level, 2)) : '<span class="muted">—</span>'}</div></div>
							<div><div class="k">Wallet</div><div class="v">${fv('wallet', u.wallet, fmtNum(u.wallet))}</div></div>
							<div><div class="k">Evals</div><div class="v">${fv('correction_point', u.correction_point, fmtNum(u.correction_point))}</div></div>
							<div><div class="k">Exams</div><div class="v">${fullscan && isNum(u.average_exam_final_mark) ? fmtNum(u.average_exam_final_mark, 1) : '<span class="muted">—</span>'}</div></div>
						</div>
						${shown.length ? `
							<div class="card-exams">
								${shown.map((x) => `<div class="row"><span class="name">${fvEntry('exams', x.name)}</span>${markPill(x.best.final_mark, x.best['validated?'])}</div>`).join('')}
								${exams.length > 3 ? `<span class="more">+${exams.length - 3} more exams</span>` : ''}
							</div>` : ''}
					</div>
				</article>`;
		}).join('')}</div>`;
	}

	const LIST_SORTS = [
		['level', 'Level'], ['wallet', 'Wallet'], ['correction_point', 'Evals'],
		['average_exam_final_mark', 'Exam avg'], ['average_project_final_mark', 'Project avg'], ['cpiscine_final_mark', 'C Piscine'],
	];

	function sortChip(key, label) {
		const active = S.sort.key === key;
		const icon = active ? (S.sort.dir === 'desc' ? 'fa-sort-desc' : 'fa-sort-asc') : 'fa-sort';
		return `<button class="sort-chip ${active ? 'active' : ''}" data-act="th-sort" data-scope="students" data-key="${key}">${esc(label)}<i class="fa ${icon}"></i></button>`;
	}

	function levelStat(u) {
		if (!isNum(u.level)) return '<span class="muted">—</span>';
		const pct = Math.round((u.level % 1) * 100);
		return `<span class="lvl-cell">${fv('level', u.level, fmtNum(u.level, 2))}<span class="lvl-bar" title="${pct}% to level ${Math.floor(u.level) + 1}"><i style="width:${pct}%"></i></span></span>`;
	}

	function entryChip(kind, e) {
		const ok = e['validated?'];
		const cls = ok === true ? 'ok' : ok === false ? 'bad' : '';
		return `<span class="echip ${cls}">${fvEntry(kind, e.project?.name || e.project?.slug)}<b>${isNum(e.final_mark) ? e.final_mark : '—'}</b></span>`;
	}

	function renderWork(u) {
		if (!S.meta.fullscan || !Array.isArray(u.all_projects)) {
			return `<div class="srow-placeholder"><i class="fa fa-bolt"></i>Exams and projects appear after a full scan</div>`;
		}
		const exams = bestByName(u._exams.filter((e) => u._matched.has(e.id)))
			.sort((a, b) => String(b.best.marked_at || '').localeCompare(String(a.best.marked_at || '')));
		const projects = u._projects;
		const passed = projects.filter((e) => e['validated?'] === true).length;
		const recent = sortBy(projects, (e) => e.marked_at || e.updated_at, 'desc').slice(0, 4);
		const pct = projects.length ? Math.round(passed / projects.length * 100) : 0;
		return `
			<div class="work-block">
				<div class="work-head"><span>Exams</span><span class="muted">${fmtNum(u.exams_passed ?? 0)} passed · ${plural(u._exams.length, 'attempt')}</span></div>
				<div class="echips">${exams.length ? exams.slice(0, 6).map((x) => entryChip('exams', x.best)).join('') + (exams.length > 6 ? `<span class="echip more">+${exams.length - 6}</span>` : '') : '<span class="muted">No exams</span>'}</div>
			</div>
			<div class="work-block">
				<div class="work-head"><span>Projects</span><span class="muted">${fmtNum(passed)} / ${fmtNum(projects.length)} passed</span><span class="work-bar"><i style="width:${pct}%"></i></span></div>
				<div class="echips">${recent.length ? recent.map((e) => entryChip('projects', e)).join('') : '<span class="muted">No projects</span>'}</div>
			</div>`;
	}

	function renderStudentTable(list) {
		const fullscan = S.meta.fullscan;
		const stat = (k, v) => `<div class="mstat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
		const dash = '<span class="muted">—</span>';
		return `
			<div class="rlist">
				<div class="rlist-head">
					<div class="h-student">${sortChip('login', 'Student')}${sortChip('pool', 'Pool')}${sortChip('created_at', 'Joined')}</div>
					<div class="h-stats">${LIST_SORTS.map(([k, l]) => sortChip(k, l)).join('')}</div>
					<div class="h-work">${fullscan ? sortChip('exams_passed', 'Exams passed') + sortChip('projects_passed', 'Projects passed') : ''}</div>
				</div>
				${list.map((u) => {
					return `
						<article class="srow" data-act="open" data-id="${u.id}">
							<div class="srow-photo photo" ${zoomAttrs(u)}>
								${photo(u)}
								${u.location ? '<span class="dot online"></span>' : ''}
							</div>
							<div class="srow-id">
								<div class="srow-title">
									<span class="login">${fv('login', u.login)}</span>
									${u.location ? `<span class="badge ok">${fv('location', u.location)}</span>` : ''}
								</div>
								<div class="display" title="${esc(u.displayname)}">${esc(u.displayname)}</div>
								<div class="contact">${u.email ? mailLink(u.email) + fv('email', u.email) : '<span class="muted">No email</span>'}</div>
								<div class="badges">
									${fullscan ? stageBadge(u) : ''}
									${u.pool_year ? `<span class="badge"><i class="fa fa-calendar-o"></i>${poolText(u)}</span>` : ''}
									${u.kind && u.kind !== 'student' ? `<span class="badge info">${fv('kind', u.kind)}</span>` : ''}
									${u['staff?'] ? '<span class="badge warn">Staff</span>' : ''}
									${u['alumni?'] ? '<span class="badge info">Alumni</span>' : ''}
								</div>
								<div class="dates"><span title="${esc(fmtDateTime(u.created_at))}">Joined ${esc(fmtRel(u.created_at))}</span> · <span title="${esc(fmtDateTime(u.updated_at))}">updated ${esc(fmtRel(u.updated_at))}</span>${S.meta.fullscan ? piscineEnd(u) : ''}</div>
							</div>
							<div class="srow-stats">
								${stat('Level', fullscan ? levelStat(u) : dash)}
								${stat('Wallet', fv('wallet', u.wallet, fmtNum(u.wallet)) + '<small>₳</small>')}
								${stat('Evals', fv('correction_point', u.correction_point, fmtNum(u.correction_point)))}
								${stat('Exam avg', isNum(u.average_exam_final_mark) ? fv('average_exam_final_mark', u.average_exam_final_mark, fmtNum(u.average_exam_final_mark, 1)) : dash)}
								${stat('Project avg', isNum(u.average_project_final_mark) ? fv('average_project_final_mark', u.average_project_final_mark, fmtNum(u.average_project_final_mark, 1)) : dash)}
								${stat('C Piscine', isNum(u.cpiscine_final_mark) ? fv('cpiscine_final_mark', u.cpiscine_final_mark, markPill(u.cpiscine_final_mark, u.cpiscine_final_mark >= 50)) : dash)}
							</div>
							<div class="srow-work">${renderWork(u)}</div>
							<div class="srow-actions">
								<a class="btn btn-ghost btn-sm icon-btn" href="${esc(intraUrl(u.login))}" target="_blank" rel="noreferrer" title="Open intra profile"><i class="fa fa-external-link"></i></a>
								<span class="btn btn-ghost btn-sm icon-btn" title="Details"><i class="fa fa-chevron-right"></i></span>
							</div>
						</article>`;
				}).join('')}
			</div>`;
	}

	/* ---------- Exams / projects explorer ---------- */

	/* ---------- Lazy profile fetching ---------- */

	let lastInput = 0;
	for (const type of ['pointerdown', 'keydown', 'wheel', 'scroll', 'input']) {
		document.addEventListener(type, () => { lastInput = Date.now(); }, { passive: true, capture: true });
	}

	/** Students whose profile is missing and worth fetching for what is on screen. */
	function lazyTargets() {
		if (!S.meta || S.meta.error || S.meta.fetching) return [];
		const out = [];
		if (S.drawer.id !== null && S.byId.has(S.drawer.id)) out.push(S.byId.get(S.drawer.id));
		if (S.view === 'students') {
			const size = S.pageSize[S.display];
			out.push(...visibleStudents().slice((S.page - 1) * size, S.page * size));
		} else if (S.view === 'cursus' || S.view === 'graph') {
			const all = visibleStudents();
			if (all.length <= LAZY_MAX_VIEW) out.push(...all);
		}
		return [...new Set(out)].filter((u) => !hasProfile(u) && !LZ.failed.has(u.id) && !LZ.stash[u.id]);
	}

	function renderAutoFetch() {
		const b = $('#btn-autofetch');
		if (!b) return;
		b.classList.toggle('active', LZ.on);
		const label = !LZ.on ? 'Auto-fetch off' : LZ.busy || LZ.left ? `Fetching ${fmtNum(LZ.left)}…` : 'Auto-fetch';
		const html = `${LZ.busy ? '<span class="spinner spinner-sm"></span>' : '<i class="fa fa-bolt"></i>'}<span>${label}</span>`;
		if (b.innerHTML !== html) b.innerHTML = html;
		b.title = LZ.on
			? 'Profiles of the students on screen are fetched from the 42 API in the background. Click to pause.'
			: 'Auto-fetch is paused. Click to fetch the profiles of the students on screen as you browse.';
	}

	function scheduleLazy(delay = 500) {
		clearTimeout(LZ.timer);
		if (!LZ.on || LZ.busy) { renderAutoFetch(); return; }
		LZ.timer = setTimeout(lazyStep, delay);
		LZ.left = lazyTargets().length;
		renderAutoFetch();
	}

	/** Adds freshly fetched profiles (already enriched by the server) to the students on screen. */
	function mergeProfiles(profiles) {
		const n = Object.keys(profiles).length;
		if (!n) return;
		S.students = S.students.map((u) => (profiles[u.id] ? { ...u, ...profiles[u.id] } : u));
		S.meta.fullscan = true;
		S.meta.cachedCount = (S.meta.cachedCount || 0) + n;
		S.meta.unfetchedCount = Math.max(0, (S.meta.unfetchedCount || 0) - n);
		ingest({ meta: S.meta, students: S.students });
		graphCache = null;
		renderTabs();
		renderNotices();
		keepFocus(renderView);
		if (S.drawer.id !== null && S.byId.has(S.drawer.id)) renderDrawer();
	}

	/** Shows the stashed profiles once the user stops interacting, so the page never jumps under their hands. */
	function flushStash() {
		clearTimeout(LZ.flushTimer);
		if (!Object.keys(LZ.stash).length) return;
		const wait = 1200 - (Date.now() - lastInput);
		if (wait > 0 || document.hidden) { LZ.flushTimer = setTimeout(flushStash, Math.max(wait, 400)); return; }
		const profiles = LZ.stash;
		LZ.stash = {};
		mergeProfiles(profiles);
		scheduleLazy(200);
	}

	async function lazyStep() {
		if (!LZ.on || LZ.busy || document.hidden) return;
		const targets = lazyTargets();
		LZ.left = targets.length;
		if (!targets.length) { renderAutoFetch(); return; }
		LZ.busy = true;
		renderAutoFetch();
		const loadedKey = S.loadedKey;
		try {
			const res = await postJson('/api/profiles/fetch', { ids: targets.slice(0, LAZY_BATCH).map((u) => u.id) });
			if (S.loadedKey !== loadedKey) return;
			if (res.busy) { LZ.timer = setTimeout(lazyStep, 3000); return; }
			for (const id of res.failed) LZ.failed.add(Number(id));
			Object.assign(LZ.stash, res.profiles);
		} catch (e) {
			console.error(e);
			LZ.on = false;
			store.set('autoFetch', false);
			toast(`Auto-fetch paused: ${esc(e.message)}`, null, 6000);
		} finally {
			LZ.busy = false;
			flushStash();
			scheduleLazy(300);
		}
	}

	function setAutoFetch(on) {
		LZ.on = on;
		store.set('autoFetch', on);
		if (on) LZ.failed.clear();
		scheduleLazy(100);
	}

	document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleLazy(300); });

	/** "1,128 / 2,095 profiles": how much of what is listed has its profile, and what can be done about it. */
	function coverage() {
		if (!S.meta?.fullscan && !S.meta?.unfetchedCount) return '';
		const list = visibleStudents();
		const missing = list.filter((u) => !hasProfile(u)).length;
		if (!missing) return '';
		const reach = S.view === 'students' || list.length <= LAZY_MAX_VIEW;
		const text = `${fmtNum(list.length - missing)} / ${fmtNum(list.length)} profiles`;
		const hint = !reach ? `<button class="link" data-act="fullscan-on">too many to load while browsing: narrow the list or run a full scan</button>`
			: LZ.on ? '<span class="muted">loading as you browse</span>' : '<button class="link" data-act="autofetch">resume auto-fetch</button>';
		return `<span class="coverage"><i class="fa fa-database"></i>${text} · ${hint}</span>`;
	}

	/* ---------- Cursus tracker ---------- */

	const CURSUS_STATUS = {
		active: { label: 'Active', cls: 'ok', hint: 'In the 42cursus, not blackholed' },
		blackholed: { label: 'Blackholed', cls: 'bad', hint: 'The cursus ended at the blackhole' },
		left: { label: 'Left', cls: '', hint: 'The cursus ended before the blackhole' },
		upcoming: { label: 'Starts soon', cls: 'info', hint: 'Common core not started yet' },
	};
	const CURSUS_TABS = [['active', 'Active'], ['upcoming', 'Starts soon'], ['blackholed', 'Blackholed']];
	const CURSUS_SORT = {
		login: (u) => u.login.toLowerCase(), level: (u) => u.level, pool: (u) => u.pool,
		date: (u) => cursusDate(u),
	};
	const cursusRows = () => visibleStudents().filter((u) => ['active', 'upcoming', 'blackholed'].includes(u.cursus_status));
	/** The date shown for a status: when the cursus starts, started, or ended. */
	const cursusDate = (u) => (u.cursus_status === 'upcoming' ? u.cursus_start : u.cursus_status === 'active' ? (u._begin ? new Date(u._begin).toISOString() : null) : u.cursus_end);

	function cursusBadge(u) {
		const st = CURSUS_STATUS[u.cursus_status];
		return st ? `<span class="badge ${st.cls}" title="${esc(st.hint)}">${esc(st.label)}</span>` : '';
	}

	function renderCursusView() {
		const C = S.cursus;
		const all = cursusRows();
		const rows = sortBy(all.filter((u) => u.cursus_status === C.status), CURSUS_SORT[C.sort.key] || CURSUS_SORT.date, C.sort.dir);
		const size = S.pageSize.cursus;
		C.page = clampPage(C.page, rows.length, size);
		const slice = rows.slice((C.page - 1) * size, C.page * size);
		const tabs = CURSUS_TABS.map(([k, label]) => `<button class="${C.status === k ? 'active' : ''}" data-act="co-filter" data-status="${k}">${label} <span class="num muted">${fmtNum(all.filter((u) => u.cursus_status === k).length)}</span></button>`).join('');
		const sh = (key, label, cls) => sortHeader('cursus', key, label, C.sort, cls);
		const dateLabel = { active: 'Started', upcoming: 'Starts', blackholed: 'Absorbed' }[C.status];
		return `
			<div class="toolbar">
				<div class="toolbar-title"><h1>Cursus</h1>${coverage()}</div>
				<div class="segmented" role="group" aria-label="Status">${tabs}</div>
			</div>
			${!rows.length ? `<div class="empty"><i class="fa fa-hourglass-o"></i><h3>Nobody here</h3><p>${all.length ? 'Nobody has this status.' : 'Cursus data comes with the profiles: they load as you browse, or with a full scan.'}</p></div>` : `
			<div class="table-wrap">
				<table class="data">
					<thead><tr>
						${sh('login', 'Student')}<th>Status</th>${sh('date', dateLabel)}${sh('pool', 'Pool')}${sh('level', 'Level')}
					</tr></thead>
					<tbody>
						${slice.map((u) => `
							<tr class="clickable" data-act="open" data-id="${u.id}">
								<td class="student-cell"><div class="who">${entryThumb(u)}<span class="names"><span class="login">${esc(u.login)}</span><span class="display">${esc(u.displayname)}</span></span></div></td>
								<td>${cursusBadge(u)}</td>
								<td>${dateRel(cursusDate(u))}</td>
								<td>${poolText(u)}</td>
								<td>${isNum(u.level) ? fmtNum(u.level, 2) : '—'}</td>
							</tr>`).join('')}
					</tbody>
				</table>
			</div>
			${pager('cursus', rows.length, C.page, size, [25, 50, 100, 250])}`}`;
	}
	/* ---------- Project graph ---------- */

	const SEARCHING = ['searching_a_group', 'creating_group', 'waiting_to_start'];
	const GRAPH = { firstR: 140, stepR: 110, margin: 70 };
	const RANK_EXAM = /^exam rank (\d+)/i;
	const SERIES = /^(.*\S)\s+(\d{1,2})$/;
	const projectKey = (p) => String(p.name || p.slug || '').trim().toLowerCase();

	/** The best attempt of a student on each main-cursus project: project key -> { p, e, state, at }. */
	function projectStates(u) {
		const mine = new Map();
		for (const e of u.all_projects || []) {
			const p = e.project;
			if (!p?.id || (e.status === 'parent' && !e['validated?'])) continue;
			if (!(e.cursus_ids || []).some((c) => MAIN_CURSUS.has(c))) continue;
			const state = e['validated?'] ? 'done' : SEARCHING.includes(e.status) ? 'searching' : ACTIVE_STATUSES.includes(e.status) ? 'working' : 'failed';
			const rank = { done: 3, working: 2, searching: 2, failed: 1 }[state];
			const at = Date.parse(e.created_at) || 0;
			const key = projectKey(p);
			const prev = mine.get(key);
			if (!prev || rank > prev.rank || (rank === prev.rank && at > prev.at)) mine.set(key, { p, e, state, rank, at, done: Date.parse(e.marked_at) || at });
		}
		return mine;
	}

	const median = (xs) => {
		if (!xs.length) return null;
		const s = [...xs].sort((a, b) => a - b);
		return s[Math.floor(s.length / 2)];
	};

	let graphCache = null;

	/**
	 * The curriculum as the students lived it. The intra's graph isn't exposed by the 42 API, so the layout
	 * is rebuilt from the data: the rank of a project is how many "Exam Rank" a student had validated when
	 * starting it, and a link joins a project to the one students most often start next.
	 */
	function graphModel() {
		const list = visibleStudents();
		const key = S.graph.minPeople;
		if (graphCache && graphCache.src === list && graphCache.key === key) return graphCache.model;
		const nodes = new Map();
		const trails = [];
		let profiled = 0;
		for (const u of list) {
			if (!hasProfile(u)) continue;
			const mine = projectStates(u);
			if (!mine.size) continue;
			profiled++;
			const examDone = [...mine.entries()].filter(([k, x]) => RANK_EXAM.test(k) && x.state === 'done').map(([k, x]) => [Number(k.match(RANK_EXAM)[1]), x.done]);
			for (const [k, x] of mine) {
				let n = nodes.get(k);
				if (!n) nodes.set(k, n = { id: k, name: x.p.name || x.p.slug, exam: RANK_EXAM.test(k), people: [], ranks: [], offsets: [], done: 0, working: 0, searching: 0, failed: 0 });
				n.people.push({ u, e: x.e, state: x.state });
				n[x.state]++;
				const before = new Set(examDone.filter(([num, at]) => at < x.at && num !== Number((k.match(RANK_EXAM) || [])[1])).map(([num]) => num));
				n.ranks.push(before.size);
				if (u._begin && x.at) n.offsets.push((x.at - u._begin) / 86400000);
			}
			trails.push([...mine.entries()].sort((a, b) => a[1].at - b[1].at).map(([k]) => k));
		}
		const kept = [...nodes.values()].filter((n) => n.people.length >= key);
		for (const n of kept) { n.med = median(n.offsets); n.rank = n.exam ? Math.max(0, Number(n.id.match(RANK_EXAM)[1]) - 2) : median(n.ranks) ?? 0; }
		const byKey = new Map(kept.map((n) => [n.id, n]));

		// numbered series of the same rank ("Python Module 00..10") become one cluster
		const series = new Map();
		for (const n of kept) {
			const m = !n.exam && n.name.match(SERIES);
			if (!m) continue;
			const gk = `${n.rank}|${m[1].toLowerCase()}`;
			if (!series.has(gk)) series.set(gk, { label: m[1], rank: n.rank, members: [] });
			series.get(gk).members.push(n);
		}
		const grouped = new Map();
		const items = [];
		for (const g of series.values()) {
			if (g.members.length < 3) continue;
			g.members.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
			const cluster = { id: 'g:' + g.label.toLowerCase(), group: true, name: g.label, members: g.members, rank: g.rank, med: median(g.members.map((n) => n.med).filter(isNum)), exam: false };
			items.push(cluster);
			for (const n of g.members) grouped.set(n.id, cluster);
		}
		for (const n of kept) if (!grouped.has(n.id)) items.push(n);

		// concentric rings, like the intra's graph: the centre is the project everybody starts with, then one ring per rank
		const centre = items.filter((n) => n.rank === 0 && !n.group).sort((a, b) => b.people.length - a.people.length)[0];
		const rings = new Map();
		for (const n of items) {
			n.ring = n === centre ? 0 : n.rank + 1;
			if (!rings.has(n.ring)) rings.set(n.ring, []);
			rings.get(n.ring).push(n);
		}
		const ringR = (i) => (i === 0 ? 0 : GRAPH.firstR + (i - 1) * GRAPH.stepR);
		const maxRing = Math.max(0, ...rings.keys());
		const extent = ringR(maxRing) + GRAPH.margin;
		for (const [i, list] of rings) {
			list.sort((a, b) => (a.exam - b.exam) || ((a.med ?? 1e9) - (b.med ?? 1e9)) || a.name.localeCompare(b.name));
			list.forEach((n, j) => {
				const angle = -Math.PI / 2 + i * 0.55 + (j / list.length) * Math.PI * 2;
				n.cx = extent + ringR(i) * Math.cos(angle);
				n.cy = extent + ringR(i) * Math.sin(angle);
				if (n.group) {
					const k = n.members.length;
					const r = k > 1 ? 16 + k * 3 : 0;
					n.members.forEach((m, mi) => {
						const a = (mi / k) * Math.PI * 2 - Math.PI / 2;
						m.cx = n.cx + r * Math.cos(a);
						m.cy = n.cy + r * Math.sin(a);
						m.parent = n;
						m.ring = n.ring;
					});
					n.r = r + 12;
				}
			});
		}
		const at = (id) => grouped.get(id) || byKey.get(id);

		const pair = new Map();
		for (const t of trails) {
			const seq = t.filter((id) => byKey.has(id)).map((id) => at(id).id).filter((id, i, a) => id !== a[i - 1]);
			for (let i = 0; i < seq.length - 1; i++) {
				const k = seq[i] + '\u0000' + seq[i + 1];
				pair.set(k, (pair.get(k) || 0) + 1);
			}
		}
		const idx = new Map(items.map((n) => [n.id, n]));
		const outgoing = new Map();
		for (const [k, count] of pair) {
			const [a, b] = k.split('\u0000').map((id) => idx.get(id));
			if (!a || !b || b.ring <= a.ring || count < 3 || count < 0.3 * Math.min(a.people?.length ?? count * 4, b.people?.length ?? count * 4)) continue;
			if (!outgoing.has(a.id)) outgoing.set(a.id, []);
			outgoing.get(a.id).push({ a, b, count });
		}
		const edges = [...outgoing.values()].flatMap((l) => l.sort((x, y) => y.count - x.count).slice(0, 2));
		const model = {
			nodes: kept, items, byKey, edges, profiled, extent,
			rings: [...rings.keys()].filter((i) => i > 0).sort((a, b) => a - b).map((i) => ({ ring: i, r: ringR(i) })),
			size: extent * 2,
		};
		graphCache = { src: list, key, model };
		return model;
	}

	const graphMe = () => {
		const q = S.graph.me.trim().toLowerCase();
		return q ? S.students.find((u) => u.login.toLowerCase() === q) || null : null;
	};

	/** Level distance to the viewer, to put the people of similar progress first. */
	const levelGap = (u, me) => (me && isNum(u.level) && isNum(me.level) ? u.level - me.level : null);

	function personRow(p, me, node) {
		const u = p.u;
		const gap = levelGap(u, me);
		const others = [...new Set(u._now.map((e) => e.project?.name).filter((n) => n && n !== node.name))];
		return `
			<button class="gperson" data-act="open" data-id="${u.id}">
				${avatar(u)}
				<span class="who"><b>${esc(u.login)}</b><small>${others.length ? 'also on ' + esc(others.slice(0, 2).join(', ')) : esc(u.displayname || '')}</small></span>
				<span class="meta">
					${isNum(u.level) ? `<span class="num" title="Level">${fmtNum(u.level, 2)}</span>` : ''}
					${gap !== null ? `<span class="gap ${Math.abs(gap) <= 1 ? 'near' : ''}" title="Level difference with you">${gap > 0 ? '+' : ''}${fmtNum(gap, 1)}</span>` : ''}
				</span>
			</button>`;
	}

	function renderGraphPanel(model, me, mine) {
		const G = S.graph;
		const sel = G.sel && (model.byKey.get(G.sel) || model.items.find((n) => n.id === G.sel));
		const node = sel && !sel.group ? sel : null;
		if (sel?.group) {
			return `
				<div class="gpanel-head"><h3>${esc(sel.name)}</h3><button class="btn btn-ghost btn-xs icon-btn" data-act="graph-node" data-pid="" title="Close"><i class="fa fa-times"></i></button></div>
				<p class="field-hint">${fmtNum(sel.members.length)} projects, one rank. Pick one:</p>
				<div class="gmembers">${sel.members.map((m) => `
					<button class="gmember ${mine.get(m.id) ? 'me-' + mine.get(m.id).state : ''}" data-act="graph-node" data-pid="${esc(m.id)}">
						<span>${esc(m.name)}</span><small>${fmtNum(m.done)} done · ${fmtNum(m.working + m.searching)} on it</small></button>`).join('')}</div>`;
		}
		if (!node) {
			return `<div class="gpanel-empty"><i class="fa fa-hand-pointer-o"></i><p>Pick a project to see who is on it, who needs a team and who already validated it.</p>
				<p class="field-hint">${me ? '' : 'Enter your login above to see where you stand and sort people by how close their level is to yours.'}</p></div>`;
		}
		const people = node.people.filter((p) => !G.onlyActive || p.u.cursus_status === 'active');
		const order = (list) => sortBy(list, (p) => (me && isNum(p.u.level) && isNum(me.level) ? Math.abs(p.u.level - me.level) : -(p.u.level ?? -1)), 'asc');
		const section = (state, title, icon, empty) => {
			const list = order(people.filter((p) => p.state === state));
			const open = G.show[state];
			return `
				<section class="gsection">
					<h4><i class="fa fa-${icon}"></i>${title} <span class="muted">${fmtNum(list.length)}</span></h4>
					${list.length ? list.slice(0, open ? 400 : 6).map((p) => personRow(p, me, node)).join('') : `<p class="field-hint">${empty}</p>`}
					${list.length > 6 ? `<button class="btn btn-ghost btn-xs" data-act="graph-more" data-state="${state}">${open ? 'Show less' : `Show all ${fmtNum(list.length)}`}</button>` : ''}
				</section>`;
		};
		const parent = node.parent;
		return `
			<div class="gpanel-head">
				<div><h3>${esc(node.name)}</h3>${parent ? `<button class="link" data-act="graph-node" data-pid="${esc(parent.id)}">‹ ${esc(parent.name)}</button>` : ''}</div>
				<button class="btn btn-ghost btn-xs icon-btn" data-act="graph-node" data-pid="" title="Close"><i class="fa fa-times"></i></button>
			</div>
			<div class="gstats-line">
				<span class="badge ok"><i class="fa fa-check"></i>${fmtNum(node.done)} validated</span>
				<span class="badge info"><i class="fa fa-circle"></i>${fmtNum(node.working)} working</span>
				<span class="badge warn"><i class="fa fa-users"></i>${fmtNum(node.searching)} need a team</span>
			</div>
			${section('searching', 'Looking for a team', 'users', 'Nobody is looking for a group right now.')}
			${section('working', 'Working on it', 'circle', 'Nobody is on it right now.')}
			${section('done', 'Validated, can help', 'check', 'Nobody validated it yet.')}`;
	}

	/** Teal: you validated it. White ring: you are on it. Otherwise the fill shows how many students validated it. */
	function nodeClass(n, mine, sel) {
		const m = mine.get(n.id);
		return ['gnode', m ? `me-${m.state}` : '', n.exam ? 'exam' : '', sel === n.id ? 'sel' : ''].filter(Boolean).join(' ');
	}

	function renderGraph() {
		const G = S.graph;
		const model = graphModel();
		const me = graphMe();
		const mine = me ? projectStates(me) : new Map();
		const myDone = [...mine.values()].filter((x) => x.state === 'done').length;
		const logins = S.students.filter((u) => u.cursus_status).map((u) => `<option value="${esc(u.login)}"></option>`).join('');
		const toolbar = `
			<div class="toolbar">
				<div class="toolbar-title"><h1>Project graph</h1>${coverage()}</div>
				<label class="toolbar-group"><span class="label">You</span>
					<input class="input input-sm" list="graph-logins" data-bind="graph-me" value="${esc(G.me)}" placeholder="your login" autocomplete="off" spellcheck="false" style="width:140px">
					<datalist id="graph-logins">${logins}</datalist>
				</label>
				${G.me && !me ? '<span class="warn-text" style="font-size:12px">not in this list</span>' : me ? `<span class="muted" style="font-size:12px">${fmtNum(myDone)} validated${isNum(me.level) ? ' · level ' + fmtNum(me.level, 2) : ''}</span>` : ''}
				<label class="toolbar-group check"><input type="checkbox" data-bind="graph-active" ${G.onlyActive ? 'checked' : ''}><span>Active students only</span></label>
				<div class="segmented" role="group" aria-label="Zoom">
					<button data-act="graph-zoom" data-delta="-0.15" title="Zoom out"><i class="fa fa-minus"></i></button>
					<button data-act="graph-zoom" data-delta="0" title="Fit">Fit</button>
					<button data-act="graph-zoom" data-delta="0.15" title="Zoom in"><i class="fa fa-plus"></i></button>
				</div>
			</div>`;
		if (!model.nodes.length) {
			return `${toolbar}<div class="empty"><i class="fa fa-sitemap"></i><h3>No project data yet</h3>
				<p>The graph is built from the students' projects. They load as you browse, or with a full scan.</p></div>`;
		}
		const focus = G.sel ? new Set([G.sel, model.byKey.get(G.sel)?.parent?.id].filter(Boolean)) : null;
		const ringHtml = model.rings.map((r) => `<circle class="gring" cx="${model.extent}" cy="${model.extent}" r="${r.r}"/>`).join('');
		const edgeHtml = model.edges.map(({ a, b, count }) => {
			const hot = focus && (focus.has(a.id) || focus.has(b.id));
			return `<line class="gedge ${hot ? 'hot' : ''}" x1="${a.cx}" y1="${a.cy}" x2="${b.cx}" y2="${b.cy}"><title>${esc(a.name)} → ${esc(b.name)}: ${count} students</title></line>`;
		}).join('');
		const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
		const dot = (n, r) => {
			const total = n.people.length || 1;
			const p = n.done / total;
			const m = mine.get(n.id);
			// fill opacity: how many validated it; the viewer's own state wins
			const style = m ? '' : `style="--p:${(0.12 + p * 0.55).toFixed(2)}"`;
			return `<g class="${nodeClass(n, mine, G.sel)}" data-act="graph-node" data-pid="${esc(n.id)}" transform="translate(${n.cx} ${n.cy})" ${style}>
				<title>${esc(n.name)} — ${fmtNum(n.done)} validated, ${fmtNum(n.working)} working, ${fmtNum(n.searching)} need a team</title>
				${n.exam ? `<rect x="-32" y="-12" width="64" height="24" rx="12"/>` : `<circle r="${r}"/>`}
				<text y="3">${esc(short(n.name.replace(/^Exam Rank /, 'Rank '), n.exam ? 9 : r > 15 ? 12 : 5))}</text>
				${n.searching ? `<circle class="gpip" cx="${r * 0.75}" cy="${-r * 0.75}" r="5"/>` : ''}
			</g>`;
		};
		const nodeHtml = model.items.map((n) => {
			if (n.group) {
				return `<g class="gcluster ${focus?.has(n.id) ? 'sel' : ''}">
					<circle class="gc-halo" cx="${n.cx}" cy="${n.cy}" r="${n.r}" data-act="graph-node" data-pid="${esc(n.id)}"><title>${esc(n.name)}</title></circle>
					${n.members.map((m) => dot(m, 10)).join('')}
					<text class="gc-label" x="${n.cx}" y="${n.cy + n.r + 11}">${esc(short(n.name, 18))}</text></g>`;
			}
			return dot(n, 30);
		}).join('');
		// zoom 1 fits the whole graph in the viewport
		const px = `calc((100vh - 230px) * ${G.zoom})`;
		return `
			${toolbar}
			<div class="graph-layout">
				<div class="graph-scroll" data-drag>
					<svg class="graph-svg" viewBox="0 0 ${model.size} ${model.size}" style="width:${px};height:${px}">
						${ringHtml}${edgeHtml}${nodeHtml}
					</svg>
				</div>
				<aside class="graph-panel">${renderGraphPanel(model, me, mine)}</aside>
			</div>
			<div class="graph-legend field-hint">
				<span><span class="lg me-done"></span>you validated</span><span><span class="lg me-working"></span>you work on it</span>
				<span><span class="lg shade"></span>otherwise: darker = validated by more students</span><span><span class="lg pip team">&nbsp;</span>someone needs a team</span>
				<span>Rings are ranks, rebuilt from your data (the 42 API doesn't expose the intra's graph): a project sits on the ring matching the exams students had validated when starting it. Scroll or drag to move around.</span>
			</div>`;
	}

	function explorerData(kind) {
		const ex = S.explorer[kind];
		const ids = visibleIds();
		const base = S.entries[kind].filter((r) => ids.has(r.u.id));

		const facetMap = new Map();
		for (const r of base) {
			let f = facetMap.get(r.name);
			if (!f) facetMap.set(r.name, f = { name: r.name, attempts: 0, students: new Set(), pass: 0, graded: 0 });
			f.attempts++;
			f.students.add(r.u.id);
			if (r.ok !== null) { f.graded++; if (r.ok) f.pass++; }
		}
		const facets = [...facetMap.values()].sort((a, b) => b.students.size - a.students.size || a.name.localeCompare(b.name));

		const min = ex.min === '' ? null : Number(ex.min);
		const max = ex.max === '' ? null : Number(ex.max);
		let rows = base.filter((r) =>
			(!ex.sel.size || ex.sel.has(r.name)) &&
			(!ex.status || r.status === ex.status) &&
			(!ex.result || (ex.result === 'passed' ? r.ok === true : ex.result === 'failed' ? r.ok === false : r.ok === null)) &&
			(min === null || (r.mark !== null && r.mark >= min)) &&
			(max === null || (r.mark !== null && r.mark <= max)));

		if (ex.best) {
			const best = new Map();
			for (const r of rows) {
				const k = r.u.id + '|' + r.name;
				const cur = best.get(k);
				if (!cur || (r.mark ?? -1) > (cur.mark ?? -1) || ((r.mark ?? -1) === (cur.mark ?? -1) && (r.date || '') > (cur.date || ''))) best.set(k, r);
			}
			rows = [...best.values()];
		}
		const statuses = [...new Set(base.map((r) => r.status).filter(Boolean))].sort();
		return { base, facets, rows, statuses };
	}

	const EXPLORER_SORT = {
		student: (r) => r.u.login,
		name: (r) => r.name,
		mark: (r) => r.mark,
		result: (r) => r.ok === null ? null : Number(r.ok),
		status: (r) => r.status,
		occ: (r) => r.occ,
		date: (r) => r.date,
	};

	function monitorBarHtml(kind) {
		const mon = S.monitor;
		const ex = S.explorer[kind];
		const { rows } = explorerData(kind);
		const counts = ACTIVE_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]).filter(([, n]) => n > 0);
		const state = mon.ticking ? '<i class="fa fa-refresh fa-spin"></i> checking…'
			: mon.lastError ? `<i class="fa fa-exclamation-triangle"></i> ${esc(mon.lastError)}`
			: mon.on ? (mon.lastTick ? `updated ${esc(fmtRel(new Date(mon.lastTick)))}` : 'waiting…')
			: 'off';
		return `
			<div class="monitor" id="monitor-bar">
				<div class="mon-live">
					<label class="switch" title="Auto-refresh re-fetches these profiles from the 42 API on a timer — uses API quota, so it stays off until you turn it on">
						<input type="checkbox" data-bind="mon-live" ${mon.on ? 'checked' : ''}><span class="track"></span><span>Live</span>
					</label>
					<label class="mon-every">every
						<select class="select select-sm" data-bind="mon-interval" title="Auto-refresh interval">
							${MONITOR_INTERVALS.map((s) => `<option value="${s}" ${mon.interval === s ? 'selected' : ''}>${fmtInterval(s)}</option>`).join('')}
						</select>
					</label>
					<span class="mon-state ${mon.lastError ? 'err' : ''}">${state}</span>
					${mon.changed.size ? `<span class="mon-changed" title="Attempts whose mark or status changed on the last refresh">${plural(mon.changed.size, 'change')}</span>` : ''}
				</div>
				<div class="mon-active">
					<span class="mon-label">Active now</span>
					${counts.length
						? counts.map(([s, n]) => `<button class="mon-chip ${ex.status === s ? 'on' : ''}" data-act="mon-status" data-status="${esc(s)}" title="Filter to ${esc(humanize(s))}">${esc(humanize(s))}<b>${fmtNum(n)}</b></button>`).join('')
						: '<span class="muted">nobody mid-exam or awaiting correction</span>'}
				</div>
			</div>`;
	}

	function renderExplorer(kind) {
		const K = KIND[kind];
		const ex = S.explorer[kind];
		if (!S.meta.fullscan) {
			const m = S.meta;
			const toFetch = Math.max(0, m.count - (m.cachedCount || 0));
			return `
				<div class="empty">
					<i class="fa ${K.icon}"></i>
					<h3>${K.labels} need a full scan</h3>
					<p>${K.labels} come from each student's profile on the 42 API. ${toFetch === 0
						? `All ${plural(m.count, 'student')} in the current result are cached, so it's instant.`
						: `${fmtNum(m.cachedCount || 0)} of ${plural(m.count, 'student')} are cached; ${fmtNum(toFetch)} would be fetched (${apiEstimate(toFetch)}). Profiles are cached for ${m.cacheHours}h.`}</p>
					<div class="actions">
						<button class="btn" data-act="open-filters"><i class="fa fa-sliders"></i>Narrow down first</button>
						<button class="btn btn-primary" data-act="fullscan-on"><i class="fa fa-bolt"></i>Run full scan</button>
					</div>
				</div>`;
		}

		const { base, facets, rows, statuses } = explorerData(kind);
		const fq = ex.facetQ.toLowerCase();
		const facetList = facets.filter((f) => !fq || f.name.toLowerCase().includes(fq));

		const graded = rows.filter((r) => r.ok !== null);
		const marks = rows.map((r) => r.mark).filter(isNum);
		const studentsN = new Set(rows.map((r) => r.u.id)).size;
		const passRate = graded.length ? graded.filter((r) => r.ok).length / graded.length * 100 : null;
		const avg = marks.length ? marks.reduce((a, b) => a + b, 0) / marks.length : null;
		const sortedMarks = [...marks].sort((a, b) => a - b);
		const median = sortedMarks.length
			? (sortedMarks.length % 2 ? sortedMarks[(sortedMarks.length - 1) / 2]
				: (sortedMarks[sortedMarks.length / 2 - 1] + sortedMarks[sortedMarks.length / 2]) / 2)
			: null;
		const now = Date.now();
		const since = (ms) => rows.filter((r) => { const t = Date.parse(r.date); return t && now - t <= ms; }).length;
		const last24 = since(864e5);
		const last7d = since(7 * 864e5);
		const activeN = rows.filter((r) => ACTIVE_STATUSES.includes(r.status)).length;

		const facetsHtml = `
			<aside class="facets">
				<div class="facets-head">
					<div class="row"><h3>${K.labels} <span class="muted">${facets.length}</span></h3>
						${ex.sel.size ? `<button class="btn btn-ghost btn-xs" data-act="facet-clear">Clear (${ex.sel.size})</button>` : ''}
					</div>
					<input class="input input-sm" type="search" placeholder="Search ${K.labels.toLowerCase()}…" value="${esc(ex.facetQ)}" data-bind="facet-q">
				</div>
				<div class="facet-list">
					${facetList.length ? facetList.map((f) => {
						const rate = f.graded ? f.pass / f.graded * 100 : 0;
						return `
							<button class="facet ${ex.sel.has(f.name) ? 'on' : ''}" data-act="facet-toggle" data-name="${esc(f.name)}" title="${esc(f.name)} — ${f.students.size} students, ${f.attempts} attempts, ${f.graded ? Math.round(rate) + '% passed' : 'none graded'}">
								<span class="check"><i class="fa fa-check"></i></span>
								<span class="name">${esc(f.name)}</span>
								<span class="meta"><span class="n">${fmtNum(f.students.size)}</span><span class="passbar"><i style="width:${rate}%"></i></span></span>
							</button>`;
					}).join('') : `<div class="facet-empty">No ${K.labels.toLowerCase()} found</div>`}
				</div>
			</aside>`;

		const controls = `
			<div class="filters-inline">
				<select class="select select-sm" data-bind="ex-result" title="Result">
					<option value="">Any result</option>
					<option value="passed" ${ex.result === 'passed' ? 'selected' : ''}>Passed</option>
					<option value="failed" ${ex.result === 'failed' ? 'selected' : ''}>Failed</option>
					<option value="none" ${ex.result === 'none' ? 'selected' : ''}>Not graded</option>
				</select>
				<select class="select select-sm" data-bind="ex-status" title="Status">
					<option value="">Any status</option>
					${statuses.map((s) => `<option value="${esc(s)}" ${ex.status === s ? 'selected' : ''}>${esc(humanize(s))}</option>`).join('')}
				</select>
				<input class="input input-sm mark-input" type="number" placeholder="Min mark" value="${esc(ex.min)}" data-bind="ex-min" title="Minimum mark">
				<input class="input input-sm mark-input" type="number" placeholder="Max mark" value="${esc(ex.max)}" data-bind="ex-max" title="Maximum mark">
				<label class="switch" title="Keep only the best attempt of each student"><input type="checkbox" data-bind="ex-best" ${ex.best ? 'checked' : ''}><span class="track"></span><span>Best attempt only</span></label>
				${ex.status || ex.result || ex.min || ex.max || ex.best ? '<button class="btn btn-ghost btn-xs" data-act="ex-reset">Reset</button>' : ''}
				<span style="flex:1"></span>
				<div class="segmented" role="group" aria-label="Layout">
					<button class="${ex.mode === 'list' ? 'active' : ''}" data-act="ex-mode" data-mode="list"><i class="fa fa-list"></i>Attempts</button>
					<button class="${ex.mode === 'feed' ? 'active' : ''}" data-act="ex-mode" data-mode="feed"><i class="fa fa-clock-o"></i>Feed</button>
					<button class="${ex.mode === 'matrix' ? 'active' : ''}" data-act="ex-mode" data-mode="matrix"><i class="fa fa-th"></i>Matrix</button>
				</div>
			</div>`;

		const kpis = `
			<div class="kpis">
				<div class="kpi"><div class="k">Attempts</div><div class="v">${fmtNum(rows.length)}</div></div>
				<div class="kpi"><div class="k">Students</div><div class="v">${fmtNum(studentsN)}<small>of ${fmtNum(visibleStudents().length)}</small></div></div>
				<div class="kpi"><div class="k">Pass rate</div><div class="v">${passRate === null ? '—' : fmtNum(passRate, 1) + '%'}<small>${graded.length ? fmtNum(graded.length) + ' graded' : ''}</small></div></div>
				<div class="kpi"><div class="k">Average mark</div><div class="v">${avg === null ? '—' : fmtNum(avg, 1)}</div></div>
				<div class="kpi"><div class="k">Median mark</div><div class="v">${median === null ? '—' : fmtNum(median, 1)}</div></div>
				<div class="kpi"><div class="k">Active now</div><div class="v">${fmtNum(activeN)}<small>in progress</small></div></div>
				<div class="kpi"><div class="k">Last 24h</div><div class="v">${fmtNum(last24)}<small>attempts</small></div></div>
				<div class="kpi"><div class="k">Last 7d</div><div class="v">${fmtNum(last7d)}<small>attempts</small></div></div>
			</div>`;

		const title = ex.sel.size === 1 ? esc([...ex.sel][0]) : ex.sel.size ? `${ex.sel.size} ${K.labels.toLowerCase()} selected` : `All ${K.labels.toLowerCase()}`;
		const main = `
			<section>
				<div class="toolbar"><div class="toolbar-title"><h1>${title}</h1><span class="sub">${plural(base.length, 'attempt')} across ${plural(new Set(base.map((r) => r.u.id)).size, 'student')}</span></div>${rescanButton()}</div>
				${controls}
				${monitorBarHtml(kind)}
				${kpis}
				${ex.mode === 'matrix' ? renderMatrix(kind, rows, facets) : ex.mode === 'feed' ? renderFeed(kind, rows) : renderAttempts(kind, rows)}
			</section>`;
		return `<div class="explorer">${facetsHtml}${main}</div>`;
	}

	function renderAttempts(kind, rows) {
		const K = KIND[kind];
		const ex = S.explorer[kind];
		if (!rows.length) return `<div class="empty"><i class="fa fa-search"></i><h3>No attempts match</h3><p>Change the selection or the filters above.</p></div>`;
		const sorted = sortBy(rows, EXPLORER_SORT[ex.sort.key] || EXPLORER_SORT.date, ex.sort.dir);
		const size = S.pageSize[kind];
		ex.page = clampPage(ex.page, sorted.length, size);
		const slice = sorted.slice((ex.page - 1) * size, ex.page * size);
		const sh = (key, label, cls) => sortHeader(kind, key, label, ex.sort, cls);
		return `
			<div class="table-wrap">
				<table class="data">
					<thead><tr>
						${sh('student', 'Student')}${sh('name', K.label)}${sh('mark', 'Mark')}${sh('result', 'Result')}${sh('status', 'Status')}${sh('occ', 'Attempt', 'r')}${sh('date', 'Date', 'r')}<th></th>
					</tr></thead>
					<tbody>
						${slice.map((r) => `
							<tr class="clickable ${S.monitor.changed.has(entrySig(r)) ? 'flash' : ''}" data-act="open" data-id="${r.u.id}" data-tab="${kind}">
								<td class="student-cell"><div class="who">${entryThumb(r.u)}<span class="login">${fv('login', r.u.login)}</span></div></td>
								<td>${fvEntry(kind, r.name)}</td>
								<td>${markBar(r.mark, r.ok)}</td>
								<td>${resultBadge(r.ok)}</td>
								<td>${statusBadge(r.status)}</td>
								<td class="r num">${r.occ === null ? '—' : '#' + (r.occ + 1)}</td>
								<td class="r num" title="${esc(fmtDateTime(r.date))}">${fmtDate(r.date)}<div class="field-hint">${esc(fmtRel(r.date))}</div></td>
								<td class="r">${projectUrl(r.e) ? `<a class="btn btn-ghost btn-xs icon-btn" href="${esc(projectUrl(r.e))}" target="_blank" rel="noreferrer" title="Open on the intra"><i class="fa fa-external-link"></i></a>` : ''}</td>
							</tr>`).join('')}
					</tbody>
				</table>
			</div>
			${pager(kind, sorted.length, ex.page, size, [50, 100, 250, 500])}`;
	}

	function renderFeed(kind, rows) {
		const ex = S.explorer[kind];
		const dated = rows.filter((r) => r.date).sort((a, b) => String(b.date).localeCompare(String(a.date)));
		if (!dated.length) return `<div class="empty"><i class="fa fa-clock-o"></i><h3>No dated activity</h3><p>Attempts need a graded or updated date to show here.</p></div>`;
		const size = S.pageSize[kind];
		ex.page = clampPage(ex.page, dated.length, size);
		const slice = dated.slice((ex.page - 1) * size, ex.page * size);
		let items = '', lastDay = '';
		for (const r of slice) {
			const day = fmtDate(r.date);
			if (day !== lastDay) { items += `<div class="feed-day">${esc(day)}</div>`; lastDay = day; }
			const flash = S.monitor.changed.has(entrySig(r)) ? 'flash' : '';
			items += `
				<div class="feed-item clickable ${flash}" data-act="open" data-id="${r.u.id}" data-tab="${kind}">
					${entryThumb(r.u)}
					<div class="feed-main">
						<div class="feed-line"><span class="login">${fv('login', r.u.login)}</span>${fvEntry(kind, r.name)}</div>
						<div class="feed-sub">${statusBadge(r.status)}${resultBadge(r.ok)}<span class="muted" title="${esc(fmtDateTime(r.date))}">${esc(fmtRel(r.date))}</span>${r.occ === null ? '' : `<span class="muted">· attempt #${r.occ + 1}</span>`}</div>
					</div>
					<div class="feed-mark">${markBar(r.mark, r.ok)}</div>
				</div>`;
		}
		return `<div class="feed">${items}</div>${pager(kind, dated.length, ex.page, size, [50, 100, 250, 500])}`;
	}

	function renderMatrix(kind, rows, facets) {
		const ex = S.explorer[kind];
		const MAX_COLS = 14;
		let cols = ex.sel.size ? facets.filter((f) => ex.sel.has(f.name)).map((f) => f.name) : facets.slice(0, MAX_COLS).map((f) => f.name);
		const hint = !ex.sel.size && facets.length > MAX_COLS
			? `<p class="field-hint" style="margin-bottom:10px">Showing the ${MAX_COLS} most common ${KIND[kind].labels.toLowerCase()} — select some on the left to choose the columns.</p>` : '';
		const colSet = new Set(cols);
		const byStudent = new Map();
		for (const r of rows) {
			if (!colSet.has(r.name)) continue;
			let row = byStudent.get(r.u.id);
			if (!row) byStudent.set(r.u.id, row = { u: r.u, cells: {} });
			const cur = row.cells[r.name];
			if (!cur || (r.mark ?? -1) > (cur.mark ?? -1)) row.cells[r.name] = r;
		}
		let list = [...byStudent.values()];
		for (const row of list) {
			const marks = Object.values(row.cells).map((r) => r.mark).filter(isNum);
			row.avg = marks.length ? marks.reduce((a, b) => a + b, 0) / marks.length : null;
		}
		if (!list.length) return hint + `<div class="empty"><i class="fa fa-th"></i><h3>Nothing to compare</h3><p>No student has an attempt matching the current filters.</p></div>`;
		const sk = ex.sort.key;
		const getter = sk === 'student' ? (row) => row.u.login : sk === 'avg' ? (row) => row.avg : sk.startsWith('col:') ? (row) => row.cells[sk.slice(4)]?.mark ?? null : (row) => row.avg;
		list = sortBy(list, getter, ex.sort.key ? ex.sort.dir : 'desc');
		const size = S.pageSize.matrix;
		ex.page = clampPage(ex.page, list.length, size);
		const slice = list.slice((ex.page - 1) * size, ex.page * size);
		return hint + `
			<div class="table-wrap">
				<table class="data matrix compact">
					<thead><tr>
						${sortHeader(kind, 'student', 'Student', ex.sort)}
						${cols.map((c) => sortHeader(kind, 'col:' + c, c, ex.sort, 'col')).join('')}
						${sortHeader(kind, 'avg', 'Average', ex.sort, 'r')}
					</tr></thead>
					<tbody>
						${slice.map((row) => `
							<tr class="clickable" data-act="open" data-id="${row.u.id}" data-tab="${kind}">
								<td class="student-cell"><div class="who">${avatar(row.u, 'avatar-sm')}<span class="login">${fv('login', row.u.login)}</span></div></td>
								${cols.map((c) => {
									const r = row.cells[c];
									return `<td class="cell" title="${esc(c)}">${r ? markPill(r.mark, r.ok) : '<span class="muted">·</span>'}</td>`;
								}).join('')}
								<td class="r num"><b>${fmtNum(row.avg, 1)}</b></td>
							</tr>`).join('')}
					</tbody>
				</table>
			</div>
			${pager('matrix', list.length, ex.page, size, [50, 100, 250, 500])}`;
	}

	/* =========================================================================
	   Student drawer
	   ========================================================================= */

	function openStudent(id, tab = null) {
		const u = S.byId.get(Number(id));
		if (!u) return;
		const sameStudent = S.drawer.id === u.id;
		S.drawer.id = u.id;
		if (tab) S.drawer.tab = tab;
		if (!sameStudent) S.drawer.q = '';
		// prev/next follow the list currently on screen
		S.drawer.nav = S.view === 'students' || S.view === 'cursus' || S.view === 'graph'
			? (S.view === 'cursus' ? cursusRows() : visibleStudents()).map((x) => x.id)
			: [...new Set(explorerData(S.view).rows.map((r) => r.u.id))];
		renderDrawer();
		showSheet('#student-drawer');
	}

	function drawerStep(delta) {
		const nav = S.drawer.nav;
		const i = nav.indexOf(S.drawer.id);
		if (i < 0) return;
		const next = nav[i + delta];
		if (next !== undefined) {
			S.drawer.id = next;
			S.drawer.q = '';
			renderDrawer();
		}
	}

	function flattenScalars(obj, prefix = '', keyPath = '', out = []) {
		if (obj === null || typeof obj !== 'object') {
			out.push({ path: prefix, key: keyPath, value: obj });
			return out;
		}
		if (Array.isArray(obj)) {
			if (!obj.length) out.push({ path: prefix, key: keyPath, value: '[]' , empty: true });
			obj.forEach((v, i) => flattenScalars(v, `${prefix}[${i}]`, keyPath, out));
			return out;
		}
		for (const [k, v] of Object.entries(obj)) {
			if (!prefix && (k.startsWith('_') || ['all_projects', 'projects_users', 'matched_exams', 'matched_projects', 'pool'].includes(k))) continue;
			// each cursus repeats the whole user
			if (k === 'user' && keyPath === 'cursus_users') continue;
			flattenScalars(v, prefix ? `${prefix}.${k}` : k, keyPath ? `${keyPath}.${k}` : k, out);
		}
		return out;
	}

	function renderDrawer() {
		const u = S.byId.get(S.drawer.id);
		const el = $('#student-drawer');
		if (!u) { el.innerHTML = ''; return; }
		const nav = S.drawer.nav;
		const pos = nav.indexOf(u.id);
		const fullscan = S.meta.fullscan && Array.isArray(u.all_projects);
		const tabs = [
			['overview', 'Overview', 'fa-user'],
			['exams', `Exams${fullscan ? ` <span class="tab-count">${u._exams.length}</span>` : ''}`, 'fa-graduation-cap'],
			['projects', `Projects${fullscan ? ` <span class="tab-count">${u._projects.length}</span>` : ''}`, 'fa-folder-open-o'],
			['fields', 'All fields', 'fa-list-ul'],
			['json', 'JSON', 'fa-code'],
		];
		const stat = (k, v) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;

		let content = '';
		if (S.drawer.tab === 'overview') content = renderOverview(u);
		else if (S.drawer.tab === 'fields') content = renderFields(u);
		else if (S.drawer.tab === 'json') content = renderJson(u);
		else content = fullscan ? renderEntries(u, S.drawer.tab) : `
			<div class="empty"><i class="fa ${KIND[S.drawer.tab].icon}"></i><h3>Not loaded</h3><p>Run a full scan to load this student's ${S.drawer.tab}.</p>
				<div class="actions"><button class="btn btn-primary btn-sm" data-act="fullscan-on"><i class="fa fa-bolt"></i>Run full scan</button></div></div>`;

		el.innerHTML = `
			<div class="sheet-head">
				<div class="toolbar-group">
					<button class="btn btn-sm icon-btn" data-act="drawer-step" data-delta="-1" ${pos <= 0 ? 'disabled' : ''} title="Previous (K)"><i class="fa fa-chevron-up"></i></button>
					<button class="btn btn-sm icon-btn" data-act="drawer-step" data-delta="1" ${pos < 0 || pos >= nav.length - 1 ? 'disabled' : ''} title="Next (J)"><i class="fa fa-chevron-down"></i></button>
					${pos >= 0 ? `<span class="muted num" style="font-size:12px">${fmtNum(pos + 1)} / ${fmtNum(nav.length)}</span>` : ''}
				</div>
				<h2></h2>
				${refreshButton(u)}
				<a class="btn btn-sm" href="${esc(intraUrl(u.login))}" target="_blank" rel="noreferrer"><i class="fa fa-external-link"></i>Intra profile</a>
				<button class="btn btn-ghost icon-btn" data-act="close-sheets" aria-label="Close (Esc)"><i class="fa fa-times"></i></button>
			</div>
			<div class="sheet-body">
				<div class="student-hero">
					<div class="hero-photo photo" ${zoomAttrs(u)}>${photo(u)}</div>
					<div class="names">
						<h2>${fv('login', u.login)}${u.location ? `<span class="badge ok" title="Logged in at ${esc(u.location)}"><span class="dot online"></span>${fv('location', u.location)}</span>` : '<span class="badge" title="Not logged in on a campus computer">Offline</span>'}</h2>
						<div class="display">${esc(u.displayname)}</div>
						<div class="contact-line">
							${u.email ? `<span>${mailLink(u.email)}${fv('email', u.email)}<button class="btn btn-ghost btn-xs icon-btn" data-act="copy" data-v="${esc(u.email)}" title="Copy email"><i class="fa fa-clipboard"></i></button></span>` : ''}
							${u.phone && u.phone !== 'hidden' ? `<span><a class="ext" href="tel:${esc(u.phone)}"><i class="fa fa-phone"></i></a>${esc(u.phone)}</span>` : ''}
						</div>
						<div class="badges">
							${u.kind ? `<span class="badge accent">${fv('kind', u.kind)}</span>` : ''}
							${gradeBadges(u)}
							${u.pool_year ? `<span class="badge"><i class="fa fa-calendar-o"></i>${poolText(u)}</span>` : ''}
							${stageBadge(u)}
							${u['staff?'] ? '<span class="badge warn">Staff</span>' : ''}
							${u['alumni?'] ? '<span class="badge info">Alumni</span>' : ''}
							${u['active?'] === false ? '<span class="badge">Inactive</span>' : ''}
						</div>
					</div>
				</div>
				<div class="stat-row">
					${stat('Level', fullscan ? fv('level', u.level, fmtNum(u.level, 2)) : '—')}
					${stat('Wallet', fv('wallet', u.wallet, fmtNum(u.wallet)))}
					${stat('Eval points', fv('correction_point', u.correction_point, fmtNum(u.correction_point)))}
					${stat('Exam avg', fmtNum(u.average_exam_final_mark, 1))}
					${stat('Project avg', fmtNum(u.average_project_final_mark, 1))}
					${stat('C Piscine', isNum(u.cpiscine_final_mark) ? markPill(u.cpiscine_final_mark, u.cpiscine_final_mark >= 50) : '—')}
				</div>
				<nav class="subtabs">
					${tabs.map(([key, label, icon]) => `<button class="${S.drawer.tab === key ? 'active' : ''}" data-act="drawer-tab" data-tab="${key}"><i class="fa ${icon}"></i>${label}</button>`).join('')}
				</nav>
				${content}
			</div>`;
	}

	/** When the profile shown was fetched from the 42 API, and a button to fetch it again. */
	function refreshButton(u) {
		if (!S.meta.fullscan) return '';
		const at = Number(u.lastSave);
		const busy = S.refreshing === u.id;
		return `<button class="btn btn-sm" data-act="refresh-student" data-id="${u.id}" ${busy ? 'disabled' : ''} title="Profile fetched ${at ? fmtAgo(at) + ` (${esc(new Date(at * 1000).toLocaleString())})` : 'never'} — fetch it again now">
			${busy ? '<span class="spinner spinner-sm"></span>' : '<i class="fa fa-refresh"></i>'}${at ? `<span class="muted">${fmtAgo(at)}</span>` : 'Fetch'}</button>`;
	}

	/** Grade of each cursus ("Learner", "Member"…) when it says more than the stage badge. */
	function gradeBadges(u) {
		const stage = String(STAGES[u.stage]?.short || '').toLowerCase();
		return (u.cursus_users || []).filter((c) => c.grade && c.grade.toLowerCase() !== stage)
			.map((c) => `<span class="badge info" title="${esc(c.cursus?.name || '')} grade">${fv('cursus_users.grade', c.grade)}</span>`).join('');
	}

	/** Countdown badge for a date in the future (end of piscine, blackhole…). */
	function countdown(iso, { warnDays = 14, badDays = 3, past = 'ended' } = {}) {
		if (!iso) return '';
		const days = daysUntil(iso);
		if (days < 0) return `<span class="badge" title="${esc(fmtDateTime(iso))}">${esc(past)} ${esc(fmtRel(iso))}</span>`;
		const cls = days <= badDays ? 'bad' : days <= warnDays ? 'warn' : 'ok';
		return `<span class="badge ${cls}" title="${esc(fmtDateTime(iso))}">${esc(fmtRel(iso))}</span>`;
	}

	function renderCursus(c) {
		const level = isNum(c.level) ? c.level : null;
		const pct = level === null ? 0 : Math.round((level % 1) * 100);
		const skills = sortBy(c.skills || [], (sk) => sk.level, 'desc');
		const maxSkill = Math.max(10, ...skills.map((sk) => sk.level || 0));
		const piscine = c.cursus?.kind === 'piscine';
		return `
			<div class="cursus-card">
				<div class="cursus-head">
					<div>
						<div class="cursus-name">${fv('cursus_users.cursus.name', c.cursus?.name || `Cursus ${c.cursus_id}`)}</div>
						<div class="field-hint">${esc(humanize(c.cursus?.kind || ''))}${c.grade ? ` · ${esc(c.grade)}` : ''}${c.has_coalition ? ' · has a coalition' : ''}</div>
					</div>
					<div class="cursus-level">
						<span class="k">Level</span>
						<b class="num">${level === null ? '—' : fmtNum(level, 2)}</b>
					</div>
				</div>
				<span class="lvl-track" title="${pct}% to level ${level === null ? 1 : Math.floor(level) + 1}"><i style="width:${pct}%"></i></span>
				<div class="cursus-dates">
					<div><span class="k">Started</span>${dateRel(c.begin_at)}</div>
					<div><span class="k">${piscine ? 'Piscine ends' : 'Ends'}</span>${c.end_at ? `${fmtDate(c.end_at)} ${countdown(c.end_at, { warnDays: 7, badDays: 2 })}` : '<span class="muted">—</span>'}</div>
					${c.blackholed_at || !piscine ? `<div><span class="k">Blackhole</span>${c.blackholed_at ? `${fmtDate(c.blackholed_at)} ${countdown(c.blackholed_at, { warnDays: 30, badDays: 7, past: 'absorbed' })}` : '<span class="muted">none</span>'}</div>` : ''}
				</div>
				${skills.length ? `
					<div class="skills">
						${skills.map((sk) => `
							<div class="skill" title="${esc(sk.name)}: level ${fmtNum(sk.level, 2)}">
								<span class="name">${esc(sk.name)}</span>
								<span class="bar"><i style="width:${Math.min(100, (sk.level || 0) / maxSkill * 100)}%"></i></span>
								<span class="num">${fmtNum(sk.level, 2)}</span>
							</div>`).join('')}
					</div>` : '<div class="field-hint">No skills yet</div>'}
			</div>`;
	}

	function renderOverview(u) {
		const loaded = S.meta.fullscan && Array.isArray(u.cursus_users);
		const campus = Array.isArray(u.campus) ? u.campus : [];
		const fact = (k, v) => `<div class="fact"><div class="k">${k}</div><div class="v">${v}</div></div>`;
		const status = [u['active?'] === false ? 'Inactive' : 'Active', u['staff?'] && 'Staff', u['alumni?'] && `Alumni${u.alumnized_at ? ' ' + fmtRel(u.alumnized_at) : ''}`].filter(Boolean).join(' · ');
		const listOf = (items, name) => items.map((x) => `<span class="badge">${esc(name(x))}</span>`).join('');
		const extras = [
			['Titles', u.titles, (t) => String(t.name || '').replace('%login', u.login)],
			['Groups', u.groups, (g) => g.name],
			['Roles', u.roles, (r) => r.name],
			['Expertises', u.expertises_users, (e) => e.expertise?.name || `#${e.expertise_id}`],
		].filter(([, items]) => Array.isArray(items) && items.length);
		const achievements = Array.isArray(u.achievements) ? u.achievements : [];
		return `
			<section class="ov-section">
				<h4>Profile</h4>
				<div class="facts">
					${fact('Pool', u.pool_year ? poolText(u) : '<span class="muted">—</span>')}
					${fact('Joined', dateRel(u.created_at))}
					${fact('Last update', dateRel(u.updated_at))}
					${fact('Location', u.location ? `<span class="dot online"></span>${fv('location', u.location)}` : '<span class="muted">Offline</span>')}
					${fact('Status', esc(status))}
					${fact('Wallet', `${fv('wallet', u.wallet, fmtNum(u.wallet))} ₳`)}
					${u.data_erasure_date ? fact('Data erased', dateRel(u.data_erasure_date)) : ''}
					${loaded && u.lastSave ? fact('Profile fetched', `<span title="${esc(new Date(Number(u.lastSave) * 1000).toLocaleString())}">${fmtAgo(Number(u.lastSave))}</span>`) : ''}
				</div>
			</section>
			${campus.length ? `
				<section class="ov-section">
					<h4>Campus</h4>
					${campus.map((c) => `
						<div class="campus-line">
							<div><b>${fv('campus.name', c.name)}</b> <span class="muted">${esc([c.city, c.country].filter(Boolean).join(', '))}</span></div>
							<div class="field-hint">${esc([c.address, c.zip, c.city].filter(Boolean).join(', '))}${c.time_zone ? ` · ${esc(c.time_zone)}` : ''}${c.language?.name ? ` · ${esc(c.language.name)}` : ''}</div>
							<div class="links">
								${c.website ? extLink(c.website, esc(c.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))) : ''}
								${c.facebook ? extLink(c.facebook, 'Facebook') : ''}
								${c.twitter ? extLink(c.twitter, 'Twitter') : ''}
								${c.email_extension ? `<span class="muted">@${esc(c.email_extension)}</span>` : ''}
							</div>
						</div>`).join('')}
				</section>` : ''}
			${loaded ? `
					<section class="ov-section">
					<h4>Cursus <span class="muted">${u.cursus_users.length}</span></h4>
					${u.cursus_users.length ? sortBy(u.cursus_users, (c) => c.begin_at, 'desc').map(renderCursus).join('') : '<p class="muted">Not enrolled in any cursus.</p>'}
				</section>
				${achievements.length ? `
					<section class="ov-section">
						<h4>Achievements <span class="muted">${achievements.length}</span></h4>
						<div class="achievements">
							${achievements.map((a) => `
								<div class="achievement" title="${esc(a.description || '')}">
									<i class="fa fa-trophy tier-${esc(a.tier || 'none')}"></i>
									<div><b>${esc(a.name)}</b><div class="field-hint">${esc(a.description || '')}</div></div>
									${a.kind ? `<span class="badge">${esc(a.kind)}</span>` : ''}
								</div>`).join('')}
						</div>
					</section>` : ''}
				${extras.map(([title, items, name]) => `<section class="ov-section"><h4>${title}</h4><div class="badges">${listOf(items, name)}</div></section>`).join('')}` : `
				<div class="srow-placeholder"><i class="fa fa-bolt"></i>${LZ.on && !LZ.failed.has(u.id) ? 'Fetching this profile…' : 'Cursus, level, skills and achievements need the profile.'}
					<button class="btn btn-xs" data-act="fetch-one" data-id="${u.id}" style="margin-left:auto">Fetch this profile</button>
					<button class="btn btn-primary btn-xs" data-act="fullscan-on">Run full scan</button></div>`}`;
	}

	/** A raw field value: links, emails and dates are shown as such. */
	function fieldValue(r) {
		if (r.empty) return '<span class="muted">empty</span>';
		if (r.value === null || r.value === undefined) return fv(r.key, r.value, '<span class="muted">null</span>');
		const v = r.value;
		if (typeof v === 'string') {
			if (/^https?:\/\//.test(v)) {
				const href = browsableUrl(v);
				if (!href) return `<span class="text-2" title="42 API link (needs a token)">${esc(v)}</span>`;
				const img = /\.(jpe?g|png|gif|svg|webp)$/i.test(v);
				const thumbSrc = v.startsWith('https://cdn.intra.42.fr/') ? proxied(v) : v;
				return `${img ? `<img class="kv-thumb" src="${esc(thumbSrc)}" alt="" loading="lazy" onerror="this.remove()">` : ''}${extLink(href, esc(href), href !== v ? `Intra profile (the API link ${v} needs a token)` : '')}`;
			}
			if (/(^|\.)email$/.test(r.key) && v.includes('@')) return `${mailLink(v)} ${fv(r.key, v)}`;
			if (ISO_DATE.test(v)) return fv(r.key, v, `${esc(fmtDateTime(v))} <span class="muted">· ${esc(fmtRel(v))}</span>`);
		}
		if (typeof v === 'boolean') return fv(r.key, v, `<span class="bool ${v}">${v ? 'yes' : 'no'}</span>`);
		return fv(r.key, v);
	}

	function renderFields(u) {
		const q = S.drawer.q.toLowerCase();
		const rows = flattenScalars(u).filter((r) => !q || r.path.toLowerCase().includes(q) || String(r.value ?? '').toLowerCase().includes(q));
		return `
			<div class="section-tools">
				<input class="input input-sm" type="search" placeholder="Search fields or values…" value="${esc(S.drawer.q)}" data-bind="dr-q">
				<span class="field-hint">Ctrl+click a value to filter by it</span>
			</div>
			<div class="kv">
				${rows.map((r) => `
					<div class="k" title="Filter key: ${esc(r.key)}">${esc(r.path)}</div>
					<div class="v">${fieldValue(r)}</div>`).join('')}
			</div>
			${rows.length ? '' : '<p class="muted" style="margin-top:12px">No field matches.</p>'}`;
	}

	function renderEntries(u, kind) {
		const K = KIND[kind];
		const d = S.drawer;
		const all = kind === 'exams' ? u._exams : u._projects;
		const hasNameFilter = !!getParam(S.applied, K.name) || !!getParam(S.applied, K.prefix + '_mark') ||
			!!getParam(S.applied, K.prefix + '_status') || !!getParam(S.applied, K.prefix + '_validated');
		const q = d.q.toLowerCase();
		let list = all.filter((e) =>
			(!q || String(e.project?.name || '').toLowerCase().includes(q) || String(e.project?.slug || '').toLowerCase().includes(q)) &&
			(!d.status || e.status === d.status) &&
			(!d.onlyMatching || !hasNameFilter || u._matched.has(e.id)));
		const getters = {
			name: (e) => e.project?.name, mark: (e) => e.final_mark, result: (e) => e['validated?'] === null || e['validated?'] === undefined ? null : Number(e['validated?']),
			status: (e) => e.status, occ: (e) => e.occurrence, date: (e) => e.marked_at || e.updated_at,
		};
		list = sortBy(list, getters[d.sort.key] || getters.date, d.sort.dir);
		const statuses = [...new Set(all.map((e) => e.status).filter(Boolean))].sort();
		const passed = all.filter((e) => e['validated?'] === true).length;
		const sh = (key, label, cls) => sortHeader('drawer', key, label, d.sort, cls);
		return `
			<div class="section-tools">
				<input class="input input-sm" type="search" placeholder="Search ${K.labels.toLowerCase()}…" value="${esc(d.q)}" data-bind="dr-q">
				<select class="select select-sm" data-bind="dr-status">
					<option value="">Any status</option>
					${statuses.map((s) => `<option value="${esc(s)}" ${d.status === s ? 'selected' : ''}>${esc(humanize(s))}</option>`).join('')}
				</select>
				${hasNameFilter ? `<label class="switch"><input type="checkbox" data-bind="dr-matching" ${d.onlyMatching ? 'checked' : ''}><span class="track"></span><span>Matching filters only</span></label>` : ''}
				<span class="field-hint">${fmtNum(passed)} passed · ${fmtNum(all.length)} total</span>
			</div>
			${list.length ? `
				<div class="table-wrap">
					<table class="data compact">
						<thead><tr>${sh('name', K.label)}${sh('mark', 'Mark')}${sh('result', 'Result')}${sh('status', 'Status')}${sh('occ', 'Attempt', 'r')}${sh('date', 'Date', 'r')}<th></th></tr></thead>
						<tbody>
							${list.map((e) => `
								<tr class="${hasNameFilter && !u._matched.has(e.id) ? 'dim' : ''}">
									<td>${fvEntry(kind, e.project?.name || e.project?.slug)}</td>
									<td>${markPill(e.final_mark, e['validated?'])}</td>
									<td>${resultBadge(e['validated?'] ?? null)}</td>
									<td>${statusBadge(e.status)}${e.retriable_at && daysUntil(e.retriable_at) > 0 ? ` <span class="badge" title="Can retry ${esc(fmtDateTime(e.retriable_at))}"><i class="fa fa-clock-o"></i>retry ${esc(fmtRel(e.retriable_at))}</span>` : ''}</td>
									<td class="r num">${isNum(e.occurrence) ? '#' + (e.occurrence + 1) : '—'}</td>
									<td class="r num" title="${e.marked_at ? 'Marked' : 'Last update'} ${esc(fmtDateTime(e.marked_at || e.updated_at))}">${fmtDate(e.marked_at || e.updated_at)}<div class="field-hint">${esc(fmtRel(e.marked_at || e.updated_at))}</div></td>
									<td class="r">${projectUrl(e) ? `<a class="btn btn-ghost btn-xs icon-btn" href="${esc(projectUrl(e))}" target="_blank" rel="noreferrer" title="Open on the intra"><i class="fa fa-external-link"></i></a>` : ''}</td>
								</tr>`).join('')}
						</tbody>
					</table>
				</div>` : `<div class="empty"><i class="fa fa-search"></i><h3>No ${K.labels.toLowerCase()}</h3></div>`}`;
	}

	async function refreshStudent(id) {
		S.refreshing = id;
		renderDrawer();
		try {
			await postJson(`/api/students/${id}/refresh`);
			S.loadedKey = null;
			await load({ keepStaged: clonePairs(S.staged) });
			toast(`Profile of <b>${esc(S.byId.get(id)?.login || id)}</b> updated`);
		} catch (e) {
			toast(`Couldn't refresh the profile: ${esc(e.message)}`, null, 6000);
		} finally {
			S.refreshing = null;
			if (S.drawer.id === id) renderDrawer();
		}
	}

	function highlightJson(json) {
		return esc(json).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m, str, colon, lit) => {
			if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
			if (lit) return `<span class="b">${m}</span>`;
			return `<span class="n">${m}</span>`;
		});
	}

	function studentJson(u) {
		const clean = {};
		for (const [k, v] of Object.entries(u)) if (!k.startsWith('_') && k !== 'pool') clean[k] = v;
		return JSON.stringify(clean, null, 2);
	}

	function renderJson(u) {
		return `
			<div class="section-tools"><span class="field-hint" style="flex:1">Raw data as returned by the server</span>
				<button class="btn btn-sm" data-act="copy-json"><i class="fa fa-clipboard"></i>Copy JSON</button></div>
			<pre class="json">${highlightJson(studentJson(u))}</pre>`;
	}

	/* =========================================================================
	   Filter panel
	   ========================================================================= */

	function reservedKeys() {
		return new Set([...customParamNames(), 'stage']);
	}

	function initFieldRows() {
		const reserved = reservedKeys();
		S.fieldRows = S.staged.filter(([k]) => !reserved.has(k)).map(([k, v]) => ({ k, ...parseCond(v) }));
		if (!S.fieldRows.length) S.fieldRows.push({ k: '', op: '==', val: '' });
	}

	function syncFieldRows() {
		const reserved = reservedKeys();
		S.staged = S.staged.filter(([k]) => reserved.has(k));
		for (const r of S.fieldRows) {
			const k = r.k.trim();
			if (!k || (r.val === '' && r.op === '~')) continue;
			setParam(S.staged, k, buildCond(r.op, r.val));
		}
		stagedChanged('panel');
	}

	function opSelect(bind, op, extra = '') {
		return `<select class="select select-sm" data-bind="${bind}" ${extra}>${OPS.map(([o, l]) => `<option value="${esc(o)}" ${o === op ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
	}

	function entryNames(kind) {
		return [...new Set(S.entries[kind].map((r) => r.name))].sort();
	}

	function renderFieldRows() {
		const fields = new Set([...(S.meta?.fields || []).map((f) => f.name), ...(S.meta?.derivedFields || []).map((f) => f.name)]);
		const unknown = new Set(S.meta?.unknownKeys || []);
		return S.fieldRows.map((r, i) => `
			<div class="field-filter-row ${r.k && (unknown.has(r.k) || (fields.size && !fields.has(r.k) && S.meta?.fullscan)) ? 'unknown' : ''}">
				<input class="input input-sm mono" list="dl-fields" placeholder="field" value="${esc(r.k)}" data-bind="row-k" data-i="${i}" spellcheck="false" autocomplete="off">
				${opSelect('row-op', r.op, `data-i="${i}"`)}
				<input class="input input-sm" placeholder="value" value="${esc(r.val)}" data-bind="row-v" data-i="${i}" spellcheck="false" autocomplete="off">
				<button class="btn btn-danger-ghost btn-sm icon-btn" data-act="row-remove" data-i="${i}" aria-label="Remove condition"><i class="fa fa-trash-o"></i></button>
			</div>`).join('');
	}

	function renderEntrySection(kind) {
		const K = KIND[kind];
		const p = K.prefix;
		const fullscan = getParam(S.staged, 'fullscan') !== undefined;
		const mark = parseCond(getParam(S.staged, p + '_mark') || '>=');
		const validated = getParam(S.staged, p + '_validated') || '';
		const status = getParam(S.staged, p + '_status') || '';
		const statuses = [...new Set([...KNOWN_STATUSES, ...S.entries[kind].map((r) => r.status).filter(Boolean)])];
		return `
			<section class="fsection ${fullscan ? '' : 'locked'}" data-section="${kind}">
				<div class="fsection-head"><h3><i class="fa ${K.icon}"></i>${K.labels}</h3>
					${fullscan ? '' : '<span class="lock-hint"><i class="fa fa-lock"></i>Needs full scan</span>'}</div>
				<div class="fsection-body" style="display:flex;flex-direction:column;gap:12px">
					<div class="field">
						<label>${K.label} name</label>
						<input class="input" list="dl-${kind}" placeholder="${kind === 'exams' ? 'e.g. C Piscine Final Exam' : 'e.g. libft'}" value="${esc(getParam(S.staged, K.name) || '')}" data-bind="p-name" data-kind="${kind}" data-i="${kind}" autocomplete="off">
						<span class="field-hint">Matches the name or slug. Separate alternatives with <code>|</code>.</span>
					</div>
					<div class="field-row">
						<div class="field"><label>Mark</label>
							<div class="cond">
								<select class="select" data-bind="p-mark-op" data-kind="${kind}" data-i="${kind}">
									${['>=', '>', '==', '!=', '<', '<='].map((o) => `<option value="${o}" ${mark.op === o ? 'selected' : ''}>${OP_SYMBOL[o]}</option>`).join('')}
								</select>
								<input class="input" type="number" placeholder="any" value="${esc(mark.val)}" data-bind="p-mark-val" data-kind="${kind}" data-i="${kind}">
							</div>
						</div>
						<div class="field"><label>Result</label>
							<select class="select" data-bind="p-validated" data-kind="${kind}" data-i="${kind}">
								<option value="">Any</option>
								<option value="==true" ${/true/.test(validated) ? 'selected' : ''}>Passed</option>
								<option value="==false" ${/false/.test(validated) ? 'selected' : ''}>Failed</option>
							</select>
						</div>
					</div>
					<div class="field"><label>Status</label>
						<select class="select" data-bind="p-status" data-kind="${kind}" data-i="${kind}">
							<option value="">Any</option>
							${statuses.map((s) => `<option value="==${esc(s)}" ${status === '==' + s || status === s ? 'selected' : ''}>${esc(humanize(s))}</option>`).join('')}
						</select>
					</div>
					<label class="switch"><input type="checkbox" data-bind="p-required" data-kind="${kind}" data-i="${kind}" ${getParam(S.staged, p + '_required') !== undefined ? 'checked' : ''}><span class="track"></span>
						<span>Only students with a matching ${K.label.toLowerCase()}</span></label>
					<span class="field-hint">Mark, result and status always narrow the students too.</span>
				</div>
			</section>`;
	}

	function renderFilterPanel() {
		const el = $('#filter-panel');
		const m = S.meta;
		if (!m) { el.innerHTML = ''; return; }
		const fullscan = getParam(S.staged, 'fullscan') !== undefined;
		const toFetch = Math.max(0, m.count - (m.cachedCount || 0));
		const campusValue = getParam(S.staged, 'campus_id') ?? '';
		const stageCond = parseCond(getParam(S.staged, 'stage') || '');
		const stageValue = stageCond.op === '==' || stageCond.op === '~' ? stageCond.val : '';
		const fields = [...(m.fields || []).map((f) => f.name), ...(m.derivedFields || []).map((f) => f.name)];
		el.innerHTML = `
			<div class="sheet-head">
				<h2>Filters</h2>
				<button class="btn btn-ghost icon-btn" data-act="close-sheets" aria-label="Close (Esc)"><i class="fa fa-times"></i></button>
			</div>
			<div class="sheet-body">
				<datalist id="dl-fields">${[...new Set(fields)].map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
				<datalist id="dl-exams">${entryNames('exams').map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
				<datalist id="dl-projects">${entryNames('projects').map((n) => `<option value="${esc(n)}">`).join('')}</datalist>

				<section class="fsection">
					<div class="fsection-head"><h3><i class="fa fa-database"></i>Data</h3></div>
					<div class="field"><label>Campus</label>
						<select class="select" data-bind="p-campus">
							${m.hasDefaultFile ? `<option value="" ${campusValue === '' ? 'selected' : ''}>Default (students.json)</option>` : ''}
							${m.campuses.map((c) => `<option value="${c.id}" ${String(campusValue) === String(c.id) || (!campusValue && !m.hasDefaultFile && c.id === m.campusId) ? 'selected' : ''}>${esc(c.name)} · #${c.id}</option>`).join('')}
						</select>
					</div>
					<label class="fullscan-box">
						<span class="switch"><input type="checkbox" data-bind="p-fullscan" ${fullscan ? 'checked' : ''}><span class="track"></span></span>
						<span>
							<span class="title">Full scan</span>
							<span class="desc" style="display:block">Loads exams, projects and levels by fetching every matching student from the 42 API. Fetched profiles are kept; <b>Rescan</b> updates the ones older than ${m.cacheHours}h.
							${m.fullscan ? '' : toFetch === 0 ? `All ${fmtNum(m.count)} current students are cached${m.outdatedCount ? ` (${fmtNum(m.outdatedCount)} older than ${m.cacheHours}h)` : ''}.` : `${fmtNum(m.cachedCount || 0)}/${fmtNum(m.count)} current students cached · ~${fmtNum(toFetch)} requests (${apiEstimate(toFetch)}).`}
							Field filters below are applied <i>before</i> fetching, so narrow down first.</span>
						</span>
					</label>
					<div class="field ${fullscan ? '' : 'locked'}">
						<label>Student type ${fullscan ? '' : '<span class="lock-hint" style="display:inline-flex;margin-left:6px"><i class="fa fa-lock"></i>Needs full scan</span>'}</label>
						<div class="segmented" role="group" aria-label="Student type">
							${[['', 'Everyone'], ...Object.entries(STAGES).map(([k, st]) => [k, st.label])].map(([k, label]) => `
								<button type="button" class="${stageValue === k ? 'active' : ''}" data-act="p-stage" data-stage="${k}" title="${esc(STAGES[k]?.hint || 'No restriction')}">${esc(label)}</button>`).join('')}
						</div>
						<span class="field-hint">Based on the cursus each student is enrolled in.</span>
					</div>
				</section>

				<section class="fsection" data-section="fields">
					<div class="fsection-head"><h3><i class="fa fa-user"></i>Student fields</h3>
						<button class="btn btn-ghost btn-xs" data-act="row-add"><i class="fa fa-plus"></i>Add condition</button></div>
					<p class="fsection-desc">Tip: <kbd>Ctrl</kbd>+click any value on the page to add it here, <kbd>Alt</kbd>+click to exclude it.</p>
					<div class="field-rows" id="field-rows">${renderFieldRows()}</div>
				</section>

				${renderEntrySection('exams')}
				${renderEntrySection('projects')}
			</div>
			<div class="sheet-foot">
				<button class="btn btn-ghost" data-act="panel-reset">Reset all</button>
				<span class="grow"></span>
				<button class="btn" data-act="close-sheets">Close</button>
				<button class="btn btn-primary" data-act="apply" ${isDirty() ? '' : 'disabled'}>Apply <kbd>Ctrl ↵</kbd></button>
			</div>`;
	}

	function openFilterPanel(focusKey = null) {
		S.panelOpen = true;
		initFieldRows();
		if (focusKey && !reservedKeys().has(focusKey) && !S.fieldRows.some((r) => r.k === focusKey)) {
			S.fieldRows.push({ k: focusKey, op: '~', val: '' });
		}
		renderFilterPanel();
		showSheet('#filter-panel');
		requestAnimationFrame(() => {
			let target = null;
			if (focusKey) {
				const kind = Object.keys(KIND).find((kd) => focusKey === KIND[kd].name || focusKey.startsWith(KIND[kd].prefix + '_'));
				if (kind) target = $(`#filter-panel [data-section="${kind}"] input`);
				else {
					const idx = S.fieldRows.findIndex((r) => r.k === focusKey);
					target = idx >= 0 ? $(`#filter-panel [data-bind="row-v"][data-i="${idx}"]`) : null;
				}
			}
			if (target) { target.scrollIntoView({ block: 'center' }); target.focus(); }
		});
	}

	function refreshPanelFooter() {
		const btn = $('#filter-panel .sheet-foot [data-act="apply"]');
		if (btn) btn.disabled = !isDirty();
	}

	/* =========================================================================
	   Sheets, popover, toasts, modal
	   ========================================================================= */

	function showSheet(sel) {
		for (const s of $$('.sheet')) if ('#' + s.id !== sel) s.hidden = true;
		if (sel !== '#filter-panel') S.panelOpen = false;
		if (sel !== '#student-drawer') S.drawer.id = null;
		$(sel).hidden = false;
		$('#scrim').hidden = false;
	}

	function closeSheets() {
		for (const s of $$('.sheet')) s.hidden = true;
		$('#scrim').hidden = true;
		S.panelOpen = false;
		S.drawer.id = null;
	}

	function closeMenu() {
		$('#popover').hidden = true;
		$('#popover').classList.remove('popover-wide');
		S.menu = null;
		S.rescanOpen = false;
	}

	function placePopover(anchor) {
		const pop = $('#popover');
		pop.hidden = false;
		const r = anchor.getBoundingClientRect();
		const pw = pop.offsetWidth, ph = pop.offsetHeight;
		let left = Math.min(r.left, window.innerWidth - pw - 8);
		let top = r.bottom + 6;
		if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
		pop.style.left = Math.max(8, left) + 'px';
		pop.style.top = top + 'px';
	}

	function openMenu(anchor, head, items) {
		closeMenu();
		S.menu = items;
		const pop = $('#popover');
		pop.innerHTML = `
			<div class="popover-head">${head}</div>
			${items.map((it, i) => it === '-' ? '<div class="menu-sep"></div>' : `
				<button class="menu-item" data-act="menu" data-i="${i}">
					${it.op ? `<span class="op">${esc(it.op)}</span>` : `<i class="fa ${it.icon || 'fa-filter'}"></i>`}
					<span>${it.label}</span>
					${it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}
				</button>`).join('')}`;
		placePopover(anchor);
		pop.querySelector('.menu-item')?.focus();
	}

	function toast(message, action = null, ms = 3200) {
		const box = $('#toasts');
		const el = document.createElement('div');
		el.className = 'toast';
		el.innerHTML = `<span>${message}</span>${action ? `<button class="btn btn-sm">${action.label}</button>` : ''}`;
		if (action) el.querySelector('button').addEventListener('click', () => { action.run(); el.remove(); });
		box.appendChild(el);
		while (box.children.length > 3) box.firstChild.remove();
		setTimeout(() => el.remove(), ms);
	}

	function openLightbox(id) {
		const nav = S.view === 'students' ? visibleStudents().map((u) => u.id) : [...new Set(explorerData(S.view).rows.map((r) => r.u.id))];
		S.lightbox = { id: Number(id), nav: nav.filter((x) => photoUrl(S.byId.get(x))) };
		if (!S.lightbox.nav.includes(S.lightbox.id)) S.lightbox.nav = [S.lightbox.id];
		renderLightbox();
	}

	function lightboxStep(delta) {
		const { nav, id } = S.lightbox;
		const next = nav[nav.indexOf(id) + delta];
		if (next !== undefined) { S.lightbox.id = next; renderLightbox(); }
	}

	function closeLightbox() {
		S.lightbox = null;
		$('#lightbox').hidden = true;
	}

	function renderLightbox() {
		const u = S.byId.get(S.lightbox.id);
		const { nav } = S.lightbox;
		const pos = nav.indexOf(u.id);
		const box = $('#lightbox');
		box.innerHTML = `
			<button class="lb-btn lb-close" data-act="lb-close" aria-label="Close (Esc)"><i class="fa fa-times"></i></button>
			<button class="lb-btn lb-prev" data-act="lb-step" data-delta="-1" ${pos <= 0 ? 'disabled' : ''} aria-label="Previous (←)"><i class="fa fa-chevron-left"></i></button>
			<figure class="lb-figure">
				<img src="${esc(largePhotoUrl(u))}" alt="${esc(u.login)}">
				<figcaption>
					<div><b>${esc(u.login)}</b> <span class="muted">${esc(u.displayname || '')}</span></div>
					<div class="toolbar-group">
						<span class="muted num">${fmtNum(pos + 1)} / ${fmtNum(nav.length)}</span>
						<button class="btn btn-sm" data-act="lb-details" data-id="${u.id}"><i class="fa fa-user"></i>Details</button>
						<a class="btn btn-sm" href="${esc(largePhotoUrl(u))}" target="_blank" rel="noreferrer"><i class="fa fa-external-link"></i>Original</a>
					</div>
				</figcaption>
			</figure>
			<button class="lb-btn lb-next" data-act="lb-step" data-delta="1" ${pos >= nav.length - 1 ? 'disabled' : ''} aria-label="Next (→)"><i class="fa fa-chevron-right"></i></button>`;
		box.hidden = false;
		// warm up the neighbours so arrow navigation feels instant
		for (const d of [-1, 1]) {
			const n = S.byId.get(nav[pos + d]);
			if (n) new Image().src = largePhotoUrl(n);
		}
	}

	/* ---------- Export ---------- */

	const EX = {
		open: false, preset: store.get('export.preset', 'normal'), format: store.get('export.format', 'csv'), perExam: true, perProject: true,
		pdfLayout: store.get('export.pdfLayout', 'grid'), photos: store.get('export.photos', true), job: null, progress: null,
	};

	const EXPORT_PRESETS = {
		lite: { label: 'Lite', icon: 'fa-address-book-o', desc: 'Who they are and how to reach them' },
		normal: { label: 'Normal', icon: 'fa-id-card-o', desc: 'Plus wallet, evals, stage, cursus and level' },
		full: { label: 'Full', icon: 'fa-table', desc: 'Plus averages, dates, and the best mark of each exam and project' },
	};
	const PRESET_ORDER = ['lite', 'normal', 'full'];

	/** The 42cursus if they're in it, otherwise their most recent cursus. */
	function mainCursus(u) {
		const list = Array.isArray(u.cursus_users) ? u.cursus_users : [];
		return list.find((c) => c.cursus?.slug === '42cursus') || sortBy(list, (c) => c.begin_at, 'desc')[0] || null;
	}
	const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
	const round2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
	// the server leaves the counts empty for a profile without any project: they're 0 once it's fetched
	const passedCount = (u, field) => (Array.isArray(u.cursus_users) ? u[field].filter((e) => e['validated?'] === true).length : null);
	const IN_PROGRESS = new Set(['in_progress', 'waiting_for_correction', 'searching_a_group', 'creating_group', 'waiting_to_start']);

	// [key, label, getter, preset where it starts, needs a full scan]
	const EXPORT_COLUMNS = [
		['login', 'Login', (u) => u.login, 'lite'],
		['name', 'Name', (u) => u.usual_full_name || u.displayname, 'lite'],
		['email', 'Email', (u) => u.email, 'lite'],
		['pool', 'Pool', (u) => (u.pool_year ? `${humanize(u.pool_month)} ${u.pool_year}`.trim() : null), 'lite'],
		['location', 'Location', (u) => u.location || null, 'lite'],
		['intra', 'Intra profile', (u) => intraUrl(u.login), 'lite'],
		['wallet', 'Wallet', (u) => u.wallet, 'normal'],
		['eval_points', 'Eval points', (u) => u.correction_point, 'normal'],
		['joined', 'Joined', (u) => day(u.created_at), 'normal'],
		['stage', 'Stage', (u) => STAGES[u.stage]?.short || null, 'normal', true],
		['cursus', 'Cursus', (u) => mainCursus(u)?.cursus?.name || null, 'normal', true],
		['grade', 'Grade', (u) => mainCursus(u)?.grade || null, 'normal', true],
		['level', 'Level', (u) => round2(u.level), 'normal', true],
		['exams_passed', 'Exams passed', (u) => passedCount(u, '_exams'), 'normal', true],
		['projects_passed', 'Projects passed', (u) => passedCount(u, '_projects'), 'normal', true],
		['status', 'Status', (u) => (u['staff?'] ? 'staff' : u['alumni?'] ? 'alumni' : u['active?'] === false ? 'inactive' : 'active'), 'full'],
		['last_update', 'Last update', (u) => day(u.updated_at), 'full'],
		['cursus_end', 'Cursus ends', (u) => day(mainCursus(u)?.end_at), 'full', true],
		['blackhole', 'Blackhole', (u) => day(mainCursus(u)?.blackholed_at), 'full', true],
		['exam_avg', 'Exam average', (u) => round2(u.average_exam_final_mark), 'full', true],
		['project_avg', 'Project average', (u) => round2(u.average_project_final_mark), 'full', true],
		['overall_avg', 'Overall average', (u) => round2(u.average_mark), 'full', true],
		['cpiscine_final', 'C Piscine final exam', (u) => u.cpiscine_final_mark, 'full', true],
		['exam_attempts', 'Exam attempts', (u) => u._exams.length, 'full', true],
		['projects_ongoing', 'Projects in progress', (u) => u._projects.filter((e) => IN_PROGRESS.has(e.status)).length, 'full', true],
		['achievements', 'Achievements', (u) => (Array.isArray(u.achievements) ? u.achievements.length : null), 'full', true],
		['profile_fetched', 'Profile fetched', (u) => (u.lastSave ? new Date(Number(u.lastSave) * 1000).toISOString().slice(0, 16).replace('T', ' ') : null), 'full', true],
	];

	const exportStudents = () => visibleStudents();

	/** Exam or project names taken by the exported students, most common first. */
	function entryColumns(list, field) {
		const counts = new Map();
		for (const u of list) for (const name of new Set(u[field].map((e) => e.project?.name || e.project?.slug))) counts.set(name, (counts.get(name) || 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
	}

	/** Best attempt of each exam/project: mark, result, attempts and date, without the API noise. */
	function entrySummary(u, field) {
		return bestByName(u[field]).map(({ name, best, attempts }) => ({
			name,
			mark: isNum(best.final_mark) ? best.final_mark : null,
			validated: best['validated?'] ?? null,
			status: best.status || null,
			attempts,
			date: day(best.marked_at || best.updated_at),
		})).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
	}

	/** { columns: [[key, label]], rows: [[...values]], records: [{...}] } for the current options. */
	function buildExport(list = exportStudents()) {
		const level = PRESET_ORDER.indexOf(EX.preset);
		const fullscan = !!S.meta.fullscan;
		const cols = EXPORT_COLUMNS.filter(([, , , preset, needsScan]) => PRESET_ORDER.indexOf(preset) <= level && (fullscan || !needsScan));
		const columns = cols.map(([key, label]) => [key, label]);
		const rows = list.map((u) => cols.map(([, , get]) => get(u) ?? null));
		const full = EX.preset === 'full' && fullscan;
		let records = list.map((u, i) => Object.fromEntries(cols.map(([key], j) => [key, rows[i][j]])));
		if (full && EX.format === 'json') {
			records = records.map((r, i) => {
				const u = list[i];
				return {
					...r,
					all_cursus: (u.cursus_users || []).map((c) => ({
						name: c.cursus?.name, grade: c.grade || null, level: round2(c.level), begin: day(c.begin_at), end: day(c.end_at), blackhole: day(c.blackholed_at),
						skills: (c.skills || []).map((sk) => ({ name: sk.name, level: round2(sk.level) })),
					})),
					exams: entrySummary(u, '_exams'),
					projects: entrySummary(u, '_projects'),
				};
			});
		} else if (full) {
			// one column per exam / project: the best mark ("" if never attempted)
			for (const [field, on, prefix] of [['_exams', EX.perExam, 'Exam'], ['_projects', EX.perProject, 'Project']]) {
				if (!on) continue;
				for (const name of entryColumns(list, field)) {
					columns.push([`${prefix.toLowerCase()}:${name}`, `${prefix}: ${name}`]);
					list.forEach((u, i) => {
						const best = bestEntry(u[field].filter((e) => (e.project?.name || e.project?.slug) === name));
						rows[i].push(best ? (isNum(best.final_mark) ? best.final_mark : String(best.status || 'attempted').replace(/_/g, ' ')) : null);
					});
				}
			}
		}
		return { columns, rows, records };
	}

	function csvCell(v) {
		if (v === null || v === undefined) return '';
		const s = String(v);
		return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	}

	function exportText(data = buildExport()) {
		if (EX.format === 'json') return JSON.stringify(data.records, null, 2);
		return [data.columns.map(([, label]) => label), ...data.rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
	}

	function exportFilename() {
		const campus = S.meta.campuses.find((c) => c.id === S.meta.campusId);
		const slug = String(campus?.name || 'students').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
		return `campus-lens_${slug}_${EX.preset}_${new Date().toISOString().slice(0, 10)}.${EX.format}`;
	}

	function downloadExport() {
		if (EX.format === 'pdf') { if (!EX.job) downloadPdf(); return; }
		const text = exportText();
		// the BOM makes Excel read the CSV as UTF-8 (accents in names)
		const blob = new Blob([EX.format === 'csv' ? '﻿' + text : text], { type: EX.format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = exportFilename();
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
		toast(`Exported ${plural(exportStudents().length, 'student')} to <b>${esc(a.download)}</b>`);
	}

	/* ---------- PDF export ---------- */

	let jsPdfLoading = null;
	/** jsPDF is only loaded the first time a PDF is made. */
	function loadJsPdf() {
		if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
		jsPdfLoading = jsPdfLoading || new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = '/static/vendor/jspdf.umd.min.js';
			script.onload = () => resolve(window.jspdf.jsPDF);
			script.onerror = () => { jsPdfLoading = null; reject(new Error("Couldn't load the PDF library")); };
			document.head.appendChild(script);
		});
		return jsPdfLoading;
	}

	const PHOTO_PX = [250, 300];  // photos are cropped to 5:6 and kept small: the PDF stays light
	const PHOTO_RATIO = PHOTO_PX[1] / PHOTO_PX[0];
	const PDF_FACT_ROW = 5.8;
	const PDF_PAGE = { W: 210, H: 297, M: 12, top: 26, bottom: 279 };

	/** Card sizes of the Cards layout: every card gets the height of the fullest one. */
	function pdfGrid(list) {
		const { W, M, top, bottom } = PDF_PAGE;
		const cols = 5, gap = 3;
		const cw = (W - 2 * M - gap * (cols - 1)) / cols;
		const ph = EX.photos ? cw * PHOTO_RATIO : 0;
		const maxFacts = EX.preset === 'full' ? 12 : 8;
		const factRows = Math.ceil(Math.min(maxFacts, Math.max(0, ...list.map((u) => pdfFacts(u).length))) / 2);
		const ch = ph + 13 + factRows * PDF_FACT_ROW + 1;
		const rows = Math.max(1, Math.floor((bottom - top + gap) / (ch + gap)));
		return { cols, gap, cw, ph, ch, maxFacts, perPage: rows * cols };
	}
	const photoCache = new Map();

	/** The student's photo as a cropped JPEG data URL, or null (no photo, or the CDN failed). */
	function pdfPhoto(u) {
		const src = photoUrl(u);
		if (!src) return Promise.resolve(null);
		if (!photoCache.has(src)) {
			photoCache.set(src, (async () => {
				const res = await fetch(src, { mode: 'cors' });
				if (!res.ok) throw new Error(res.status);
				const bmp = await createImageBitmap(await res.blob());
				const [w, h] = PHOTO_PX;
				const scale = Math.max(w / bmp.width, h / bmp.height);
				const canvas = document.createElement('canvas');
				canvas.width = w;
				canvas.height = h;
				const ctx = canvas.getContext('2d');
				// cover crop, keeping the top of the photo (faces)
				ctx.drawImage(bmp, (w - bmp.width * scale) / 2, Math.min(0, (h - bmp.height * scale) * 0.25), bmp.width * scale, bmp.height * scale);
				return canvas.toDataURL('image/jpeg', 0.82);
			})().catch(() => null));
		}
		return photoCache.get(src);
	}

	async function loadPhotos(list, onProgress, cancelled) {
		const photos = new Map();
		let next = 0, done = 0;
		const worker = async () => {
			while (next < list.length && !cancelled()) {
				const u = list[next++];
				photos.set(u.id, await pdfPhoto(u));
				onProgress(++done, list.length);
			}
		};
		await Promise.all(Array.from({ length: 6 }, worker));
		return photos;
	}

	/** The standard PDF fonts only know Latin-1: other letters lose their accents (ł → l), the rest becomes '?'. */
	function pdfText(v) {
		return [...String(v ?? '').normalize('NFC')].map((c) => {
			if (c.charCodeAt(0) <= 255) return c;
			const base = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
			return base.length === 1 && base.charCodeAt(0) <= 255 ? base : '?';
		}).join('');
	}

	const exportValue = (u, key) => EXPORT_COLUMNS.find(([k]) => k === key)?.[2](u) ?? null;

	/** "Label value" pairs shown for a student, by preset (only the ones with a value). */
	function pdfFacts(u) {
		const level = PRESET_ORDER.indexOf(EX.preset);
		const facts = [];
		const add = (minLevel, label, value) => { if (level >= minLevel && value !== null && value !== undefined && value !== '') facts.push([label, String(value)]); };
		add(1, 'Level', isNum(u.level) ? fmtNum(u.level, 2) : null);
		add(1, 'Wallet', isNum(u.wallet) ? fmtNum(u.wallet) : null);
		add(1, 'Evals', u.correction_point);
		add(1, 'Stage', exportValue(u, 'stage'));
		add(1, 'Grade', exportValue(u, 'grade'));
		add(1, 'Cursus', exportValue(u, 'cursus'));
		add(1, 'Exams passed', exportValue(u, 'exams_passed'));
		add(1, 'Projects passed', exportValue(u, 'projects_passed'));
		add(1, 'Joined', exportValue(u, 'joined'));
		add(2, 'Exam avg', isNum(u.average_exam_final_mark) ? fmtNum(u.average_exam_final_mark, 1) : null);
		add(2, 'Project avg', isNum(u.average_project_final_mark) ? fmtNum(u.average_project_final_mark, 1) : null);
		add(2, 'Overall avg', isNum(u.average_mark) ? fmtNum(u.average_mark, 1) : null);
		add(2, 'C Piscine final', u.cpiscine_final_mark);
		add(2, 'Cursus ends', exportValue(u, 'cursus_end'));
		add(2, 'Blackhole', exportValue(u, 'blackhole'));
		return facts;
	}

	const PDF = {
		accent: [0, 150, 152], text: [20, 23, 28], muted: [110, 118, 130], line: [222, 226, 231], soft: [243, 245, 247],
		ok: [26, 127, 55], okSoft: [220, 241, 226], bad: [207, 34, 46], badSoft: [250, 225, 227], none: [235, 237, 240],
	};

	/** Builds the PDF of `list`. `photos`: Map of student id → data URL (or null). */
	function buildPdf(jsPDF, list, photos) {
		const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
		const { W, H, M, top, bottom } = PDF_PAGE;
		const m = S.meta;
		const campus = m.campuses.find((c) => c.id === m.campusId)?.name || 'Students';
		const filters = S.applied.filter(([k]) => k !== 'campus_id').map(([k, v]) => FLAG_PARAMS.has(k) ? (PARAM_LABELS[k] || k) : `${PARAM_LABELS[k] || k} ${v}`);
		if (S.q) filters.push(`search "${S.q}"`);
		const color = (rgb, kind = 'text') => (kind === 'fill' ? doc.setFillColor(...rgb) : kind === 'draw' ? doc.setDrawColor(...rgb) : doc.setTextColor(...rgb));
		const font = (size, style = 'normal', rgb = PDF.text) => { doc.setFont('helvetica', style); doc.setFontSize(size); color(rgb); };
		const fit = (text, width) => doc.splitTextToSize(pdfText(text), width)[0] || '';

		const header = () => {
			font(13, 'bold', PDF.accent);
			doc.text('campus-lens', M, M + 4);
			font(13, 'bold');
			doc.text(pdfText(campus), M + doc.getTextWidth('campus-lens '), M + 4);
			font(8, 'normal', PDF.muted);
			doc.text(`${plural(list.length, 'student')} · ${EXPORT_PRESETS[EX.preset].label} · ${new Date().toISOString().slice(0, 10)}`, W - M, M + 4, { align: 'right' });
			doc.text(fit(filters.length ? `Filters: ${filters.join(' · ')}` : 'No filters', W - 2 * M), M, M + 9);
			color(PDF.line, 'draw');
			doc.setLineWidth(0.3);
			doc.line(M, M + 11, W - M, M + 11);
		};

		const drawPhoto = (u, x, y, w, h) => {
			const data = photos.get(u.id);
			if (data) {
				doc.addImage(data, 'JPEG', x, y, w, h, `p${u.id}`, 'FAST');
			} else {
				color(PDF.soft, 'fill');
				doc.rect(x, y, w, h, 'F');
				font(w > 30 ? 20 : 12, 'bold', PDF.muted);
				doc.text(pdfText(((u.first_name || u.login || '?')[0] + (u.last_name || '')[0] || '').toUpperCase()), x + w / 2, y + h / 2 + 2, { align: 'center' });
			}
		};

		/** Exam/project best marks as coloured chips, wrapped; returns the y below them. */
		const chips = (entries, x, y, maxX, draw = true) => {
			let cx = x, cy = y;
			doc.setFont('helvetica', 'normal');
			doc.setFontSize(6.5);
			for (const { name, best } of entries) {
				const mark = isNum(best.final_mark) ? String(best.final_mark) : humanize(best.status || '').toLowerCase() || '—';
				const label = `${pdfText(name)}  ${mark}`;
				const w = Math.min(doc.getTextWidth(label) + 3, maxX - x);
				if (cx + w > maxX && cx > x) { cx = x; cy += 4.2; }
				if (draw) {
					const ok = best['validated?'];
					color(ok === true ? PDF.okSoft : ok === false ? PDF.badSoft : PDF.none, 'fill');
					doc.roundedRect(cx, cy, w, 3.4, 0.8, 0.8, 'F');
					color(ok === true ? PDF.ok : ok === false ? PDF.bad : PDF.muted);
					doc.text(fit(label, w - 3), cx + 1.5, cy + 2.45);
				}
				cx += w + 1.2;
			}
			return entries.length ? cy + 4.2 : y;
		};

		const withEntries = EX.preset === 'full' && m.fullscan;
		const entriesOf = (u) => ({
			exams: bestByName(u._exams).sort((a, b) => String(b.best.marked_at || '').localeCompare(String(a.best.marked_at || ''))),
			projects: bestByName(u._projects).sort((a, b) => String(b.best.marked_at || b.best.updated_at || '').localeCompare(String(a.best.marked_at || a.best.updated_at || ''))),
		});

		header();
		if (EX.pdfLayout === 'grid') {
			const { cols, gap, cw, ph, ch, maxFacts } = pdfGrid(list);
			let i = 0, y = top;
			for (const u of list) {
				const col = i % cols;
				if (col === 0 && i > 0) y += ch + gap;
				if (col === 0 && y + ch > bottom) { doc.addPage(); header(); y = top; }
				const x = M + col * (cw + gap);
				color(PDF.line, 'draw');
				doc.setLineWidth(0.25);
				doc.roundedRect(x, y, cw, ch, 2, 2, 'S');
				if (EX.photos) drawPhoto(u, x + 0.6, y + 0.6, cw - 1.2, ph - 0.6);
				let ty = y + ph + 4;
				// the login links to the intra profile
				font(8.5, 'bold', PDF.accent);
				doc.textWithLink(fit(u.login, cw - 4), x + 2, ty, { url: intraUrl(u.login) });
				font(6.5, 'normal', PDF.text);
				doc.text(fit(u.usual_full_name || u.displayname, cw - 4), x + 2, ty += 3.3);
				font(6, 'normal', PDF.muted);
				doc.text(fit(u.pool_year ? `Pool ${humanize(u.pool_month)} ${u.pool_year}` : ' ', cw - 4), x + 2, ty += 3);
				ty += 1.5;
				const facts = pdfFacts(u);
				for (let f = 0; f < Math.min(maxFacts, facts.length); f += 2) {
					for (const [j, fact] of [facts[f], facts[f + 1]].entries()) {
						if (!fact) continue;
						const fx = x + 2 + j * (cw - 4) / 2;
						font(4.8, 'normal', PDF.muted);
						const label = fact[0] === 'Projects passed' ? 'Proj. passed' : fact[0];  // cards are narrow
						doc.text(fit(pdfText(label).toUpperCase(), (cw - 4) / 2 - 1), fx, ty + 2);
						font(6.5, 'bold');
						doc.text(fit(fact[1], (cw - 4) / 2 - 1), fx, ty + 4.6);
					}
					ty += PDF_FACT_ROW;
				}
				i++;
			}
		} else {
			// one block per student: photo, identity, facts, and (full) exams/projects
			const pw = EX.photos ? 22 : 0, ph = pw * PHOTO_RATIO;
			const tx = M + (pw ? pw + 5 : 0), tw = W - M - tx;
			let y = top;
			list.forEach((u, idx) => {
				const facts = pdfFacts(u);
				const factRows = Math.ceil(facts.length / 5);
				const entries = withEntries ? entriesOf(u) : null;
				const measure = (yy) => {
					let h = 12 + factRows * 7.5;
					if (entries) {
						for (const kind of ['exams', 'projects']) if (entries[kind].length) h = chips(entries[kind], tx + 16, yy + h, W - M, false) - yy + 1;
					}
					return Math.max(h, ph) + 4;
				};
				let bh = measure(y);
				if (y + bh > bottom && y > top) { doc.addPage(); header(); y = top; bh = measure(y); }
				if (EX.photos) drawPhoto(u, M, y, pw, ph);
				font(11, 'bold', PDF.accent);
				doc.textWithLink(pdfText(u.login), tx, y + 4, { url: intraUrl(u.login) });
				const lw = doc.getTextWidth(pdfText(u.login));
				font(9, 'normal');
				doc.text(fit(u.usual_full_name || u.displayname, tw - lw - 4), tx + lw + 3, y + 4);
				font(7.5, 'normal', PDF.muted);
				const contact = [u.email, u.pool_year ? `Pool ${humanize(u.pool_month)} ${u.pool_year}` : null].filter(Boolean).join('  ·  ');
				doc.text(fit(contact, tw), tx, y + 8.5);
				let fy = y + 12;
				facts.forEach(([label, value], f) => {
					const fx = tx + (f % 5) * (tw / 5);
					if (f && f % 5 === 0) fy += 7.5;
					font(5.5, 'normal', PDF.muted);
					doc.text(pdfText(label).toUpperCase(), fx, fy + 2);
					font(8, 'bold');
					doc.text(fit(value, tw / 5 - 2), fx, fy + 5.5);
				});
				let ey = y + 12 + factRows * 7.5;
				if (entries) {
					for (const [kind, label] of [['exams', 'Exams'], ['projects', 'Projects']]) {
						if (!entries[kind].length) continue;
						font(6, 'bold', PDF.muted);
						doc.text(label.toUpperCase(), tx, ey + 2.5);
						ey = chips(entries[kind], tx + 16, ey, W - M) + 1;
					}
				}
				y += bh;
				if (idx < list.length - 1) {
					color(PDF.line, 'draw');
					doc.setLineWidth(0.2);
					doc.line(M, y - 2, W - M, y - 2);
				}
			});
		}

		const pages = doc.getNumberOfPages();
		for (let p = 1; p <= pages; p++) {
			doc.setPage(p);
			font(7, 'normal', PDF.muted);
			doc.text(`Page ${p} of ${pages}`, W - M, H - M + 2, { align: 'right' });
			doc.text('Data from the 42 API · generated by campus-lens', M, H - M + 2);
		}
		doc.setProperties({ title: `campus-lens — ${pdfText(campus)}`, subject: `${list.length} students`, creator: 'campus-lens' });
		return doc;
	}

	/** Rough page count, shown before building. */
	function pdfPages(n) {
		if (!n) return 0;
		if (EX.pdfLayout === 'grid') return Math.ceil(n / pdfGrid(exportStudents()).perPage);
		const perPage = EX.preset === 'full' && S.meta.fullscan ? 5 : EX.photos ? 8 : 12;
		return Math.ceil(n / perPage);
	}

	async function downloadPdf() {
		const list = exportStudents();
		const run = (EX.job = { cancelled: false });
		const cancelled = () => run.cancelled || EX.job !== run;
		const status = (text) => { EX.progress = text; if (EX.open) renderExport(); };
		try {
			status('Loading the PDF library…');
			const jsPDF = await loadJsPdf();
			const photos = EX.photos
				? await loadPhotos(list, (done, total) => status(`Loading photos ${fmtNum(done)} / ${fmtNum(total)}…`), cancelled)
				: new Map();
			if (cancelled()) return;
			status('Building the PDF…');
			await new Promise((r) => setTimeout(r, 30));  // let the status paint
			const doc = buildPdf(jsPDF, list, photos);
			doc.save(exportFilename());
			const missing = EX.photos ? list.filter((u) => photoUrl(u) && !photos.get(u.id)).length : 0;
			toast(`Exported ${plural(list.length, 'student')} to <b>${esc(exportFilename())}</b>${missing ? ` (${plural(missing, 'photo')} couldn't be loaded)` : ''}`, null, 5000);
		} catch (e) {
			console.error(e);
			toast(`Couldn't make the PDF: ${esc(e.message || e)}`, null, 6000);
		} finally {
			if (EX.job === run) { EX.job = null; status(null); }
		}
	}

	function openExport() {
		if (!S.meta || S.meta.error) return;
		EX.open = true;
		closeMenu();
		renderExport();
		$('#export-modal').hidden = false;
	}

	function closeExport() {
		EX.open = false;
		// closing stops a PDF still loading photos
		if (EX.job) EX.job.cancelled = true;
		$('#export-modal').hidden = true;
	}

	/** A small HTML sketch of the first PDF entries (the real PDF uses the same fields). */
	function renderPdfPreview(list) {
		const sample = list.slice(0, EX.pdfLayout === 'grid' ? 5 : 2);
		const facts = (u) => pdfFacts(u).slice(0, EX.pdfLayout === 'grid' ? (EX.preset === 'full' ? 12 : 8) : 15)
			.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
		const pic = (u) => EX.photos ? `<div class="pp-photo photo">${photo(u)}</div>` : '';
		const entries = (u) => EX.preset === 'full' && S.meta.fullscan
			? ['_exams', '_projects'].map((f) => bestByName(u[f]).slice(0, 8).map(({ name, best }) => entryChip(f === '_exams' ? 'exams' : 'projects', best)).join('')).join('')
			: '';
		return `
			<div class="pdf-preview ${EX.pdfLayout}">
				<div class="pp-page">
					${sample.map((u) => EX.pdfLayout === 'grid' ? `
						<div class="pp-card">${pic(u)}<div class="pp-body"><b class="pp-login">${esc(u.login)}</b><div>${esc(u.usual_full_name || u.displayname)}</div>
							<small>${u.pool_year ? `Pool ${esc(humanize(u.pool_month))} ${esc(u.pool_year)}` : ''}</small><div class="pp-facts">${facts(u)}</div></div></div>` : `
						<div class="pp-row">${pic(u)}<div class="pp-body"><div><b class="pp-login">${esc(u.login)}</b> ${esc(u.usual_full_name || u.displayname)}</div>
							<small>${esc([u.email, u.pool_year ? `Pool ${humanize(u.pool_month)} ${u.pool_year}` : ''].filter(Boolean).join(' · '))}</small>
							<div class="pp-facts">${facts(u)}</div><div class="echips">${entries(u)}</div></div></div>`).join('')}
				</div>
				<p class="field-hint">Preview of the first ${plural(sample.length, 'student')}. Each login links to the intra profile.</p>
			</div>`;
	}

	function renderExport() {
		if (!EX.open) return;
		const m = S.meta;
		const list = exportStudents();
		const data = buildExport(list);
		const fullscan = !!m.fullscan;
		const skipped = fullscan ? [] : EXPORT_COLUMNS.filter(([, , , preset, needsScan]) => needsScan && PRESET_ORDER.indexOf(preset) <= PRESET_ORDER.indexOf(EX.preset));
		const preview = data.rows.slice(0, 5);
		const fullJson = EX.preset === 'full' && fullscan && EX.format === 'json';
		$('#export-modal').innerHTML = `
			<div class="modal-card modal-wide export-card" role="dialog" aria-label="Export students">
				<div class="sheet-head">
					<div style="flex:1">
						<h2>Export students</h2>
						<div class="field-hint">${plural(list.length, 'student')} — the current filters, search and sort${S.q ? ` (search “${esc(S.q)}”)` : ''}.</div>
					</div>
					<button class="btn btn-ghost icon-btn" data-act="ex-close" aria-label="Close (Esc)"><i class="fa fa-times"></i></button>
				</div>
				<div class="sheet-body export-body">
					<div class="export-presets">
						${PRESET_ORDER.map((k) => {
							const p = EXPORT_PRESETS[k];
							return `<button class="export-preset ${EX.preset === k ? 'on' : ''}" data-act="ex-preset" data-preset="${k}">
								<i class="fa ${p.icon}"></i><b>${p.label}</b><span>${p.desc}</span></button>`;
						}).join('')}
					</div>
					<div class="export-options">
						<div class="segmented" role="group" aria-label="Format">
							<button class="${EX.format === 'csv' ? 'active' : ''}" data-act="ex-format" data-format="csv"><i class="fa fa-file-excel-o"></i>CSV</button>
							<button class="${EX.format === 'json' ? 'active' : ''}" data-act="ex-format" data-format="json"><i class="fa fa-file-code-o"></i>JSON</button>
							<button class="${EX.format === 'pdf' ? 'active' : ''}" data-act="ex-format" data-format="pdf"><i class="fa fa-file-pdf-o"></i>PDF</button>
						</div>
						${EX.format === 'pdf' ? `
							<div class="segmented" role="group" aria-label="PDF layout">
								<button class="${EX.pdfLayout === 'grid' ? 'active' : ''}" data-act="ex-layout" data-layout="grid" title="Photo cards, 12 per page"><i class="fa fa-th-large"></i>Cards</button>
								<button class="${EX.pdfLayout === 'list' ? 'active' : ''}" data-act="ex-layout" data-layout="list" title="One block per student${EX.preset === 'full' ? ', with their exams and projects' : ''}"><i class="fa fa-list"></i>Detailed</button>
							</div>
							<label class="switch"><input type="checkbox" data-bind="ex-photos" ${EX.photos ? 'checked' : ''}><span class="track"></span><span>Photos</span></label>` : ''}
						${EX.preset === 'full' && fullscan && EX.format === 'csv' ? `
							<label class="switch"><input type="checkbox" data-bind="ex-per-exam" ${EX.perExam ? 'checked' : ''}><span class="track"></span><span>A column per exam</span></label>
							<label class="switch"><input type="checkbox" data-bind="ex-per-project" ${EX.perProject ? 'checked' : ''}><span class="track"></span><span>A column per project</span></label>` : ''}
						<span class="field-hint">${EX.format === 'pdf' ? `A4 · about ${plural(pdfPages(list.length), 'page')}${EX.photos && list.length > 300 ? ` · ${fmtNum(list.length)} photos to download first` : ''}` : EX.format === 'csv' ? `${plural(data.columns.length, 'column')} · opens in Excel, Sheets, Numbers` : fullJson ? 'One object per student, with their cursus, exams and projects' : 'One object per student'}</span>
					</div>
					${skipped.length ? `
						<div class="notice warn"><i class="fa fa-bolt"></i>
							<div class="notice-body"><div class="notice-title">${plural(skipped.length, 'column')} need a full scan</div>
								<div class="notice-text">${skipped.map(([, label]) => esc(label)).join(', ')} — left out until each profile is loaded.</div></div>
							<div class="notice-actions"><button class="btn btn-primary btn-sm" data-act="ex-fullscan"><i class="fa fa-bolt"></i>Run full scan</button></div>
						</div>` : ''}
					${EX.format === 'pdf' ? renderPdfPreview(list) : `<div class="export-columns">${data.columns.map(([key, label]) => `<span class="chip static ${key.includes(':') ? 'chip-entry' : ''}">${esc(label)}</span>`).join('')}</div>
					${fullJson ? `<pre class="json export-json">${highlightJson(JSON.stringify(data.records.slice(0, 2), null, 2))}</pre>` : `
						<div class="table-wrap export-preview">
							<table class="data compact">
								<thead><tr>${data.columns.map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead>
								<tbody>${preview.map((r) => `<tr>${r.map((v) => `<td>${v === null ? '<span class="muted">—</span>' : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
							</table>
						</div>`}
					${list.length > preview.length && !fullJson ? `<p class="field-hint" style="margin-top:6px">Preview of the first ${preview.length} of ${fmtNum(list.length)} rows.</p>` : ''}`}
				</div>
				<div class="sheet-foot">
					<span class="field-hint mono">${esc(exportFilename())}</span>
					<span class="grow"></span>
					${EX.progress ? `<span class="field-hint export-progress"><span class="spinner spinner-sm"></span>${esc(EX.progress)}</span>` : ''}
					${EX.format === 'pdf' ? '' : `<button class="btn" data-act="ex-copy" ${list.length ? '' : 'disabled'}><i class="fa fa-clipboard"></i>Copy</button>`}
					<button class="btn btn-primary" data-act="ex-download" ${list.length && !EX.job ? '' : 'disabled'}><i class="fa fa-download"></i>Download ${EX.format.toUpperCase()}</button>
				</div>
			</div>`;
	}

	/* ---------- Campus manager ---------- */

	const CM = { open: false, data: null, jobs: null, q: '', filter: 'all', sel: new Set(), seen: null, timer: null, force: false };

	function fmtAgo(ts) {
		if (!ts) return 'never';
		const s = Math.max(0, Date.now() / 1000 - ts);
		if (s < 60) return 'just now';
		if (s < 3600) return `${Math.floor(s / 60)} min ago`;
		if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
		return `${Math.floor(s / 86400)} d ago`;
	}

	function fetchEstimate(users) {
		if (!isNum(users)) return '';
		const seconds = Math.ceil(users / 100) * 0.6;
		return seconds < 60 ? '< 1 min' : `~${Math.ceil(seconds / 60)} min`;
	}

	async function postJson(url, body = {}) {
		const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || `Server responded ${res.status}`);
		return data;
	}

	const jobsActive = () => !!(CM.jobs && (CM.jobs.current || CM.jobs.queue.length));

	async function refreshCampuses() {
		try {
			const res = await fetch('/api/campuses');
			const data = await res.json();
			CM.data = data;
			handleJobs(data.jobs);
			// first visit: get the campus list (names only) automatically
			const catalogQueued = [data.jobs.current, ...data.jobs.queue].some((j) => j?.type === 'catalog');
			if (!data.catalogFetchedAt && !catalogQueued && !CM.autoCatalog) {
				CM.autoCatalog = true;
				handleJobs(await postJson('/api/campuses/catalog'));
			}
		} catch (e) {
			toast(`Couldn't load campuses: ${esc(e.message)}`);
		}
		if (CM.open) keepFocus(renderCampusManager);
	}

	function handleJobs(jobs) {
		const firstLook = CM.seen === null;
		CM.seen = CM.seen || new Set();
		CM.jobs = jobs;
		let finished = false;
		for (const job of jobs.history) {
			if (CM.seen.has(job.id)) continue;
			CM.seen.add(job.id);
			if (!firstLook) { finished = true; onJobFinished(job); }
		}
		// poll only while a fetch is queued or running
		if (jobsActive()) startPolling(); else stopPolling();
		$('#btn-campuses').classList.toggle('busy', jobsActive());
		$('#btn-campuses').innerHTML = jobsActive() ? '<span class="spinner spinner-sm"></span>' : '<i class="fa fa-cloud-download"></i>';
		return finished;
	}

	function onJobFinished(job) {
		if (job.status === 'cancelled') {
			const kept = job.type === 'details' && job.done;
			toast(`Cancelled: ${esc(job.name)}${kept ? ` (${plural(job.done, 'profile')} kept)` : ''}`);
			if (kept) { S.loadedKey = null; load({ keepStaged: clonePairs(S.staged) }); }
			return;
		}
		if (job.status === 'error') {
			toast(`Couldn't fetch <b>${esc(job.name)}</b>: ${esc(job.error || 'unknown error')}`, null, 7000);
			return;
		}
		if (job.type === 'catalog') {
			toast(`Campus list updated: ${fmtNum(job.count)} campuses`);
			return;
		}
		if (job.type === 'details') {
			const parts = [`${plural(job.fetched, 'profile')} fetched${job.force ? ' again' : ''}`];
			if (job.skipped) parts.push(`${fmtNum(job.skipped)} already up to date`);
			if (job.failed) parts.push(`${fmtNum(job.failed)} failed`);
			toast(`Details of <b>${esc(job.name)}</b>: ${parts.join(', ')}`, { label: 'Open', run: () => openCampus(job.campusId, true) }, 6000);
		} else if (job.skipped) {
			toast(`Student list of <b>${esc(job.name)}</b> is up to date (${plural(job.count, 'student')}) — turn on <b>Force</b> to fetch it anyway`, null, 6000);
			return;
		} else {
			toast(`Fetched <b>${esc(job.name)}</b>: ${plural(job.count, 'student')}${job.kept ? ` (${fmtNum(job.kept)} older ones kept)` : ''}`, { label: 'Open', run: () => openCampus(job.campusId) }, 6000);
		}
		// refresh the campus selector, and the data if this campus is on screen
		S.loadedKey = null;
		load({ keepStaged: clonePairs(S.staged) });
	}

	async function refreshJobs() {
		try {
			const res = await fetch('/api/jobs');
			const finished = handleJobs(await res.json());
			if (CM.open) {
				if (finished) refreshCampuses();
				else keepFocus(renderCampusManager);
			}
		} catch (e) { /* server restarting: try again next tick */ }
	}

	function startPolling() {
		if (CM.timer) return;
		CM.timer = setInterval(refreshJobs, 1000);
	}

	function stopPolling() {
		clearInterval(CM.timer);
		CM.timer = null;
	}

	function openCampusManager() {
		CM.open = true;
		closeMenu();
		$('#campus-manager').hidden = false;
		renderCampusManager();
		refreshCampuses();
		requestAnimationFrame(() => $('[data-bind="cm-q"]')?.focus());
	}

	function closeCampusManager() {
		CM.open = false;
		$('#campus-manager').hidden = true;
	}

	function openCampus(id, fullscan = false) {
		closeCampusManager();
		applyNow((p) => {
			setParam(p, 'campus_id', id);
			if (fullscan) setParam(p, 'fullscan', '');
		});
	}

	/** Queues `what` ('students', 'details' or 'both') for campuses, honouring the Force switch. */
	async function fetchCampuses(ids, what = 'students') {
		try {
			handleJobs(await postJson('/api/campuses/fetch', { ids, what, force: CM.force }));
			CM.sel.clear();
			renderCampusManager();
		} catch (e) {
			toast(`Couldn't start the fetch: ${esc(e.message)}`);
		}
	}

	function campusJob(id, type) {
		if (!CM.jobs) return null;
		return [CM.jobs.current, ...CM.jobs.queue].find((j) => j && j.campusId === id && j.type === type) || null;
	}

	function jobProgress(job) {
		const pct = job.total ? Math.min(100, Math.round(job.done / job.total * 100)) : null;
		let right = job.startedAt ? fmtDuration(Date.now() - job.startedAt * 1000) : '';
		// profiles are fetched one by one at ~2 requests/second
		const profiles = job.type === 'details';
		if (profiles && job.total) right = `${apiEstimate(job.total - job.done)} left`;
		const label = job.status === 'queued' ? `Queued${job.force ? ' · forced' : ''}`
			: job.cancel ? 'Cancelling…'
			: `${profiles ? 'Profiles' : 'Students'} ${fmtNum(job.done)}${job.total !== null && job.total !== undefined ? ' / ' + fmtNum(job.total) : ''}`;
		return `
			<div class="job-progress">
				<div class="row">
					<span><span class="spinner spinner-sm"></span>${label}</span>
					<span class="muted num">${right}
						<button class="btn btn-ghost btn-xs icon-btn" data-act="cm-cancel" data-job="${job.id}" title="Cancel" ${job.cancel ? 'disabled' : ''}><i class="fa fa-times"></i></button>
					</span>
				</div>
				<span class="progress ${pct === null ? 'indeterminate' : ''}"><i style="width:${pct ?? 30}%"></i></span>
			</div>`;
	}

	const cacheHours = () => CM.data?.cacheHours ?? S.meta?.cacheHours ?? 6;

	/** Profiles a details fetch would request for campus `c` with the current Force switch. */
	function detailsTodo(c) {
		if (!c.local) return null;
		return CM.force ? c.local.count : c.local.count - c.local.detailed + (c.local.outdated || 0);
	}

	function detailsCell(c) {
		const job = campusJob(c.id, 'details');
		if (job) return jobProgress(job);
		if (!c.local) return '<span class="muted">—</span>';
		const pct = c.local.count ? Math.round(c.local.detailed / c.local.count * 100) : 0;
		const missing = c.local.count - c.local.detailed;
		const fresh = c.local.detailed - (c.local.outdated || 0);
		return `
			<div class="job-progress">
				<div class="row"><span>${fmtNum(c.local.detailed)} / ${fmtNum(c.local.count)} profiles</span><span class="muted">${missing ? `${fmtNum(missing)} missing` : 'complete'}</span></div>
				<span class="progress stacked" title="${fmtNum(fresh)} fetched in the last ${cacheHours()}h, ${fmtNum(c.local.outdated || 0)} older, ${fmtNum(missing)} never fetched">
					<i style="width:${pct}%" class="${pct === 100 && !c.local.outdated ? 'complete' : ''}"></i>
					<i class="fresh" style="width:${c.local.count ? fresh / c.local.count * 100 : 0}%"></i>
				</span>
				${c.local.outdated ? `<div class="field-hint">${fmtNum(c.local.outdated)} older than ${cacheHours()}h</div>` : ''}
			</div>`;
	}

	function studentsCell(c) {
		const job = campusJob(c.id, 'campus');
		if (job) return jobProgress(job);
		if (!c.local) return '<span class="muted">Not fetched</span>';
		return `<div><span class="dot ${c.local.outdatedList ? 'stale' : 'online'}" style="display:inline-block;margin-right:8px"></span>${plural(c.local.count ?? 0, 'student')}</div>
			<div class="field-hint" title="${esc(new Date(c.local.fetchedAt * 1000).toLocaleString())}">fetched ${fmtAgo(c.local.fetchedAt)}${c.local.outdatedList ? ` · <span class="warn-text">older than ${cacheHours()}h</span>` : ''}</div>`;
	}

	/** [disabled, title] of a campus's Students button. */
	function studentsAction(c) {
		if (campusJob(c.id, 'campus')) return [true, 'Already queued'];
		if (!c.local) return [false, 'Download the student list'];
		if (!CM.force && !c.local.outdatedList) return [true, `Fetched ${fmtAgo(c.local.fetchedAt)}, up to date — turn on Force to fetch it again`];
		return [false, `${CM.force ? 'Force: download' : 'Download'} the student list again (${fetchEstimate(c.local.count)}); students no longer returned are kept`];
	}

	/** [disabled, title] of a campus's Details button. */
	function detailsAction(c) {
		if (campusJob(c.id, 'details')) return [true, 'Already queued'];
		if (!c.local) return [false, 'Fetch the student list, then every profile'];
		const n = detailsTodo(c);
		if (!n) return [true, `Every profile was fetched in the last ${cacheHours()}h — turn on Force to fetch them again`];
		const what = CM.force ? `all ${fmtNum(n)} profiles again` : `${fmtNum(n)} missing or outdated profiles`;
		return [false, `Fetch ${what} (${apiEstimate(n)})`];
	}

	function renderCampusManager() {
		const box = $('#campus-manager');
		if (!CM.open) return;
		const data = CM.data;
		const currentId = S.meta?.campusId;
		let list = data?.campuses || [];
		const q = CM.q.toLowerCase();
		list = list.filter((c) =>
			(!q || [c.name, c.city, c.country, String(c.id)].some((v) => String(v || '').toLowerCase().includes(q))) &&
			(CM.filter === 'all' || (CM.filter === 'fetched' ? !!c.local : !c.local)));
		list = sortBy(list, (c) => `${c.isDefault ? 0 : 1}${c.local ? 0 : 1}${c.name}`, 'asc');
		const fetchedN = (data?.campuses || []).filter((c) => c.local).length;
		const queue = CM.jobs ? [CM.jobs.current, ...CM.jobs.queue].filter(Boolean) : [];
		const catalogJob = queue.find((j) => j.type === 'catalog');
		const allSelected = list.length && list.every((c) => CM.sel.has(c.id));

		box.innerHTML = `
			<div class="modal-card modal-wide" role="dialog" aria-label="Campuses">
				<div class="sheet-head">
					<div style="flex:1">
						<h2>Campuses</h2>
						<div class="field-hint">Fetch a campus's students from the 42 API. Fetched campuses appear in the campus selector; fetch again to update them.</div>
					</div>
					<button class="btn btn-ghost icon-btn" data-act="cm-close" aria-label="Close (Esc)"><i class="fa fa-times"></i></button>
				</div>
				<div class="cm-toolbar">
					<label class="search" style="max-width:none">
						<i class="fa fa-search" aria-hidden="true"></i>
						<input type="search" placeholder="Search campus, city or country…" value="${esc(CM.q)}" data-bind="cm-q" autocomplete="off">
					</label>
					<div class="segmented">
						${[['all', 'All'], ['fetched', `Fetched · ${fetchedN}`], ['missing', 'Not fetched']].map(([k, l]) => `<button class="${CM.filter === k ? 'active' : ''}" data-act="cm-filter" data-filter="${k}">${l}</button>`).join('')}
					</div>
					<label class="switch cm-force ${CM.force ? 'on' : ''}" title="Fetch again even what was fetched in the last ${cacheHours()}h">
						<input type="checkbox" data-bind="cm-force" ${CM.force ? 'checked' : ''}><span class="track"></span>
						<span><b>Force rescan</b><small>${CM.force ? 'Everything is fetched again' : `Only what is missing or older than ${cacheHours()}h`}</small></span>
					</label>
					<div class="cm-catalog">
						<span class="field-hint">List updated ${fmtAgo(data?.catalogFetchedAt)}</span>
						<button class="btn btn-sm" data-act="cm-catalog" ${catalogJob ? 'disabled' : ''}><i class="fa fa-refresh ${catalogJob ? 'fa-spin' : ''}"></i>Refresh list</button>
					</div>
				</div>
				<div class="cm-list">
					${!data ? '<div class="empty" style="border:0"><div class="spinner"></div></div>' : !data.campuses.length ? `
						<div class="empty" style="border:0"><i class="fa fa-globe"></i><h3>No campus list yet</h3>
							<p>Download the list of 42 campuses to choose which ones to fetch.</p>
							<div class="actions"><button class="btn btn-primary" data-act="cm-catalog" ${catalogJob ? 'disabled' : ''}><i class="fa fa-cloud-download"></i>Download campus list</button></div></div>` : `
						<table class="data">
							<thead><tr>
								<th style="width:44px"><button class="cm-check ${allSelected ? 'on' : ''}" data-act="cm-toggle-all" aria-label="Select all"><i class="fa fa-check"></i></button></th>
								<th>Campus</th><th class="r">Users</th>
								<th title="The campus's student list (login, name, pool, wallet…)">Students</th>
								<th title="Full profiles: exams, projects, cursus — what a full scan needs. Outdated after ${cacheHours()}h.">Details</th>
								<th class="r"></th>
							</tr></thead>
							<tbody>
								${list.map((c) => {
									const [studentsOff, studentsTitle] = studentsAction(c);
									const [detailsOff, detailsTitle] = detailsAction(c);
									return `
										<tr class="clickable ${c.active === false ? 'dim' : ''}" data-act="cm-toggle" data-id="${c.id}">
											<td><span class="cm-check ${CM.sel.has(c.id) ? 'on' : ''}"><i class="fa fa-check"></i></span></td>
											<td>
												<div class="cm-name">
													<b>${esc(c.name)}</b>
													${c.isDefault ? '<span class="badge accent" title="Opened when no campus is selected">Default</span>' : ''}
													${c.id === currentId ? '<span class="badge info">Viewing</span>' : ''}
													${c.active === false ? '<span class="badge">Inactive</span>' : ''}
												</div>
												<div class="field-hint">${esc([c.city, c.country].filter(Boolean).join(', '))} · #${c.id}</div>
											</td>
											<td class="r num">${isNum(c.usersCount) ? fmtNum(c.usersCount) : '—'}<div class="field-hint">${fetchEstimate(c.usersCount)}</div></td>
											<td>${studentsCell(c)}</td>
											<td>${detailsCell(c)}</td>
											<td class="r nowrap">
												${c.local ? `
													<button class="btn btn-ghost btn-sm icon-btn" data-act="cm-default" data-id="${c.id}" title="${c.isDefault ? 'Default campus' : 'Make default'}" ${c.isDefault ? 'disabled' : ''}><i class="fa fa-star${c.isDefault ? '' : '-o'}"></i></button>
													<button class="btn btn-ghost btn-sm" data-act="cm-open" data-id="${c.id}">Open</button>` : ''}
												<button class="btn btn-sm ${c.local ? '' : 'btn-primary'}" data-act="cm-fetch" data-id="${c.id}" ${studentsOff ? 'disabled' : ''} title="${esc(studentsTitle)}">
													<i class="fa ${c.local ? 'fa-refresh' : 'fa-users'}"></i>Students
												</button>
												<button class="btn btn-sm" data-act="cm-details" data-id="${c.id}" ${detailsOff ? 'disabled' : ''} title="${esc(detailsTitle)}">
													<i class="fa fa-id-card-o"></i>Details${c.local && detailsTodo(c) ? `<span class="btn-count">${fmtNum(detailsTodo(c))}</span>` : ''}
												</button>
											</td>
										</tr>`;
								}).join('')}
							</tbody>
						</table>
						${list.length ? '' : '<p class="muted" style="padding:20px;text-align:center">No campus matches.</p>'}`}
				</div>
				<div class="sheet-foot">
					<span class="field-hint">${queue.length ? `${plural(queue.length, 'job')} running or queued — you can close this window, fetching continues in the background.` : `<b>Students</b>: one request per 100 students. <b>Details</b>: one request per student (~2/s). ${CM.force ? '<b>Force</b> is on: everything is fetched again.' : `Only what is missing or older than ${cacheHours()}h is fetched.`}`}</span>
					<span class="grow"></span>
					${CM.sel.size ? `<button class="btn btn-ghost" data-act="cm-clear">Clear (${CM.sel.size})</button>` : ''}
					<button class="btn" data-act="cm-fetch-selected" data-what="students" ${CM.sel.size ? '' : 'disabled'}><i class="fa fa-users"></i>Students</button>
					<button class="btn" data-act="cm-fetch-selected" data-what="details" ${CM.sel.size ? '' : 'disabled'} title="Campuses without a student list get it first"><i class="fa fa-id-card-o"></i>Details</button>
					<button class="btn btn-primary" data-act="cm-fetch-selected" data-what="both" ${CM.sel.size ? '' : 'disabled'} title="The student list, then the profiles"><i class="fa fa-refresh"></i>${CM.force ? 'Force rescan' : 'Rescan'} both</button>
				</div>
			</div>`;
	}

	function toggleShortcuts(force) {
		const modal = $('#shortcuts');
		const show = force ?? modal.hidden;
		if (!show) { modal.hidden = true; return; }
		const row = (label, ...keys) => `<div>${label}</div><div class="keys">${keys.map((k) => k === '/' || k === 'or' ? (k === 'or' ? '<span>or</span>' : '<kbd>/</kbd>') : `<kbd>${k}</kbd>`).join('')}</div>`;
		modal.innerHTML = `
			<div class="modal-card" role="dialog" aria-label="Keyboard shortcuts">
				<div class="sheet-head"><h2>Keyboard shortcuts</h2><button class="btn btn-ghost icon-btn" data-act="close-shortcuts"><i class="fa fa-times"></i></button></div>
				<div class="shortcut-list">
					<h4>Filtering</h4>
					${row('Add a value as filter', 'Ctrl', 'Click')}
					${row('Exclude a value', 'Alt', 'Click')}
					${row('Apply pending filters', 'Ctrl', '↵')}
					${row('Open filters', 'F')}
					${row('Fetch & update campuses', 'C')}
					${row('Export students', 'E')}
					${row('Search students', '/')}
					<h4>Navigation</h4>
					${row('Students · Cursus · Graph · Exams · Projects', '1', '2', '3', '4', '5')}
					${row('Toggle cards / table', 'G')}
					${row('Next / previous student', 'J', 'K')}
					${row('Browse enlarged photos', '←', '→')}
					${row('Close panel', 'Esc')}
					${row('This help', '?')}
				</div>
			</div>`;
		modal.hidden = false;
	}

	/* =========================================================================
	   Filter actions
	   ========================================================================= */

	function stagedChanged(source = null) {
		renderChipbar();
		if (S.panelOpen) {
			if (source === 'panel') refreshPanelFooter();
			else { initFieldRows(); keepFocus(renderFilterPanel); }
		}
	}

	function applyStaged() {
		S.applied = clonePairs(S.staged).filter(([k, v]) => k && (v !== '' || FLAG_PARAMS.has(k)));
		S.page = 1;
		for (const ex of Object.values(S.explorer)) ex.page = 1;
		closeMenu();
		syncUrl(true);
		load();
	}

	/** Applies a change right away, keeping other pending (staged) edits pending. */
	function applyNow(mutate) {
		const pending = clonePairs(S.staged);
		mutate(S.applied);
		mutate(pending);
		S.page = 1;
		syncUrl(true);
		load({ keepStaged: pending });
	}

	function stage(changes, label) {
		for (const [k, v] of changes) setParam(S.staged, k, v);
		stagedChanged();
		const n = countPending();
		toast(`${label}${n > 1 ? ` · ${n} pending` : ''}`, { label: 'Apply', run: applyStaged });
	}

	function filterFromValue(key, value, mode) {
		const op = mode === 'exclude' ? '!=' : mode === 'gte' ? '>=' : mode === 'lte' ? '<=' : '==';
		stage([[key, op + value]], `${mode === 'exclude' ? 'Excluding' : 'Filter added:'} <b>${esc(key)} ${OP_SYMBOL[op]} ${esc(value || 'empty')}</b>`);
	}

	function filterFromEntry(kind, name, mode) {
		const K = KIND[kind];
		const changes = [[K.name, name], [K.prefix + '_required', '']];
		if (mode === 'passed') changes.push([K.prefix + '_validated', '==true']);
		else if (mode === 'failed') changes.push([K.prefix + '_validated', '==false']);
		else changes.push([K.prefix + '_validated', null]);
		if (getParam(S.staged, 'fullscan') === undefined) changes.push(['fullscan', '']);
		const what = mode === 'passed' ? 'passed' : mode === 'failed' ? 'failed' : 'took';
		stage(changes, `Students who ${what} <b>${esc(name)}</b>`);
	}

	function flash(el) {
		el.classList.remove('flash');
		void el.offsetWidth;
		el.classList.add('flash');
	}

	function openFvMenu(fvEl) {
		if (fvEl.dataset.entry) {
			const kind = fvEl.dataset.entry;
			const name = fvEl.dataset.v;
			openMenu(fvEl, `<div class="k">${KIND[kind].label.toLowerCase()}</div><div class="v">${esc(name)}</div>`, [
				{ label: 'Students who took it', icon: 'fa-users', kbd: 'Ctrl+Click', run: () => filterFromEntry(kind, name, 'took') },
				{ label: 'Students who passed it', icon: 'fa-check', kbd: 'Alt+Click', run: () => filterFromEntry(kind, name, 'passed') },
				{ label: 'Students who failed it', icon: 'fa-times', run: () => filterFromEntry(kind, name, 'failed') },
				'-',
				{ label: `Open in ${KIND[kind].labels} explorer`, icon: 'fa-search', run: () => openInExplorer(kind, name) },
				{ label: 'Copy name', icon: 'fa-clipboard', run: () => copyText(name) },
			]);
			return;
		}
		const key = fvEl.dataset.k;
		const value = fvEl.dataset.v;
		const items = [
			{ label: `Is <b>${esc(value || 'empty')}</b>`, op: '=', kbd: 'Ctrl+Click', run: () => filterFromValue(key, value, 'include') },
			{ label: `Is not <b>${esc(value || 'empty')}</b>`, op: '≠', kbd: 'Alt+Click', run: () => filterFromValue(key, value, 'exclude') },
		];
		if (looksNumeric(value)) {
			items.push({ label: `At least <b>${esc(value)}</b>`, op: '≥', run: () => filterFromValue(key, value, 'gte') });
			items.push({ label: `At most <b>${esc(value)}</b>`, op: '≤', run: () => filterFromValue(key, value, 'lte') });
		} else if (value.length > 1) {
			items.push({ label: 'Contains…', op: '∋', run: () => { S.panelOpen = true; initFieldRows(); S.fieldRows = S.fieldRows.filter((r) => r.k); S.fieldRows.push({ k: key, op: '~', val: value }); syncFieldRows(); renderFilterPanel(); showSheet('#filter-panel'); const i = S.fieldRows.length - 1; requestAnimationFrame(() => $(`[data-bind="row-v"][data-i="${i}"]`)?.select()); } });
		}
		items.push('-');
		items.push({ label: `Sort by ${esc(fieldLabel(key))}`, icon: 'fa-sort-amount-desc', run: () => { setSort(key, looksNumeric(value) ? 'desc' : 'asc'); if (S.view !== 'students') switchView('students'); } });
		items.push({ label: 'Copy value', icon: 'fa-clipboard', run: () => copyText(value) });
		openMenu(fvEl, `<div class="k">${esc(key)}</div><div class="v">${esc(value || '—')}</div>`, items);
	}

	function openInExplorer(kind, name) {
		const ex = S.explorer[kind];
		ex.sel = new Set([name]);
		ex.page = 1;
		closeSheets();
		switchView(kind);
	}

	/* =========================================================================
	   View state changes
	   ========================================================================= */

	function switchView(view) {
		if (!VIEWS.includes(view) || view === S.view) return;
		S.view = view;
		syncUrl(true);
		renderTabs();
		renderNotices();
		renderView();
		$('#scroller').scrollTo({ top: 0 });
	}

	function setSort(key, dir = null) {
		if (!key) S.sort = { key: '', dir: 'asc' };
		else if (dir) S.sort = { key, dir };
		else if (S.sort.key === key) S.sort = { key, dir: S.sort.dir === 'asc' ? 'desc' : 'asc' };
		else S.sort = { key, dir: 'asc' };
		S.page = 1;
		syncUrl();
		renderView();
	}

	function setDisplay(display) {
		S.display = display;
		store.set('display', display);
		S.page = 1;
		renderView();
	}

	function renderAll() {
		renderCampus();
		renderTabs();
		renderFilterCount();
		renderChipbar();
		renderNotices();
		renderView();
		if (S.panelOpen) { initFieldRows(); renderFilterPanel(); }
		if (EX.open) renderExport();
		if (S.drawer.id !== null) {
			if (S.byId.has(S.drawer.id)) renderDrawer();
			else closeSheets();
		}
	}

	/* =========================================================================
	   Events
	   ========================================================================= */

	function handleAction(act, el, ev) {
		const d = el.dataset;
		switch (act) {
			case 'open': openStudent(d.id, d.tab || null); break;
			case 'display': setDisplay(d.display); break;
			case 'sort-dir': setSort(S.sort.key, S.sort.dir === 'asc' ? 'desc' : 'asc'); break;
			case 'th-sort': {
				if (d.scope === 'students') { setSort(d.key); break; }
				if (d.scope === 'cursus') {
					const C = S.cursus;
					C.sort = C.sort.key === d.key ? { key: d.key, dir: C.sort.dir === 'asc' ? 'desc' : 'asc' } : { key: d.key, dir: ['level', 'pace', 'days'].includes(d.key) ? 'desc' : 'asc' };
					C.page = 1;
					renderView();
					break;
				}
				const target = d.scope === 'drawer' ? S.drawer : S.explorer[d.scope];
				const numericFirst = ['mark', 'date', 'avg', 'occ', 'result'].includes(d.key) || d.key.startsWith('col:');
				target.sort = target.sort.key === d.key
					? { key: d.key, dir: target.sort.dir === 'asc' ? 'desc' : 'asc' }
					: { key: d.key, dir: numericFirst ? 'desc' : 'asc' };
				if (d.scope === 'drawer') renderDrawer(); else renderView();
				break;
			}
			case 'page': {
				const page = Number(d.page);
				if (d.scope === 'students') { S.page = page; syncUrl(); }
				else if (d.scope === 'cursus') S.cursus.page = page;
				else S.explorer[d.scope === 'matrix' ? S.view : d.scope].page = page;
				renderView();
				$('#scroller').scrollTo({ top: 0, behavior: 'smooth' });
				break;
			}
			case 'apply': applyStaged(); break;
			case 'discard': S.staged = clonePairs(S.applied); stagedChanged(); break;
			case 'clear-all': applyNow((p) => { const campus = getParam(p, 'campus_id'); p.length = 0; if (campus !== undefined) p.push(['campus_id', campus]); }); break;
			case 'clear-q': S.q = ''; $('#quick-search').value = ''; visibleCache = null; syncUrl(); renderAll(); break;
			case 'chip-edit': openFilterPanel(d.k); break;
			case 'chip-remove': {
				ev.stopPropagation();
				const key = d.k;
				const isApplied = getParam(S.applied, key) !== undefined;
				if (isApplied) applyNow((p) => setParam(p, key, null));
				else { setParam(S.staged, key, null); stagedChanged(); }
				break;
			}
			case 'chip-restore': setParam(S.staged, d.k, getParam(S.applied, d.k)); stagedChanged(); break;
			case 'fullscan-on': applyNow((p) => setParam(p, 'fullscan', '')); break;
			case 'autofetch': setAutoFetch(!LZ.on); break;
			case 'fetch-one': LZ.failed.delete(Number(d.id)); setAutoFetch(true); break;
			case 'co-filter': S.cursus.status = d.status; S.cursus.sort = { key: 'date', dir: d.status === 'upcoming' ? 'asc' : 'desc' }; S.cursus.page = 1; renderView(); break;
			case 'graph-node': S.graph.sel = d.pid || null; S.graph.show = {}; renderView(); break;
			case 'graph-zoom': S.graph.zoom = Number(d.delta) ? Math.min(2.5, Math.max(0.5, S.graph.zoom + Number(d.delta))) : 1; renderView(); break;
			
			case 'graph-more': S.graph.show[d.state] = !S.graph.show[d.state]; renderView(); break;
			case 'remove-unknown': applyNow((p) => { for (const k of S.meta.unknownKeys) setParam(p, k, null); }); break;
			case 'dismiss': S.noticeDismissed[d.notice] = true; store.set('dismissed', S.noticeDismissed); renderNotices(); break;
			case 'retry': S.loadedKey = null; load(); break;
			case 'rescan-menu': ev.stopPropagation(); S.rescanOpen ? closeMenu() : openRescanMenu(el); break;
			case 'rescan-go': startRescan(); break;
			case 'open-filters': openFilterPanel(); break;
			case 'close-sheets': closeSheets(); break;
			case 'drawer-step': drawerStep(Number(d.delta)); break;
			case 'drawer-tab': S.drawer.tab = d.tab; S.drawer.q = ''; S.drawer.status = ''; S.drawer.sort = { key: 'date', dir: 'desc' }; renderDrawer(); break;
			case 'copy-json': copyText(studentJson(S.byId.get(S.drawer.id))); break;
			case 'copy': copyText(d.v); break;
			case 'refresh-student': refreshStudent(Number(d.id)); break;
			case 'facet-toggle': {
				const ex = S.explorer[S.view];
				if (ex.sel.has(d.name)) ex.sel.delete(d.name);
				else ex.sel.add(d.name);
				ex.page = 1;
				keepFocus(renderView);
				break;
			}
			case 'facet-clear': S.explorer[S.view].sel.clear(); S.explorer[S.view].page = 1; renderView(); break;
			case 'ex-mode': {
				const ex = S.explorer[S.view];
				ex.mode = d.mode;
				ex.page = 1;
				ex.sort = d.mode === 'matrix' ? { key: 'avg', dir: 'desc' } : { key: 'date', dir: 'desc' };
				renderView();
				break;
			}
			case 'ex-reset': Object.assign(S.explorer[S.view], { status: '', result: '', min: '', max: '', best: false, page: 1 }); renderView(); break;
			case 'mon-status': {
				const ex = S.explorer[S.view];
				ex.status = ex.status === d.status ? '' : d.status;
				ex.page = 1;
				renderView();
				break;
			}
			case 'row-add': S.fieldRows.push({ k: '', op: '==', val: '' }); $('#field-rows').innerHTML = renderFieldRows(); $(`[data-bind="row-k"][data-i="${S.fieldRows.length - 1}"]`)?.focus(); break;
			case 'row-remove': S.fieldRows.splice(Number(d.i), 1); if (!S.fieldRows.length) S.fieldRows.push({ k: '', op: '==', val: '' }); $('#field-rows').innerHTML = renderFieldRows(); syncFieldRows(); break;
			case 'panel-reset': {
				const campus = getParam(S.staged, 'campus_id');
				S.staged = campus !== undefined ? [['campus_id', campus]] : [];
				initFieldRows();
				renderFilterPanel();
				renderChipbar();
				break;
			}
			case 'menu': {
				const item = S.menu?.[Number(d.i)];
				closeMenu();
				item?.run();
				break;
			}
			case 'close-shortcuts': toggleShortcuts(false); break;
			case 'zoom': ev.stopPropagation(); openLightbox(d.id); break;
			case 'campuses': openCampusManager(); break;
			case 'cm-close': closeCampusManager(); break;
			case 'ex-open': openExport(); break;
			case 'ex-close': closeExport(); break;
			case 'ex-preset': EX.preset = d.preset; store.set('export.preset', EX.preset); renderExport(); break;
			case 'ex-format': EX.format = d.format; store.set('export.format', EX.format); renderExport(); break;
			case 'ex-layout': EX.pdfLayout = d.layout; store.set('export.pdfLayout', EX.pdfLayout); renderExport(); break;
			case 'ex-download': downloadExport(); break;
			case 'ex-copy': copyText(exportText()); break;
			case 'ex-fullscan': closeExport(); applyNow((p) => setParam(p, 'fullscan', '')); break;
			case 'cm-filter': CM.filter = d.filter; renderCampusManager(); break;
			case 'cm-toggle': { const id = Number(d.id); CM.sel.has(id) ? CM.sel.delete(id) : CM.sel.add(id); renderCampusManager(); break; }
			case 'cm-toggle-all': {
				const rows = $$('#campus-manager tr[data-id]').map((r) => Number(r.dataset.id));
				const all = rows.every((id) => CM.sel.has(id));
				for (const id of rows) all ? CM.sel.delete(id) : CM.sel.add(id);
				renderCampusManager();
				break;
			}
			case 'cm-clear': CM.sel.clear(); renderCampusManager(); break;
			case 'cm-fetch': fetchCampuses([Number(d.id)]); break;
			case 'cm-details': fetchCampuses([Number(d.id)], 'details'); break;
			// campuses without a student list get it first: the server queues it before the details
			case 'cm-fetch-selected': fetchCampuses([...CM.sel], d.what); break;
			case 'cm-cancel': postJson('/api/jobs/cancel', { id: Number(d.job) }).then((jobs) => { handleJobs(jobs); renderCampusManager(); }).catch((e) => toast(esc(e.message))); break;
			case 'cm-open': openCampus(Number(d.id)); break;
			case 'cm-catalog': postJson('/api/campuses/catalog').then(handleJobs).then(() => renderCampusManager()).catch((e) => toast(esc(e.message))); break;
			case 'cm-default':
				postJson('/api/campuses/default', { id: Number(d.id) })
					.then((data) => { CM.data = { ...CM.data, ...data }; renderCampusManager(); S.loadedKey = null; load({ keepStaged: clonePairs(S.staged) }); toast('Default campus updated'); })
					.catch((e) => toast(esc(e.message)));
				break;
			case 'lb-close': closeLightbox(); break;
			case 'lb-step': lightboxStep(Number(d.delta)); break;
			case 'lb-details': closeLightbox(); openStudent(d.id); break;
			case 'stage': applyNow((p) => setParam(p, 'stage', d.stage ? '==' + d.stage : null)); break;
			case 'p-stage': {
				setParam(S.staged, 'stage', d.stage ? '==' + d.stage : null);
				// the stage only exists once profiles are fetched
				if (d.stage && getParam(S.staged, 'fullscan') === undefined) setParam(S.staged, 'fullscan', '');
				stagedChanged();
				break;
			}
		}
	}

	document.addEventListener('click', (ev) => {
		const pop = $('#popover');
		if (!pop.hidden && !pop.contains(ev.target) && !ev.target.closest('.fv-btn, [data-act="rescan-menu"]')) closeMenu();

		const fvBtn = ev.target.closest('.fv-btn');
		if (fvBtn) {
			ev.preventDefault();
			ev.stopPropagation();
			openFvMenu(fvBtn.closest('.fv'));
			return;
		}
		const fvEl = ev.target.closest('.fv');
		if (fvEl && (ev.ctrlKey || ev.metaKey || ev.altKey)) {
			ev.preventDefault();
			ev.stopPropagation();
			flash(fvEl);
			if (fvEl.dataset.entry) filterFromEntry(fvEl.dataset.entry, fvEl.dataset.v, ev.altKey ? 'passed' : 'took');
			else filterFromValue(fvEl.dataset.k, fvEl.dataset.v, ev.altKey ? 'exclude' : 'include');
			return;
		}
		if (ev.target.closest('a[href]')) return;
		const actEl = ev.target.closest('[data-act]');
		if (actEl && !actEl.disabled) handleAction(actEl.dataset.act, actEl, ev);
	});

	// Alt+click on some systems also triggers a context action on mousedown; keep text selection sane
	document.addEventListener('mousedown', (ev) => {
		if ((ev.ctrlKey || ev.metaKey || ev.altKey) && ev.target.closest('.fv')) ev.preventDefault();
	});

	$('#view-tabs').addEventListener('click', (ev) => {
		const btn = ev.target.closest('[data-view]');
		if (btn) switchView(btn.dataset.view);
	});
	$('#scrim').addEventListener('click', closeSheets);
	$('#lightbox').addEventListener('click', (ev) => { if (ev.target.id === 'lightbox' || ev.target.classList.contains('lb-figure')) closeLightbox(); });
	$('#btn-filters').addEventListener('click', () => (S.panelOpen ? closeSheets() : openFilterPanel()));
	$('#btn-shortcuts').addEventListener('click', () => toggleShortcuts());
	$('#btn-campuses').addEventListener('click', openCampusManager);
	$('#export-modal').addEventListener('click', (ev) => { if (ev.target.id === 'export-modal') closeExport(); });
	$('#campus-manager').addEventListener('click', (ev) => { if (ev.target.id === 'campus-manager') closeCampusManager(); });
	$('#shortcuts').addEventListener('click', (ev) => { if (ev.target.id === 'shortcuts') toggleShortcuts(false); });
	$('#btn-theme').addEventListener('click', () => {
		const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
		document.documentElement.dataset.theme = next;
		try { localStorage.setItem('campus-lens.theme', next); } catch (e) { }
	});

	const onQuickSearch = debounce(() => {
		S.q = $('#quick-search').value.trim();
		S.page = 1;
		for (const ex of Object.values(S.explorer)) ex.page = 1;
		syncUrl();
		renderTabs();
		renderView();
	}, 140);
	$('#quick-search').addEventListener('input', onQuickSearch);

	const rerenderView = debounce(() => keepFocus(renderView), 120);
	const rerenderDrawer = debounce(() => keepFocus(renderDrawer), 100);

	function onBind(ev) {
		const el = ev.target;
		const bind = el.dataset?.bind;
		if (!bind) return;
		const isText = ev.type === 'input';
		const d = el.dataset;
		const value = el.type === 'checkbox' ? el.checked : el.value;
		const ex = S.explorer[S.view];

		// text inputs react on `input`, everything else on `change`
		const textBinds = ['cm-q', 'facet-q', 'ex-min', 'ex-max', 'dr-q', 'row-k', 'row-v', 'p-name', 'p-mark-val'];
		if (textBinds.includes(bind) !== isText) return;

		switch (bind) {
			case 'campus':
				if (value === '__manage') { renderCampus(); openCampusManager(); break; }
				applyNow((p) => setParam(p, 'campus_id', value || null));
				break;
			case 'cm-q': CM.q = value; keepFocus(renderCampusManager); break;
			case 'cm-force': CM.force = value; renderCampusManager(); break;
			case 'ex-per-exam': EX.perExam = value; renderExport(); break;
			case 'ex-photos': EX.photos = value; store.set('export.photos', value); renderExport(); break;
			case 'ex-per-project': EX.perProject = value; renderExport(); break;
			case 'rs-students':
			case 'rs-profiles':
			case 'rs-force': {
				S.rescan[bind.slice(3)] = value;
				store.set('rescan', { students: S.rescan.students, profiles: S.rescan.profiles });
				keepFocus(() => { $('#popover').innerHTML = renderRescanMenu(); });
				break;
			}
			case 'sort-key': setSort(value, ['', 'login', 'displayname', 'location', 'pool_month'].includes(value) ? 'asc' : 'desc'); break;
			case 'pagesize': {
				const key = d.scope === 'students' ? S.display : d.scope;
				S.pageSize[key] = Number(value);
				store.set('pageSize', S.pageSize);
				renderView();
				break;
			}
			case 'facet-q': ex.facetQ = value; rerenderView(); break;
			case 'ex-status': ex.status = value; ex.page = 1; renderView(); break;
			case 'ex-result': ex.result = value; ex.page = 1; renderView(); break;
			case 'ex-min': ex.min = value; ex.page = 1; rerenderView(); break;
			case 'ex-max': ex.max = value; ex.page = 1; rerenderView(); break;
			case 'ex-best': ex.best = value; ex.page = 1; renderView(); break;
			case 'mon-live': setMonitorOn(value); break;
			case 'mon-interval': setMonitorInterval(Number(value)); break;
			case 'graph-me': S.graph.me = value.trim(); store.set('me', S.graph.me); renderView(); break;
			case 'graph-min': S.graph.minPeople = Number(value); graphCache = null; renderView(); break;
			case 'graph-active': S.graph.onlyActive = value; renderView(); break;
			case 'dr-q': S.drawer.q = value; rerenderDrawer(); break;
			case 'dr-status': S.drawer.status = value; renderDrawer(); break;
			case 'dr-matching': S.drawer.onlyMatching = value; renderDrawer(); break;

			case 'p-campus': setParam(S.staged, 'campus_id', value || null); stagedChanged('panel'); break;
			case 'p-fullscan': setParam(S.staged, 'fullscan', value ? '' : null); stagedChanged(); break;
			case 'p-name': setParam(S.staged, KIND[d.kind].name, value.trim() || null); stagedChanged('panel'); break;
			case 'p-mark-op':
			case 'p-mark-val': {
				const section = el.closest('.fsection');
				const op = $('[data-bind="p-mark-op"]', section).value;
				const val = $('[data-bind="p-mark-val"]', section).value.trim();
				setParam(S.staged, KIND[d.kind].prefix + '_mark', val === '' ? null : op + val);
				stagedChanged('panel');
				break;
			}
			case 'p-validated': setParam(S.staged, KIND[d.kind].prefix + '_validated', value || null); stagedChanged('panel'); break;
			case 'p-status': setParam(S.staged, KIND[d.kind].prefix + '_status', value || null); stagedChanged('panel'); break;
			case 'p-required': setParam(S.staged, KIND[d.kind].prefix + '_required', value ? '' : null); stagedChanged('panel'); break;
			case 'row-k': S.fieldRows[d.i].k = value; syncFieldRows(); break;
			case 'row-op': S.fieldRows[d.i].op = value; syncFieldRows(); break;
			case 'row-v': S.fieldRows[d.i].val = value; syncFieldRows(); break;
		}
	}
	document.addEventListener('input', onBind);
	document.addEventListener('change', onBind);

	const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

	document.addEventListener('keydown', (ev) => {
		if (ev.key === 'Control' || ev.key === 'Meta' || ev.key === 'Alt') document.body.classList.add('mod-key');

		if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
			if (isDirty()) { ev.preventDefault(); applyStaged(); }
			return;
		}
		if (S.lightbox) {
			if (ev.key === 'Escape') closeLightbox();
			else if (ev.key === 'ArrowLeft') lightboxStep(-1);
			else if (ev.key === 'ArrowRight') lightboxStep(1);
			return;
		}
		if (ev.key === 'Escape') {
			if (EX.open) { closeExport(); return; }
			if (CM.open && $('#popover').hidden) { closeCampusManager(); return; }
			if (!$('#popover').hidden) closeMenu();
			else if (!$('#shortcuts').hidden) toggleShortcuts(false);
			else if (!$('#scrim').hidden) closeSheets();
			else if (document.activeElement === $('#quick-search')) $('#quick-search').blur();
			return;
		}
		if (isTyping(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey) return;

		const drawerOpen = S.drawer.id !== null;
		switch (ev.key) {
			case '/': ev.preventDefault(); $('#quick-search').focus(); $('#quick-search').select(); break;
			case 'f': case 'F': ev.preventDefault(); S.panelOpen ? closeSheets() : openFilterPanel(); break;
			case '1': case '2': case '3': case '4': case '5': closeSheets(); switchView(VIEWS[Number(ev.key) - 1]); break;
			case 'g': case 'G': if (S.view === 'students') setDisplay(S.display === 'grid' ? 'table' : 'grid'); break;
			case 'j': case 'ArrowDown': if (drawerOpen) { ev.preventDefault(); drawerStep(1); } break;
			case 'k': case 'ArrowUp': if (drawerOpen) { ev.preventDefault(); drawerStep(-1); } break;
			case '?': toggleShortcuts(); break;
			case 'c': case 'C': CM.open ? closeCampusManager() : openCampusManager(); break;
			case 'e': case 'E': EX.open ? closeExport() : openExport(); break;
		}
	});
	document.addEventListener('keyup', (ev) => {
		if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) document.body.classList.remove('mod-key');
	});
	window.addEventListener('blur', () => document.body.classList.remove('mod-key'));
	$('#scroller').addEventListener('scroll', closeMenu, { passive: true });

	// drag the graph around instead of using its scrollbars
	let panning = null;
	document.addEventListener('pointerdown', (ev) => {
		const box = ev.target.closest?.('[data-drag]');
		if (!box || ev.button !== 0 || ev.target.closest('button')) return;
		panning = { box, x: ev.clientX, y: ev.clientY, left: box.scrollLeft, top: box.scrollTop };
		box.classList.add('dragging');
	});
	document.addEventListener('pointermove', (ev) => {
		if (!panning) return;
		panning.box.scrollLeft = panning.left - (ev.clientX - panning.x);
		panning.box.scrollTop = panning.top - (ev.clientY - panning.y);
	});
	document.addEventListener('pointerup', () => { panning?.box.classList.remove('dragging'); panning = null; });

	window.addEventListener('popstate', () => {
		readUrl();
		visibleCache = null;
		load();
	});

	/* =========================================================================
	   Boot
	   ========================================================================= */

	if (![25, 50, 100].includes(S.pageSize.table)) S.pageSize.table = 50;
	readUrl();
	renderTabs();
	renderAutoFetch();
	load();
})();
