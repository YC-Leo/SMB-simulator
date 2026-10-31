#!/usr/bin/env bash
cd "$(dirname "$0")"
PY=$(command -v python3 || command -v python)
"$PY" -c "import numpy" 2>/dev/null || "$PY" -m pip install --user -r requirements.txt
"$PY" run_suite.py
