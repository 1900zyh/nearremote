Option Explicit

' Keep this source ASCII so Windows Script Host reads it consistently on every locale.
' The scripts own process validation; this wrapper only hides their console and shows failures.
Dim shell, files, operation, noDialog, noBrowser, arg, projectDirectory, scriptDirectory
Dim dataDirectory, logPath, powershellPath, scriptPath, command, exitCode, failure, launchedAt
Dim requiredFile, requiredPath
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
operation = "start"
noDialog = False
noBrowser = False
If WScript.Arguments.Count > 0 Then operation = LCase(WScript.Arguments(0))
For Each arg In WScript.Arguments
  If LCase(CStr(arg)) = "--no-dialog" Then noDialog = True
  If LCase(CStr(arg)) = "--no-browser" Then noBrowser = True
Next

scriptDirectory = files.GetParentFolderName(WScript.ScriptFullName)
projectDirectory = files.GetParentFolderName(scriptDirectory)
dataDirectory = shell.Environment("PROCESS")("REMOTE_DATA_DIR")
If Len(dataDirectory) = 0 Then dataDirectory = files.BuildPath(shell.ExpandEnvironmentStrings("%APPDATA%"), "NearRemote")
dataDirectory = files.GetAbsolutePathName(dataDirectory)
If operation = "stop" Then
  logPath = files.BuildPath(dataDirectory, "stop-launcher.log")
Else
  logPath = files.BuildPath(dataDirectory, "startup-launcher.log")
End If
powershellPath = files.BuildPath(shell.ExpandEnvironmentStrings("%SystemRoot%"), "System32\WindowsPowerShell\v1.0\powershell.exe")

If operation <> "start" And operation <> "stop" And operation <> "check" Then
  ShowFailure UnicodeText("542F 52A8 53C2 6570 65E0 6548 3002 8BF7 4F7F 7528 20 73 74 61 72 74 2E 62 61 74 20 6216 20 73 74 6F 70 2E 62 61 74 3002")
  WScript.Quit 2
End If

scriptPath = files.BuildPath(scriptDirectory, operation & "-background.ps1")
If operation = "check" Then scriptPath = files.BuildPath(scriptDirectory, "start-background.ps1")
If Not files.FileExists(powershellPath) Then
  ShowFailure "Windows PowerShell was not found: " & powershellPath
  WScript.Quit 1
End If
For Each requiredFile In Array("start-background.ps1", "stop-background.ps1", "launcher-common.ps1")
  requiredPath = files.BuildPath(scriptDirectory, requiredFile)
  If Not files.FileExists(requiredPath) Then
    ShowFailure "A required NearRemote launcher file is missing: " & requiredPath
    WScript.Quit 1
  End If
Next
If operation = "check" Then
  If noDialog Then WScript.Echo "NearRemote launcher validation passed."
  WScript.Quit 0
End If

shell.CurrentDirectory = projectDirectory
command = Quote(powershellPath) & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Quote(scriptPath)
If operation = "start" And Not noBrowser Then command = command & " -OpenBrowser"
launchedAt = Now
On Error Resume Next
exitCode = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  failure = Err.Description
  Err.Clear
  exitCode = 1
End If
On Error GoTo 0
If exitCode <> 0 Then
  If Len(failure) = 0 Then failure = LastLogMessage(logPath, launchedAt)
  If Len(failure) = 0 Then failure = UnicodeText("542F 52A8 5668 672A 80FD 5B8C 6210 64CD 4F5C FF0C 9519 8BEF 4EE3 7801 FF1A") & CStr(exitCode)
  ShowFailure failure
End If
WScript.Quit exitCode

Function Quote(value)
  Quote = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Function UnicodeText(hexCodes)
  Dim code, result
  result = ""
  For Each code In Split(hexCodes, " ")
    result = result & ChrW(CLng("&H" & code))
  Next
  UnicodeText = result
End Function

Function LastLogMessage(filename, afterTime)
  Dim logFile, stream, text, lines, index, result
  result = ""
  On Error Resume Next
  If files.FileExists(filename) Then
    Set logFile = files.GetFile(filename)
    ' Avoid presenting an earlier failure as the reason for a different current problem.
    If logFile.DateLastModified >= DateAdd("s", -2, afterTime) And logFile.Size <= 1048576 Then
      Set stream = CreateObject("ADODB.Stream")
      stream.Type = 2
      stream.Charset = "utf-8"
      stream.Open
      stream.LoadFromFile filename
      text = stream.ReadText
      stream.Close
      If Err.Number = 0 Then
        lines = Split(Replace(text, vbCr, ""), vbLf)
        For index = UBound(lines) To 0 Step -1
          If Len(Trim(lines(index))) > 0 Then
            result = Left(Trim(lines(index)), 400)
            Exit For
          End If
        Next
      End If
    End If
  End If
  Err.Clear
  On Error GoTo 0
  LastLogMessage = result
End Function

Sub ShowFailure(detail)
  Dim message
  If operation = "stop" Then
    message = UnicodeText("65E0 6CD5 7ED3 675F 20 4E 65 61 72 52 65 6D 6F 74 65 3002")
  Else
    message = UnicodeText("65E0 6CD5 542F 52A8 20 4E 65 61 72 52 65 6D 6F 74 65 3002")
  End If
  message = message & vbCrLf & vbCrLf & UnicodeText("539F 56E0 FF1A") & vbCrLf & detail & vbCrLf & vbCrLf & UnicodeText("8BE6 7EC6 65E5 5FD7 FF1A") & vbCrLf & logPath & vbCrLf & vbCrLf & UnicodeText("8BF7 786E 8BA4 6587 4EF6 5DF2 5B8C 6574 89E3 538B FF0C 518D 91CD 8BD5 3002")
  If noDialog Then
    WScript.Echo message
  Else
    MsgBox message, 16, "NearRemote"
  End If
End Sub
