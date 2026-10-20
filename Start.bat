@echo off
setlocal
title Caspian Scraper - Start
rem Runs the scraper on this computer, then opens the admin app on the
rem results so you can review them. Double-click to run.
rem
rem Needs service-account.json in this folder (Firebase service-account key,
rem gitignored) and the Python venv (.venv).

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo First run: setting up Python, this takes a few minutes...
  where py >nul 2>&1 && (py -3 -m venv .venv) || (python -m venv .venv)
  if not exist ".venv\Scripts\python.exe" (
    echo Could not create .venv - install Python 3 from https://python.org
    pause
    exit /b 1
  )
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt || (pause & exit /b 1)
  ".venv\Scripts\python.exe" -m playwright install chromium || (pause & exit /b 1)
)

set "REVIEW_FILE=%TEMP%\caspian-scraper-review.txt"
if exist "%REVIEW_FILE%" del "%REVIEW_FILE%"

".venv\Scripts\python.exe" scripts\start_local.py "%REVIEW_FILE%"
set "RC=%ERRORLEVEL%"

if not exist "%REVIEW_FILE%" (
  rem Nothing ran (cancelled or a setup problem) - leave the message on screen.
  echo.
  pause
  exit /b %RC%
)

set "REVIEW_PATH="
set /p REVIEW_PATH=<"%REVIEW_FILE%"
del "%REVIEW_FILE%"

echo.
if not "%RC%"=="0" echo The scraper reported errors - they are listed in the run on the Runs page.
echo Opening the admin app to review the run...
call "%~dp0open-admin.bat" %REVIEW_PATH%
echo.
pause
endlocal
