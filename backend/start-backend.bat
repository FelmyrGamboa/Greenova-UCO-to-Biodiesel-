@echo off
setlocal
rem Run this on the computer that hosts Greenova and its MySQL 8 database.
rem Other users open http://<this-computer-LAN-IP>:8000 in their browser.
rem
rem One-time database setup: import greenova_db_ver2.sql in HeidiSQL (File > Run SQL file) as root.
rem It creates the greenova_db database with its tables and data, and the MySQL user
rem greenova@localhost (no password) that the backend logs in with. No backend\.env is needed.
cd /d "%~dp0"

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

rem Check the MySQL database (read only) before starting the API.
".venv\Scripts\python.exe" -m app.db
if errorlevel 1 goto no_database

echo.
echo Greenova backend: http://localhost:8000
echo For other devices on the same network, open http://^<SERVER-LAN-IP^>:8000
echo API docs: http://localhost:8000/docs
echo Do not expose MySQL port 3306 to client devices or the public internet.
echo Leave this window open. Press Ctrl+C to stop.
echo.
rem Listen on the LAN so other devices can access the one shared backend and database.
".venv\Scripts\python.exe" -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
if errorlevel 1 goto backend_failed
goto end

:no_python
echo Python was not found. Install Python 3.11+ from python.org and tick "Add python.exe to PATH".
pause
goto end

:pip_failed
echo Installing the packages failed. Check the internet connection, then run this file again.
pause
goto end

:no_database
echo.
echo Greenova could not use the MySQL database (the reason is above).
echo Import backend\greenova_db_ver2.sql once in HeidiSQL (File ^> Run SQL file), as root.
echo It creates greenova_db and the MySQL user greenova@localhost that the backend logs in with.
pause
goto end

:backend_failed
echo The backend stopped. Check the error above and Windows Firewall settings.
pause

:end
endlocal
