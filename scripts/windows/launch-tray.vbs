Option Explicit

Function QuoteArgument(value)
  QuoteArgument = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Dim command, fileSystem, index, projectRoot, scriptDirectory, shell, tray
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fileSystem.GetParentFolderName(fileSystem.GetParentFolderName(scriptDirectory))
tray = fileSystem.BuildPath(scriptDirectory, "background-tray.ps1")

command = QuoteArgument(CreateObject("WScript.Shell").ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")) _
  & " -NoProfile -ExecutionPolicy Bypass -File " & QuoteArgument(tray) _
  & " -ProjectRoot " & QuoteArgument(projectRoot)
For index = 0 To WScript.Arguments.Count - 1
  command = command & " " & QuoteArgument(WScript.Arguments(index))
Next

Set shell = CreateObject("WScript.Shell")
WScript.Quit shell.Run(command, 0, False)
