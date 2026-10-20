@echo off
setlocal
title Caspian Scraper - Start
rem Runs the scraper on this computer, then opens the admin app on what it
rem found so you can review it. Double-click to run. No accounts or keys
rem needed: jobs and resources live in data\ (committed), run results in
rem local-data\ (this computer only).

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
  rem Nothing ran (a bad choice or a setup problem) - leave the message up.
  echo.
  pause
  exit /b %RC%
)

set "REVIEW_PATH="
set /p REVIEW_PATH=<"%REVIEW_FILE%"
del "%REVIEW_FILE%"

echo.
if not "%RC%"=="0" echo The scraper reported errors - they are listed on the job's Runs page.
echo Opening the admin app...
call "%~dp0open-admin.bat" %REVIEW_PATH%
endlocal
