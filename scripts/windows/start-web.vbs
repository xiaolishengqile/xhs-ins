Option Explicit

Function QuoteArgument(value)
  QuoteArgument = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Dim fs, shell, projectRoot, launcher, command, index
Set fs = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
projectRoot = fs.GetParentFolderName(fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName)))
launcher = fs.BuildPath(projectRoot, "scripts\open-web.js")
shell.CurrentDirectory = projectRoot
If shell.Run("cmd.exe /c where node >nul 2>nul", 0, True) <> 0 Then
  MsgBox "Node.js 22 or newer is required. See README.md.", vbExclamation
  WScript.Quit 1
End If
command = "cmd.exe /c node " & QuoteArgument(launcher)
For index = 0 To WScript.Arguments.Count - 1
  command = command & " " & QuoteArgument(WScript.Arguments(index))
Next
If shell.Run(command, 0, True) <> 0 Then
  MsgBox "Could not start the local page. Check dependencies and background logs.", vbExclamation
  WScript.Quit 1
End If
