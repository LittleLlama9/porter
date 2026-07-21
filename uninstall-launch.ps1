# uninstall-launch.ps1 - remove the Porter logon task and stop Porter.
# Shared by uninstall.cmd and the installer's uninstaller. Kept ASCII-only so it
# parses correctly under Windows PowerShell 5.1, which scheduled tasks use.
$ErrorActionPreference = 'SilentlyContinue'

Unregister-ScheduledTask -TaskName 'Porter Doorman' -Confirm:$false

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'porter-supervisor\.js|porter\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host "[porter] logon task removed and Porter stopped."
