@echo off
setlocal
title Caspian Scraper - Collect
rem Collects public business information from Google Maps and Google Search
rem in a visible browser (collect.py), then opens the spreadsheet.
rem Double-click to run. If Google asks "are you a robot", solve it in the
rem browser window; collecting carries on by itself.

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

echo.
set "WORDS="
set /p WORDS=What are you looking for? (e.g. training centres):
if "%WORDS%"=="" exit /b 0
set "WHERE="
set /p WHERE=Where? (e.g. Baku, Azerbaijan - Enter for anywhere):
set "MAX="
set /p MAX=How many businesses from Maps? (Enter = 60):
if "%MAX%"=="" set "MAX=60"
echo.

".venv\Scripts\python.exe" collect.py "%WORDS%" --where "%WHERE%" --max %MAX% --pages 2

rem Open the newest spreadsheet.
for /f "delims=" %%F in ('dir /b /o-d "local-data\collected\*.csv" 2^>nul') do (
  start "" "local-data\collected\%%F"
  goto opened
)
:opened
echo.
pause
endlocal
