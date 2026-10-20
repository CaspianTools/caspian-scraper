@echo off
setlocal
rem Starts the Caspian Scraper admin app (web/) on this computer and opens it.
rem Double-click to run. Close the minimized "admin server" window to stop it.
rem Needs web\.env.local (Firebase web config + sign-in allowlist).
rem Optional argument: a page to open, e.g.  open-admin.bat projects/hse/runs

rem The repo-root service-account.json (shared with Start.bat) overrides the
rem key in .env.local. Takes effect when the server starts.
if exist "%~dp0service-account.json" set "FIREBASE_SERVICE_ACCOUNT_FILE=%~dp0service-account.json"

cd /d "%~dp0web"
set "PORT=4444"
set "URL=http://localhost:%PORT%/%~1"

rem Already running from an earlier launch? Just open the browser.
curl.exe -s -o nul "http://127.0.0.1:%PORT%/signin" && goto open

where npm >nul 2>&1 || (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
if not exist ".env.local" (
  echo web\.env.local is missing - the app can't reach Firestore without it.
  echo See web\.env.local.example for what it needs.
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
curl.exe -s -o nul "http://127.0.0.1:%PORT%/signin" && goto open
set /a TRIES+=1
if %TRIES% geq 90 (
  echo The admin app did not start on port %PORT%. Check the minimized server window.
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait

:open
start "" "%URL%"
endlocal
