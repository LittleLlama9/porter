@echo off
setlocal
title Porter install
echo === Porter install ===
echo.

where node >nul 2>&1 && goto :haveNode
if exist "%ProgramFiles%\nodejs\node.exe" goto :haveNode

echo Node.js is required but was not found on this PC.
echo.
where winget >nul 2>&1
if errorlevel 1 goto :noWinget

echo Installing Node.js LTS for you (this may prompt for permission)...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
where node >nul 2>&1 && goto :haveNode
if exist "%ProgramFiles%\nodejs\node.exe" goto :haveNode
echo.
echo Node install did not finish. Get it from https://nodejs.org (LTS button) and run this again.
pause
exit /b 1

:noWinget
echo   1. Go to https://nodejs.org
echo   2. Click the big LTS button and install it (just accept the defaults).
echo   3. Run this install.cmd again.
echo.
pause
exit /b 1

:haveNode
echo Registering Porter to start at logon (no admin needed)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-launch.ps1"
if errorlevel 1 (
  echo.
  echo Install failed. See the message above.
  pause
  exit /b 1
)

echo Starting Porter now...
wscript "%~dp0launch.vbs"

echo.
echo Porter is running and will start automatically every time you log in.
echo Open your app's URL in a browser and it comes up on its own.
echo.
echo To remove Porter later, double-click uninstall.cmd.
echo.
pause
