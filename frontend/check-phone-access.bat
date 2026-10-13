@echo off
rem Checks why a phone can't open the Greenova website, and offers to fix it.
rem Run it while "npm run dev" is running.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-phone-access.ps1"
pause
