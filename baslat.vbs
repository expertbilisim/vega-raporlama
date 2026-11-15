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
  ' 0 = arka plan / konsol penceresi yok
  sh.Run """" & exe & """", 0, False
ElseIf fso.FileExists(klasor & "\server.js") Then
  sh.CurrentDirectory = klasor
  sh.Run "node server.js", 0, False
Else
  MsgBox "VegaRaporlama.exe bulunamadı.", vbExclamation, "Vega Raporlama"
End If
