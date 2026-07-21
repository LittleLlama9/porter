@echo off
setlocal
title Porter uninstall
echo === Porter uninstall ===
echo.
echo Removing the logon task and stopping Porter...

powershell -NoProfile -ExecutionPolicy Bypass -Command "Unregister-ScheduledTask -TaskName 'Porter Doorman' -Confirm:$false -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -match 'porter-supervisor\.js|porter\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo.
echo Porter has been stopped and will no longer start at logon.
echo To remove it completely, just delete this folder.
echo.
pause
