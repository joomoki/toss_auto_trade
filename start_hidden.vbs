Set WshShell = CreateObject("WScript.Shell")
WScript.Sleep 20000
WshShell.Run Chr(34) & "d:\toss_auto_trade\start.bat" & Chr(34), 0, False
