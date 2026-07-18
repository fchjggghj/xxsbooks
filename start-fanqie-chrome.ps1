param(
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [string]$ProfileName = 'Default',
  [int]$Port = 9333,
  [string]$Url = 'https://fanqienovel.com/main/writer'
)

$ErrorActionPreference = 'Stop'

function Test-CdpReady {
  param([int]$CdpPort)
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/version" -TimeoutSec 1
    return $true
  } catch {
    return $false
  }
}

if (-not [System.IO.Path]::IsPathRooted($ProfileDir)) { throw "ProfileDir must be absolute: $ProfileDir" }

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $chrome) { throw 'Google Chrome was not found.' }

if (Test-CdpReady -CdpPort $Port) {
  Write-Output "Fanqie Chrome already ready: http://127.0.0.1:$Port"
  exit 0
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
$arguments = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$ProfileDir",
  "--profile-directory=$ProfileName",
  '--no-first-run',
  '--no-default-browser-check',
  $Url
)

# Keep this browser visible so the account can be signed in again if needed.
Start-Process -FilePath $chrome -ArgumentList $arguments

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  if (Test-CdpReady -CdpPort $Port) {
    Write-Output "Fanqie Chrome ready: http://127.0.0.1:$Port"
    exit 0
  }
}

throw "Chrome started but CDP port $Port is not ready. If this profile is already open in regular Chrome, close only that account window and retry. This script never kills Chrome processes."
