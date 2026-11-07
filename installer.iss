; Script do Inno Setup para FYXXSSH
#define MyAppName "FYXXSSH"
#define MyAppVersion "1.0.5"
#define MyAppPublisher "FYXX Technologies"
#define MyAppURL "https://github.com/ogerrva/fyxxssh"
#define MyAppExeName "FYXXSSH.exe"

[Setup]
AppId={{E68F0D55-32B8-4F11-8C64-4275E19A6B29}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DisableProgramGroupPage=yes
OutputDir=dist-installer
OutputBaseFilename=FYXXSSH-Setup-v1.0.5
SetupIconFile=build\icon.ico
WizardImageFile=build\wizard.bmp
WizardSmallImageFile=build\wizard-small.bmp
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}

; Metadados do Executável para o Windows Explorer e SmartScreen
VersionInfoVersion=1.0.5.0
VersionInfoCompany=FYXX Technologies
VersionInfoDescription=FYXXSSH Setup
VersionInfoProductName=FYXXSSH
VersionInfoProductVersion=1.0.5.0
VersionInfoCopyright=Copyright (C) 2026 FYXX Technologies

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\FYXXSSH-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent




