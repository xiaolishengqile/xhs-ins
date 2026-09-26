param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$DataDir = (Join-Path $ProjectRoot ".data"),
  [string]$OutputDir = "",
  [int]$Port = 4310
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$node = (Get-Command node -ErrorAction Stop).Path
$cli = Join-Path $ProjectRoot "scripts\background.js"
$installStartup = Join-Path $ProjectRoot "scripts\windows\install-startup.ps1"
$uninstallStartup = Join-Path $ProjectRoot "scripts\windows\uninstall-startup.ps1"
$commonArguments = @("--data-dir", $DataDir, "--port", "$Port", "--json")
if ($OutputDir) { $commonArguments += @("--output-dir", $OutputDir) }

function ConvertTo-NativeArgument([string]$value) {
  if ($value -notmatch '[\s"]') { return $value }
  $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Invoke-BackgroundCommand([string]$action) {
  $arguments = @($cli, $action) + $commonArguments
  if ($action -eq "stop") { $arguments += @("--timeout", "120000") }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $node
  $startInfo.Arguments = ($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join " "
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    return [PSCustomObject]@{
      Code = $process.ExitCode
      Output = $stdout.Result.Trim()
      Error = $stderr.Result.Trim()
    }
  } finally {
    $process.Dispose()
  }
}

function Get-BackgroundStatus {
  try {
    $result = Invoke-BackgroundCommand "status"
    if ($result.Code -ne 0) { return $null }
    return $result.Output | ConvertFrom-Json
  } catch { return $null }
}

function Invoke-Control([string]$action, [string]$successMessage) {
  try {
    $result = Invoke-BackgroundCommand $action
    if ($result.Code -ne 0) {
      Show-Notice $(if ($result.Error) { $result.Error } else { "后台操作失败。" })
      return $false
    }
    if ($successMessage) { Show-Notice $successMessage }
    return $true
  } catch {
    Show-Notice $_.Exception.Message
    return $false
  }
}

function Show-Notice([string]$message) {
  $notifyIcon.BalloonTipTitle = "博主图片采集"
  $notifyIcon.BalloonTipText = $message
  $notifyIcon.ShowBalloonTip(2500)
}

function Open-ManagementPage {
  $status = Get-BackgroundStatus
  if ($null -eq $status) {
    [void](Invoke-Control "start" "")
    for ($attempt = 0; $attempt -lt 40 -and $null -eq $status; $attempt++) {
      Start-Sleep -Milliseconds 250
      $status = Get-BackgroundStatus
    }
  }
  if ($null -eq $status) {
    Show-Notice "后台启动失败，请查看数据目录中的错误日志。"
    return
  }
  Start-Process $status.url
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add("正在检查后台状态…")
$statusItem.Enabled = $false
[void]$menu.Items.Add("打开管理界面", $null, { Open-ManagementPage })
[void]$menu.Items.Add("启动后台", $null, {
  [void](Invoke-Control "start" "后台已启动。")
})
[void]$menu.Items.Add("停止后台", $null, {
  [void](Invoke-Control "stop" "后台已安全停止。")
})
[void]$menu.Items.Add("暂停采集", $null, {
  [void](Invoke-Control "pause" "采集已暂停，后台仍在运行。")
})
[void]$menu.Items.Add("继续采集", $null, {
  [void](Invoke-Control "resume" "采集已继续。")
})
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add("启用登录时启动", $null, {
  & $installStartup -ProjectRoot $ProjectRoot -DataDir $DataDir -OutputDir $OutputDir -Port $Port | Out-Null
  Show-Notice "已启用当前用户登录时启动。"
})
[void]$menu.Items.Add("撤销登录时启动", $null, {
  & $uninstallStartup | Out-Null
  Show-Notice "已撤销登录时启动。"
})
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add("关闭托盘（后台继续）", $null, {
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  [System.Windows.Forms.Application]::ExitThread()
})
[void]$menu.Items.Add("退出并停止后台", $null, {
  if (Invoke-Control "stop" "") {
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::ExitThread()
  } else {
    Show-Notice "后台未能安全停止，托盘将继续保留。"
  }
})

$mutexBytes = [Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($ProjectRoot).ToLowerInvariant())
$mutexHash = [BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($mutexBytes)).Replace("-", "").Substring(0, 16)
$createdNew = $false
$trayMutex = New-Object Threading.Mutex($true, "Local\XhsInsTray-$mutexHash", [ref]$createdNew)
if (-not $createdNew) {
  $trayMutex.Dispose()
  exit 0
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Text = "博主图片采集"
$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Visible = $true
$notifyIcon.Add_DoubleClick({ Open-ManagementPage })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  $status = Get-BackgroundStatus
  if ($null -eq $status) {
    $statusItem.Text = "后台未运行"
    $notifyIcon.Text = "博主图片采集（未运行）"
  } else {
    $statusItem.Text = $(if ($status.paused) { "后台运行中（采集已暂停）：$($status.url)" } else { "后台运行中：$($status.url)" })
    $notifyIcon.Text = $(if ($status.paused) { "博主图片采集（已暂停）" } else { "博主图片采集（运行中）" })
  }
})
$timer.Start()

[void](Invoke-Control "start" "")
[System.Windows.Forms.Application]::Run()
$timer.Dispose()
$trayMutex.ReleaseMutex()
$trayMutex.Dispose()
