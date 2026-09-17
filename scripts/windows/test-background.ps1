param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Stop"
$testFiles = @(
  (Join-Path $ProjectRoot "test\integration\background-control.test.js"),
  (Join-Path $ProjectRoot "test\integration\background-lock.test.js"),
  (Join-Path $ProjectRoot "test\integration\background-process.test.js")
)
& node --test --test-reporter=spec @testFiles
if ($LASTEXITCODE -ne 0) {
  throw "后台进程集成测试失败，退出码：$LASTEXITCODE"
}
