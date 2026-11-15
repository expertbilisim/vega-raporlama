Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
klasor = fso.GetParentFolderName(WScript.ScriptFullName)
exe = klasor & "\VegaRaporlama.exe"
If Not fso.FileExists(exe) Then
  exe = "C:\Program Files\Vega Raporlama\VegaRaporlama.exe"
  klasor = "C:\Program Files\Vega Raporlama"
End If
If fso.FileExists(exe) Then
  sh.CurrentDirectory = klasor
  ' 1 = normal pencere; 0 bazı sistemlerde Edge'i de gizleyebiliyor
  sh.Run """" & exe & """", 1, False
Else
  MsgBox "VegaRaporlama.exe bulunamadı.", vbExclamation, "Vega Raporlama"
End If
