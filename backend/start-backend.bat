@echo off
rem Starts the Greenova backend (demo mode) at http://localhost:8000
rem The first time, it creates the Python environment (.venv), installs the packages, and opens
rem backend\.env so you can type your MySQL password. The backend then creates the greenova_db
rem database and its tables by itself. See database.md in the project folder.
rem For a faster demo machine, run "set GREENOVA_TIME_SCALE=20" in this window first.
cd /d "%~dp0"

if not exist ".env" (
  copy .env.example .env >nul
  echo First start: type your MySQL password after DB_PASSWORD= in the Notepad window,
  echo then save and close Notepad. ^(The same password you use in HeidiSQL.^)
  start "" /wait notepad .env
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating the Python environment in .venv ...
  python -m venv .venv
  if errorlevel 1 goto no_python
)

".venv\Scripts\python.exe" -c "import fastapi, uvicorn, pymysql, cryptography" 2>nul
if errorlevel 1 (
  echo Installing the backend packages. The first time this takes a minute...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto pip_failed
)

rem Connects to MySQL and creates the database and any missing table.
".venv\Scripts\python.exe" -m app.db
if errorlevel 1 goto no_database

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
goto end

:no_database
echo.
echo The backend can't use MySQL (the reason is above). Is the MySQL80 service running?
echo Is the password in backend\.env right? Fix it, then run this file again. See database.md.
pause

:end
