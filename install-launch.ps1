# install-launch.ps1 — register the "Porter Doorman" logon task.
# Launches porter.js hidden at every logon, as the current user, no elevation.
# Re-run after moving the repo. Idempotent (-Force). Also retires the old
# polling "Porter Watchdog" task if it's still around.
$ErrorActionPreference = 'Stop'
$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$user = "$env:USERDOMAIN\$env:USERNAME"

Unregister-ScheduledTask -TaskName 'Porter Watchdog' -Confirm:$false -ErrorAction SilentlyContinue

$action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + (Join-Path $dir 'launch.vbs') + '"')
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'Porter Doorman' `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Launches the Porter localhost doorman (porter.js) hidden at logon. Log: launch.log' `
  -Force | Out-Null

Write-Host "[porter] 'Porter Doorman' logon task registered for $user"
Get-ScheduledTask -TaskName 'Porter Doorman' | Select-Object TaskName, State | Format-Table -AutoSize
