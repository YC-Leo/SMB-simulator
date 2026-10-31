@echo off
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py) || (set PY=python)
%PY% -c "import numpy" 2>nul || %PY% -m pip install --user -r requirements.txt
%PY% run_suite.py
pause
