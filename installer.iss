[Setup]
AppId={{A7C3E1B4-6F28-4D5A-9C01-8B2E4F6A1D73}
AppName=Vega Raporlama
AppVersion=1.2.1
AppPublisher=Expert Bilişim
DefaultDirName={autopf}\Vega Raporlama
DefaultGroupName=Vega Raporlama
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=VegaRaporlama-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName=Vega Raporlama
SetupIconFile=assets\expert-bilisim.ico

[Languages]
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"

[Files]
Source: "dist\VegaRaporlama.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "baslat.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "assets\expert-bilisim.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Vega Raporlama"; Filename: "{app}\baslat.vbs"; IconFilename: "{app}\expert-bilisim.ico"; WorkingDir: "{app}"
Name: "{autodesktop}\Vega Raporlama"; Filename: "{app}\baslat.vbs"; IconFilename: "{app}\expert-bilisim.ico"; WorkingDir: "{app}"

[Run]
Filename: "{app}\baslat.vbs"; Description: "Vega Raporlama'yı başlat"; Flags: nowait postinstall skipifsilent shellexec
