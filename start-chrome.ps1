param(
  [int]$Port = 9222,
  [string]$ProfileDir = "C:\chrome-automation",
  [string]$Url = "https://chatgpt.com"
)

$ErrorActionPreference = "Stop"

function Get-ChromePath {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  throw "Google Chrome was not found. Install Chrome or edit start-chrome.ps1 with the chrome.exe path."
}

function Test-CdpReady {
  param([int]$CheckPort)

  try {
    $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$CheckPort/json/version" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Open-CdpTab {
  param(
    [int]$CheckPort,
    [string]$TargetUrl
  )

  try {
    $encoded = [uri]::EscapeDataString($TargetUrl)
    Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$CheckPort/json/new?$encoded" -Method Put -TimeoutSec 2 | Out-Null
  } catch {
    Write-Host "CDP is already running, but opening a new tab through CDP failed. Open this URL manually: $TargetUrl"
  }
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
# 写入标识文件；权限不足（目录由管理员创建过）时静默跳过，不阻断启动
try {
  $marker = Join-Path $ProfileDir "GPTS_QUEUE_PROFILE_DO_NOT_DELETE.txt"
  if (-not (Test-Path -LiteralPath $marker)) {
    Set-Content -LiteralPath $marker -Encoding UTF8 -Value @(
      "This is the persistent Chrome profile for gpts-queue automation.",
      "Do not delete it unless you want to lose the ChatGPT login state."
    ) -ErrorAction Stop
  }
} catch {
  Write-Host "提示：无法写入 $ProfileDir 标识文件（权限不足），但不影响 Chrome 启动。" -ForegroundColor DarkGray
}

if (Test-CdpReady -CheckPort $Port) {
  Write-Host "Chrome CDP is already ready at http://127.0.0.1:$Port"
  Open-CdpTab -CheckPort $Port -TargetUrl $Url
  exit 0
}

$chrome = Get-ChromePath
$arguments = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$ProfileDir",
  "--no-first-run",
  "--no-default-browser-check",
  $Url
)

Start-Process -FilePath $chrome -ArgumentList $arguments -WindowStyle Normal

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  if (Test-CdpReady -CheckPort $Port) {
    Write-Host "Chrome CDP is ready at http://127.0.0.1:$Port"
    Write-Host "Profile dir: $ProfileDir"
    Write-Host "Log in to ChatGPT in the opened Chrome window, then keep this Chrome window open while running npm start."
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

throw "Chrome started, but CDP did not become ready at http://127.0.0.1:$Port within 20 seconds."
