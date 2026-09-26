param(
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  [string]$DataDir = (Join-Path $ProjectRoot ".data"),
  [string]$OutputDir = "",
  [int]$Port = 4310
)

$ErrorActionPreference = "Stop"

function Quote-ShortcutArgument([string]$value) {
  return '"' + $value.Replace('"', '""') + '"'
}

$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "博主图片采集后台.lnk"
$launcher = Join-Path $ProjectRoot "scripts\windows\launch-tray.vbs"
$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
$arguments = @(
  $launcher,
  "-DataDir", $DataDir,
  "-Port", "$Port"
)
if ($OutputDir) { $arguments += @("-OutputDir", $OutputDir) }
$arguments = $arguments | ForEach-Object { Quote-ShortcutArgument $_ }

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $wscript
$shortcut.Arguments = $arguments -join " "
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.Description = "登录后启动博主图片采集托盘与后台"
$shortcut.Save()

Write-Output "已创建当前用户登录启动项：$shortcutPath"
