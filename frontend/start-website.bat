@echo off
rem Starts the Greenova website at http://localhost:8443 (start the backend too).
rem The first time, it installs the packages (node_modules).
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 goto no_node

if not exist "node_modules" (
  echo Installing the website packages. The first time this takes a few minutes...
  call npm install
  if errorlevel 1 goto npm_failed
)

echo.
echo Greenova website: http://localhost:8443
echo Leave this window open. Press Ctrl+C to stop.
echo.
call npm run dev
goto end

:no_node
echo Node.js was not found. Install Node.js 22 LTS from nodejs.org, then open a new window.
pause
goto end

:npm_failed
echo npm install failed. Check the internet connection, then run this file again.
pause

:end
