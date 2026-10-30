' Runs post-status.js with no console window (the hourly task calls this).
' Argument 0 is the full path to node.exe.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & WScript.Arguments(0) & """ """ & dir & "\post-status.js""", 0, True
