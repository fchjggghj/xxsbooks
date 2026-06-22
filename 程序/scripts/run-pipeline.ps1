# run-pipeline.ps1 — 确保调试 Chrome(9222) 在线，然后跑一次流水线 pipeline.mjs（拆→改→写，已无下载步骤）。
# 注：流水线是「出错即停」的，不做无限重试守护；某阶段没过会停下等你排查后重跑。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\run-pipeline.ps1 [-- <pipeline参数>]
#   例：... run-pipeline.ps1 --from step2_adapt   （从某阶段起）
$ErrorActionPreference = 'Continue'
$scripts = $PSScriptRoot
$userDir = 'C:\chrome-automation'
$cdp     = 'http://localhost:9222/json/version'

function ChromeUp { try { Invoke-RestMethod -Uri $cdp -TimeoutSec 5 | Out-Null; return $true } catch { return $false } }
function EnsureChrome {
  if (ChromeUp) { Write-Host 'Chrome(9222) 在线'; return }
  $chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
  if (-not (Test-Path $chrome)) { $chrome = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe' }
  if (-not (Test-Path $chrome)) { Write-Host '找不到 Chrome'; return }
  New-Item -ItemType Directory -Force -Path $userDir | Out-Null
  Start-Process -FilePath $chrome -ArgumentList @('--remote-debugging-port=9222', "--user-data-dir=$userDir", 'https://chatgpt.com/')
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep 2; if (ChromeUp) { Write-Host 'Chrome 就绪'; return } }
  Write-Host 'Chrome 启动超时（可能需要手动登录三个自定义 GPT）'
}

EnsureChrome
$passthru = $args
& node (Join-Path $scripts 'pipeline.mjs') @passthru
exit $LASTEXITCODE
