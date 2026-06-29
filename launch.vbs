' launch.vbs — runs porter-launch.ps1 fully hidden (no console flash).
' The "Porter Doorman" scheduled task invokes this at logon via wscript.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & dir & "\porter-launch.ps1""", 0, False
