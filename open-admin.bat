@echo off
setlocal
rem Starts the Caspian Scraper admin app (web/) on this computer and opens it.
rem Double-click to run. Close the minimized "admin server" window to stop it.
rem No sign-in or keys: it reads and writes data\ and local-data\ directly.
rem Optional argument: a page to open, e.g.  open-admin.bat projects/hse/findings

cd /d "%~dp0web"
set "PORT=4444"
set "URL=http://localhost:%PORT%/%~1"

rem Already running from an earlier launch? Just open the browser.
curl.exe -s -o nul "http://127.0.0.1:%PORT%/" && goto open

where npm >nul 2>&1 || (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
rem The databases use Node's built-in SQLite (Node 22.13 or newer).
node -e "require('node:sqlite')" >nul 2>&1 || (
  echo Node.js is too old for this app - install the current LTS from https://nodejs.org and try again.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo First run: installing packages, this takes a minute...
  call npm ci --no-audit --no-fund || (pause & exit /b 1)
)

start "Caspian Scraper admin server (close to stop)" /min cmd /c "npx next dev -p %PORT% -H 127.0.0.1"

rem Wait up to ~90s for the first compile.
echo Starting the admin app...
set /a TRIES=0
:wait
curl.exe -s -o nul "http://127.0.0.1:%PORT%/" && goto open
set /a TRIES+=1
if %TRIES% geq 90 (
  echo The admin app did not start on port %PORT%. Check the minimized server window.
  pause
  exit /b 1
)
rem ping, not timeout: timeout aborts when input is redirected.
ping -n 2 127.0.0.1 >nul
goto wait

:open
start "" "%URL%"
endlocal
