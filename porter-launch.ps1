# porter-launch.ps1 — ensure the Porter supervisor is running, then exit.
# Invoked at logon by the "Porter Doorman" scheduled task. Starts the
# supervisor (porter-supervisor.js), which owns porter.js and respawns it if it
# ever dies. Guards against a double-launch (starts only if no supervisor is
# already running) and uses node's absolute path so it works in the bare logon
# environment, which was the weak spot in the old Startup-folder launcher.
$ErrorActionPreference = 'Stop'
$dir        = Split-Path -Parent $MyInvocation.MyCommand.Path
$supervisor = Join-Path $dir 'porter-supervisor.js'
$log        = Join-Path $dir 'launch.log'

function Write-Log($m) {
    Add-Content -Path $log -Value ((Get-Date).ToString('o') + ' ' + $m) -Encoding utf8
}

try {
    $alive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -match 'porter-supervisor\.js' }
    if ($alive) { exit 0 }   # supervisor already up — nothing to do

    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

    Write-Log "supervisor not running - launching via $node"
    Start-Process -FilePath $node -ArgumentList $supervisor -WorkingDirectory $dir -WindowStyle Hidden
    Write-Log 'supervisor launched'
}
catch {
    Write-Log ('launch error: ' + $_.Exception.Message)
    exit 1
}
