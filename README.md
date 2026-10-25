# Campus Lens

This is a simple Flask app that fetches students from the 42 API and displays them in a web interface.
The good part is that there is a filtering system that allows you to filter by exams, projects, by average final mark, and every other field that is available in the student's JSON object.

## Installation

1. Install Python 3.10 or newer
2. Run `init.sh` to create a virtual environment and install dependencies
3. Setup your .env with the 42 API credentials
4. Fetch the students data by running `./fetch-students.sh` or `./fetch-students.sh <CAMPUS_ID>`
   - Students are saved to `data/campus_<CAMPUS_ID>_students.json`
   - The campus becomes the default one in `config.json`
5. Run the app by running `./run-server.sh` and open http://localhost:8080
6. Enjoy the lens!

### Which students file is used?

- `?campus_id=<id>` → `data/campus_<id>_students.json`
- otherwise `data/students.json` if it exists, then the `defaultCampus` from `config.json`, then any fetched campus

Every fetched campus shows up in the campus selector at the top of the page.

### Fetching campuses from the web app

The cloud button next to the campus selector (or <kbd>C</kbd>, or "Add or update campuses…" in the
selector) opens the campus manager: search the list of 42 campuses, fetch new ones or update the ones
you already have (one or many at once), pick the default campus, and refresh the campus list itself.
Fetches run in the background with live progress, and you can keep using the app meanwhile.
`./fetch-students.sh <CAMPUS_ID>` still works the same way from the terminal.

## Full scan (exams & projects)

The students list from the 42 API does not include exams, projects or levels. Enabling **Full scan**
fetches each matching student's profile (one API request per student, ~2 requests/second).
Field filters are applied *before* fetching: narrow the list down first (e.g. `pool_year`).

### Cache and rescans

Nothing fetched is ever thrown away, and data counts as outdated after `CACHE_EXPIRATION_HOURS`
(6h, in `simpleweb/app.py`):

- **Profiles** are kept in `data/cached_users.json`. A full scan only fetches the profiles that were
  never fetched; the others are used as they are, however old. If the 42 API fails for a student, their
  previous profile is kept.
- **Student lists** (`data/campus_<id>_students.json`) are merged when fetched again: students are
  updated and added, and the ones the 42 API no longer returns stay in the file.

Both can be fetched again, separately or together, from two places:

- **Rescan** (students page and Exams/Projects tabs) opens a menu: the campus **student list**, the
  **profiles** of the students in the current result (turns on the full scan), or both.
- The **campus manager** (cloud button): **Students**, **Details** (profiles) or **Rescan both**, per
  campus or for the selected ones. Details of a campus without a student list fetch the list first.

Without **Force**, only what is missing or outdated is fetched (a fresh student list is skipped).
With **Force**, everything selected is fetched again, however recent. A single profile can also be
fetched again from its drawer (the refresh button next to "Intra profile").

## Using the interface

- **Export** (<kbd>E</kbd>): download or copy the students on screen (current filters, search and sort)
  as CSV or JSON. **Lite**: login, name, email, pool, location, intra link. **Normal**: plus wallet,
  eval points, joined date, stage, cursus, grade, level, exams/projects passed. **Full**: plus status,
  dates (cursus end, blackhole), exam/project/overall averages, C Piscine final, and the best mark of
  each exam and project (one column each in CSV; in JSON, each student's cursus, exams and projects).
  Columns that need a full scan are left out without one.
  **PDF** (A4, with photos): **Cards**, a photo grid of 15 students per page, or **Detailed**, one block
  per student (with Full, their exams and projects as coloured marks). Logins link to the intra
  profiles; photos are loaded from the intra CDN when the PDF is made, and can be turned off.

- **Click-to-filter**: hover any value and click the funnel icon, or <kbd>Ctrl</kbd>+click it to add it
  to the filters (<kbd>Alt</kbd>+click to exclude it). New filters stay pending until you press
  **Apply** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>).
- **Exams / Projects tabs**: search and select exams or projects, filter by result, status and mark,
  keep only the best attempt, and compare students in the matrix view.
- **Cards / List**: the list view shows larger photos with stats, exam results and recent projects.
  Click any photo to enlarge it (<kbd>←</kbd>/<kbd>→</kbd> to browse).
- **Student details**: click a student for every field, all exams and projects, and the raw JSON.
- Press <kbd>?</kbd> for keyboard shortcuts.

## Query parameters

Filters live in the URL, so any view can be shared or bookmarked.

| Parameter | Meaning |
| --- | --- |
| `<any field>` | e.g. `pool_year=2025`, `kind===student`, `wallet=>=100`, `location=!=` (online) |
| `fullscan` | fetch exams/projects for each student |
| `rescan` | fetch again before searching: `students` (campus list), `profiles` (with `fullscan`) or `students,profiles`; `1` means `profiles`. Only what is outdated, unless `force` (the page's **Rescan** sends both once and never keeps them in the URL) |
| `force` | with `rescan`, fetch everything again however recent |
| `examname` / `projectname` | name or slug contains (`\|` separates alternatives) |
| `exam_mark`, `exam_status`, `exam_validated`, `exam_required` | narrow students by their exams (same with `project_`) |
| `level`, `average_exam_final_mark`, `cpiscine_final_mark`, `exams_passed`, … | computed fields (need `fullscan`) |

Conditions accept `>=`, `<=`, `>`, `<`, `==`, `!=` prefixes; without a prefix the value means "contains".
Numbers are compared numerically.
