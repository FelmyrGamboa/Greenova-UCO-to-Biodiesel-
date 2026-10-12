@echo off
rem Starts the Greenova backend (demo mode) at http://localhost:8000
rem The first time, it creates the Python environment (.venv) and installs the packages.
rem For a faster demo machine, run "set GREENOVA_TIME_SCALE=20" in this window first.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Creating the Python environment in .venv ...
  python -m venv .venv
  if errorlevel 1 goto no_python
)

".venv\Scripts\python.exe" -c "import fastapi, uvicorn" 2>nul
if errorlevel 1 (
  echo Installing the backend packages. The first time this takes a minute...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto pip_failed
)

".venv\Scripts\python.exe" -m app.seed
echo.
echo Greenova backend: http://localhost:8000   (API docs: http://localhost:8000/docs)
echo Leave this window open. Press Ctrl+C to stop.
echo.
".venv\Scripts\python.exe" -m uvicorn app.main:app --reload
goto end

:no_python
echo Python was not found. Install Python 3.11 from python.org and tick "Add python.exe to PATH".
pause
goto end

:pip_failed
echo Installing the packages failed. Check the internet connection, then run this file again.
pause

:end
