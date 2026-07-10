# XXSBooks 一键启动脚本
# 自动完成：检查环境 -> 启动 Chrome -> 启动后端 -> 打开网页
# 关闭本窗口即停止后端服务

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$UiPort = 3210
$UiUrl = "http://127.0.0.1:$UiPort"

function Write-Step($msg) { Write-Host $msg -ForegroundColor Yellow }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "    XXSBooks 一键启动" -ForegroundColor Cyan
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""

# ============ 1. 检查环境 ============
Write-Step "[1/4] 检查环境..."

# Node.js
try {
  $nodeVer = (node --version 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "node not found" }
  Write-Ok "Node.js $nodeVer"
} catch {
  Write-Warn "未检测到 Node.js。请先安装 Node.js 20 或更高版本：https://nodejs.org/"
  Write-Host ""
  Read-Host "按回车键退出"
  exit 1
}

# 依赖
if (-not (Test-Path "$PSScriptRoot\node_modules")) {
  Write-Step "  首次运行，正在安装依赖（仅一次）..."
  npm install --silent 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "依赖安装失败，请手动运行：npm install"
    Read-Host "按回车键退出"
    exit 1
  }
  Write-Ok "依赖安装完成"
} else {
  Write-Ok "依赖已就绪"
}
Write-Host ""

# ============ 2. 启动 Chrome ============
Write-Step "[2/4] 启动 Chrome 调试浏览器..."
$cdpReady = $false
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2
  if ($r.StatusCode -eq 200) {
    $cdpReady = $true
    Write-Ok "Chrome CDP 已在运行"
  }
} catch {}

if (-not $cdpReady) {
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\start-chrome.ps1"
    # start-chrome.ps1 自己会等待 CDP 就绪
    Write-Ok "Chrome 已启动"
    $cdpReady = $true
  } catch {
    Write-Warn "Chrome 启动失败: $_"
    Write-Warn "可稍后在网页里点击 [启动 Chrome] 按钮"
  }
}
Write-Host ""

# ============ 3. 启动后端 ============
Write-Step "[3/4] 启动控制面板后端..."

# 检查端口是否已被占用（后端可能已在运行）
$existing = $null
try {
  $existing = Get-NetTCPConnection -LocalPort $UiPort -State Listen -ErrorAction Stop
} catch {}

$backend = $null
if ($existing) {
  Write-Ok "后端已在运行（端口 $UiPort 被占用）"
} else {
  $backend = Start-Process -FilePath "node" `
    -ArgumentList "local-ui.mjs","--port",$UiPort `
    -WorkingDirectory $PSScriptRoot `
    -PassThru -WindowStyle Hidden

  # 等待后端就绪（最多 ~9 秒）
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 300
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri "$UiUrl/api/status" -TimeoutSec 1
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
  }

  if ($ready) {
    Write-Ok "后端已就绪（PID $($backend.Id)）"
  } else {
    Write-Warn "后端启动超时"
    if ($backend -and -not $backend.HasExited) { Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue }
    Read-Host "按回车键退出"
    exit 1
  }
}
Write-Host ""

# ============ 4. 打开网页 ============
Write-Step "[4/4] 在浏览器中打开控制面板..."
$opened = $false

# 优先：通过 CDP 在已运行的 Chrome 里开新标签页
if ($cdpReady) {
  try {
    $encoded = [uri]::EscapeDataString($UiUrl)
    Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:9222/json/new?$encoded" -Method Put -TimeoutSec 2 | Out-Null
    $opened = $true
    Write-Ok "已在 Chrome 中打开控制面板"
  } catch {
    # CDP 开标签失败，回退到默认浏览器
  }
}

if (-not $opened) {
  try {
    Start-Process $UiUrl
    $opened = $true
    Write-Ok "已在默认浏览器中打开控制面板"
  } catch {
    Write-Warn "无法自动打开浏览器，请手动访问: $UiUrl"
  }
}
Write-Host ""

# ============ 提示信息 ============
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "    控制面板已启动！" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "    网页地址: $UiUrl" -ForegroundColor Cyan
Write-Host ""
Write-Host "    在网页里可以：" -ForegroundColor White
Write-Host "      * 查看 拆文 / 正文 进度" -ForegroundColor White
Write-Host "      * 一键 启动 / 继续 / 停止 队列" -ForegroundColor White
Write-Host "      * 修复状态、导入新书、改配置" -ForegroundColor White
Write-Host "      * 启动 Chrome、查看日志、预检" -ForegroundColor White
Write-Host ""
Write-Host "    关闭本窗口 = 停止后端服务" -ForegroundColor Yellow
Write-Host "    （Chrome 不会被关闭，可以继续使用）" -ForegroundColor Gray
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""

# ============ 保持运行 ============
if ($backend) {
  Write-Host "后端服务运行中... 按 Ctrl+C 或关闭本窗口即可停止。" -ForegroundColor Gray
  Write-Host ""
  try {
    $backend.WaitForExit()
  } finally {
    if (-not $backend.HasExited) {
      Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host ""
    Write-Host "后端服务已停止。" -ForegroundColor Gray
    Start-Sleep -Seconds 1
  }
} else {
  # 后端是别的窗口启动的，本窗口只起提示作用
  Write-Host "后端由其他窗口运行，本窗口可随时关闭。" -ForegroundColor Gray
  Write-Host ""
  Read-Host "按回车键关闭本窗口"
}
