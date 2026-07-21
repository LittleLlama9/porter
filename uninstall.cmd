@echo off
setlocal
title Porter uninstall
echo === Porter uninstall ===
echo.
echo Removing the logon task and stopping Porter...

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-launch.ps1"

echo.
echo Porter has been stopped and will no longer start at logon.
echo To remove it completely, just delete this folder.
echo.
pause
