$ErrorActionPreference = "Stop"
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) "博主图片采集后台.lnk"
if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Output "已删除当前用户登录启动项：$shortcutPath"
} else {
  Write-Output "当前用户未安装登录启动项。"
}
