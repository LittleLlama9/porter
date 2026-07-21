; porter-setup.iss - Inno Setup script for Porter.
;
; Builds porter-setup.exe: a small (~2 MB) per-user installer with a real
; wizard and progress bar. It installs to %LOCALAPPDATA%\Porter (no admin/UAC
; for Porter itself), installs Node.js LTS via winget only if it is missing,
; registers the hidden logon task, and starts Porter. Uninstall from Windows
; "Add or remove programs" removes the task and stops Porter.
;
; Node is NOT bundled - it is fetched with winget on demand, so this installer
; stays tiny and Porter keeps its zero-bloat identity.
;
; Build:  ISCC.exe porter-setup.iss   (output in dist\porter-setup.exe)

#define AppName "Porter"
#define AppVersion "1.0.0"
#define AppPublisher "LittleLlama9"
#define AppURL "https://github.com/LittleLlama9/porter"

[Setup]
AppId={{7E7B2C40-3E6E-4C9A-9B1B-9E3E1B2A5C10}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
DefaultDirName={localappdata}\Porter
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=porter-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Porter

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "porter.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "porter-supervisor.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "porter-launch.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-launch.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall-launch.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "launch.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "porter.config.example.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-launch.ps1"""; \
  StatusMsg: "Registering Porter to start at logon..."; Flags: runhidden waituntilterminated
Filename: "wscript.exe"; Parameters: """{app}\launch.vbs"""; \
  StatusMsg: "Starting Porter..."; Flags: nowait

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall-launch.ps1"""; \
  Flags: runhidden; RunOnceId: "PorterStop"

[Code]
function NodeInstalled(): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  if Exec('cmd.exe', '/c node --version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := (ResultCode = 0);
  if not Result then
    Result := FileExists(ExpandConstant('{commonpf}\nodejs\node.exe')) or
              FileExists(ExpandConstant('{commonpf32}\nodejs\node.exe'));
end;

function WingetPath(): String;
begin
  Result := ExpandConstant('{localappdata}\Microsoft\WindowsApps\winget.exe');
  if not FileExists(Result) then
    Result := '';
end;

procedure InstallNodeIfMissing();
var
  ResultCode: Integer;
  Winget: String;
begin
  if NodeInstalled() then
    Exit;

  Winget := WingetPath();
  if Winget = '' then
  begin
    MsgBox('Porter needs Node.js, and it was not found on this PC.' + #13#10 +
           'The Windows Package Manager (winget) is also unavailable, so Node cannot be installed automatically.' + #13#10#13#10 +
           'Please install Node.js LTS from https://nodejs.org and run this installer again.',
           mbInformation, MB_OK);
    Exit;
  end;

  WizardForm.StatusLabel.Caption := 'Installing Node.js LTS (one-time; may prompt for permission)...';
  Exec(Winget,
       'install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements',
       '', SW_SHOW, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    InstallNodeIfMissing();
end;
