#!/bin/bash
cd "$(dirname "$0")"
if ! ls data/students.json data/campus_*_students.json >/dev/null 2>&1; then
	echo "No students data found in ./data — run ./fetch-students.sh <campus_id> first (the app will show the same instructions)."
fi
echo "Starting campus-lens on http://localhost:8080"
cd simpleweb
../pyenv/bin/python app.py
