@echo off
rem Starts the Greenova website at http://localhost:8443, for changing the website on a laptop.
rem It talks to the backend on the Raspberry Pi: set its address first, e.g.
rem     set GREENOVA_API=http://192.168.1.50:8000
rem (On the machine itself the Pi serves the built website at http://<pi-address>:8000.)
rem The first time, it installs the packages (node_modules).
cd /d "%~dp0"
if "%GREENOVA_API%"=="" echo GREENOVA_API is not set: the website will look for the backend at http://localhost:8000.

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
