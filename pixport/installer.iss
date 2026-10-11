; PixPort — инсталлятор (Inno Setup 6).
; Сборка: npm run dist  (сначала npm run build, потом ISCC installer.iss)
; Пишем в HKCU — без прав админа, приватность пользователя не трогаем.

#define MyAppName "PixPort"
#define MyAppVersion "0.2.3"
#define MyAppPublisher "akkerqq"
#define MyAppExeName "PixPort.exe"

[Setup]
AppId={{8F2A7D41-6C3B-4E9A-9C5D-2B1E7A6F4D80}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputDir=dist
OutputBaseFilename=PixPort-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
; без прав админа: всё в HKCU и Program Files (пользовательские)
PrivilegesRequired=lowest
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=assets\icon.ico
DisableProgramGroupPage=yes

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; Flags: unchecked
Name: "contextmenu"; Description: "Добавить «Показать QR» в меню проводника (правый клик)"; Flags: checkedonce

[Files]
Source: "dist\PixPort-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
; пункт по папке
Root: HKCU; Subkey: "Software\Classes\Directory\shell\PixPort"; ValueType: string; ValueName: "(Default)"; ValueData: "Показать QR (PixPort)"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\shell\PixPort"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\{#MyAppExeName}"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\shell\PixPort\command"; ValueType: string; ValueName: "(Default)"; ValueData: """{app}\{#MyAppExeName}"" ""%V"""; Flags: uninsdeletekey; Tasks: contextmenu
; пункт по фону папки
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\PixPort"; ValueType: string; ValueName: "(Default)"; ValueData: "Показать QR здесь (PixPort)"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\PixPort"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\{#MyAppExeName}"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\PixPort\command"; ValueType: string; ValueName: "(Default)"; ValueData: """{app}\{#MyAppExeName}"" ""%V"""; Flags: uninsdeletekey; Tasks: contextmenu

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Запустить PixPort"; Flags: nowait postinstall skipifsilent
