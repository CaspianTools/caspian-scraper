@echo off
setlocal
rem Opens the HSE Scraper dashboard (docs/) on a local web server and goes
rem straight to the dashboard view - no GitHub token sign-in screen.
rem Double-click to run. Close the minimized "dashboard server" window to stop it.

cd /d "%~dp0"
set "PORT=8080"
set "URL=http://localhost:%PORT%/?demo=1"

rem Server already running from an earlier launch? Just open the browser.
curl.exe -s -f -o nul "http://127.0.0.1:%PORT%/data.json" && goto open

set "PY="
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
if not defined PY (where py >nul 2>&1 && set "PY=py -3")
if not defined PY (where python >nul 2>&1 && set "PY=python")
if not defined PY (
  echo Python was not found. Install Python 3 or create .venv in this folder.
  pause
  exit /b 1
)

start "HSE Scraper dashboard server (close to stop)" /min %PY% -m http.server %PORT% --bind 127.0.0.1 --directory docs

rem Wait up to ~20s for the server to answer.
set /a TRIES=0
:wait
curl.exe -s -f -o nul "http://127.0.0.1:%PORT%/data.json" && goto open
set /a TRIES+=1
if %TRIES% geq 20 (
  echo The dashboard server did not start on port %PORT%. Is something else using it?
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait

:open
start "" "%URL%"
endlocal
