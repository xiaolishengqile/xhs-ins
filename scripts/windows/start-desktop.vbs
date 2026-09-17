Option Explicit
Function QuoteArgument(value)
    QuoteArgument = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Dim fs, shell, projectDir, pythonPath, entryPath, command, index, installMessage
Set fs = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
projectDir = fs.GetParentFolderName(fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName)))
pythonPath = fs.BuildPath(projectDir, ".venv-desktop\Scripts\pythonw.exe")
entryPath = fs.BuildPath(projectDir, "desktop\main.py")
installMessage = ChrW(&H8BF7) & ChrW(&H5148) & ChrW(&H5B89) & ChrW(&H88C5) _
    & ChrW(&H684C) & ChrW(&H9762) & ChrW(&H8FD0) & ChrW(&H884C) & ChrW(&H73AF) & ChrW(&H5883) _
    & ": docs/desktop.md"
If Not fs.FileExists(pythonPath) Then
    MsgBox installMessage, vbExclamation
    WScript.Quit 1
End If
shell.CurrentDirectory = projectDir
If shell.Run(QuoteArgument(pythonPath) & " -c " & QuoteArgument("import PySide6.QtWidgets, PySide6.QtNetwork"), 0, True) <> 0 Then
    MsgBox installMessage, vbExclamation
    WScript.Quit 1
End If
command = QuoteArgument(pythonPath) & " " & QuoteArgument(entryPath)
For index = 0 To WScript.Arguments.Count - 1
    command = command & " " & QuoteArgument(WScript.Arguments(index))
Next
shell.Run command, 0, False
