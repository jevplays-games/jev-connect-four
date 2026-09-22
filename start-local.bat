@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22.16 or newer before running this project.
  pause
  exit /b 1
)
npm start
pause
