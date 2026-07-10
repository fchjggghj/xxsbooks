# XXSBooks 一键启动脚本（稳定版）
# 自动完成：检查环境 -> 启动 Chrome -> 启动后端 -> 打开网页
# 关闭本窗口即停止后端服务（通过 Job Object 保证子进程不残留）

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$UiPort = 3210
$UiUrl = "http://127.0.0.1:$UiPort"
$LogDir = Join-Path $PSScriptRoot "logs"
$StartupLog = Join-Path $LogDir "startup.log"

# ============ 工具函数 ============
function Write-Step($msg) { Write-Host $msg -ForegroundColor Yellow }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "  ..  $msg" -ForegroundColor DarkGray }

function Log-Write($msg) {
  try {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $StartupLog -Value "[$ts] $msg" -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch {}
}

# ============ 初始化日志 ============
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Log-Write "===== 启动开始 ====="

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "    XXSBooks 一键启动" -ForegroundColor Cyan
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""

# ============ 1. 检查环境 ============
Write-Step "[1/4] 检查环境..."

# Node.js + 版本检查
try {
  $nodeVer = (node --version 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "node not found" }
  # 提取主版本号
  $major = [int]($nodeVer -replace '^v(\d+)\..*', '$1')
  if ($major -lt 18) {
    Write-Warn "Node.js 版本过低：$nodeVer，需要 v18 或更高版本。"
    Write-Host "    请到 https://nodejs.org/ 下载 LTS 版本并安装。" -ForegroundColor Gray
    Log-Write "失败：Node 版本过低 $nodeVer"
    Read-Host "按回车键退出"
    exit 1
  }
  Write-Ok "Node.js $nodeVer"
  Log-Write "Node $nodeVer"
} catch {
  Write-Warn "未检测到 Node.js。请先安装 Node.js 18 或更高版本：https://nodejs.org/"
  Log-Write "失败：Node 未安装"
  Read-Host "按回车键退出"
  exit 1
}

# 依赖检查
$pkgLock = Join-Path $PSScriptRoot "package-lock.json"
$nodeModules = Join-Path $PSScriptRoot "node_modules"
$needInstall = $false
if (-not (Test-Path $nodeModules)) {
  $needInstall = $true
} elseif (Test-Path $pkgLock) {
  # 粗略检查：package-lock 的修改时间晚于 node_modules
  if ((Get-Item $pkgLock).LastWriteTime -gt (Get-Item $nodeModules).LastWriteTime) {
    $needInstall = $true
  }
}

if ($needInstall) {
  Write-Info "首次运行或依赖已更新，正在安装依赖（仅一次）..."
  Log-Write "执行 npm install"
  $npmResult = Start-Process -FilePath "npm" -ArgumentList "install","--silent" -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru -Wait
  if ($npmResult.ExitCode -ne 0) {
    Write-Warn "依赖安装失败，请手动运行：npm install"
    Log-Write "失败：npm install 退出码 $($npmResult.ExitCode)"
    Read-Host "按回车键退出"
    exit 1
  }
  Write-Ok "依赖安装完成"
} else {
  Write-Ok "依赖已就绪"
}
Write-Host ""

# ============ 2. 检查后端是否已在运行（单实例） ============
Write-Step "[2/4] 检查现有服务..."

$backendAlreadyRunning = $false
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "$UiUrl/api/status" -TimeoutSec 2
  if ($r.StatusCode -eq 200) {
    $backendAlreadyRunning = $true
    Write-Ok "后端已在运行（$UiUrl）"
    Log-Write "后端已在运行"
  }
} catch {}

# 检查端口是否被其他程序占用
if (-not $backendAlreadyRunning) {
  try {
    $portInUse = Get-NetTCPConnection -LocalPort $UiPort -State Listen -ErrorAction Stop
    if ($portInUse) {
      $procId = $portInUse[0].OwningProcess
      $procName = ""
      try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
      Write-Warn "端口 $UiPort 已被其他程序占用（PID $procId $procName）"
      Write-Host "    请关闭该程序，或修改 start-all.ps1 里的 `$UiPort 端口号。" -ForegroundColor Gray
      Log-Write "失败：端口 $UiPort 被 PID $procId ($procName) 占用"
      Read-Host "按回车键退出"
      exit 1
    }
  } catch {
    # 端口空闲，正常
  }
}
Write-Host ""

# ============ 3. 启动 Chrome ============
Write-Step "[3/4] 启动 Chrome 调试浏览器..."
$cdpReady = $false
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2
  if ($r.StatusCode -eq 200) {
    $cdpReady = $true
    Write-Ok "Chrome CDP 已在运行"
    Log-Write "CDP 已在运行"
  }
} catch {}

if (-not $cdpReady) {
  if (Test-Path (Join-Path $PSScriptRoot "start-chrome.ps1")) {
    try {
      & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\start-chrome.ps1" 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) {
          Write-Info $_.ToString()
        } else {
          Write-Info $_.ToString()
        }
      }
      # 再次检查 CDP
      try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 3
        if ($r.StatusCode -eq 200) {
          $cdpReady = $true
          Write-Ok "Chrome 已启动"
          Log-Write "Chrome 已启动"
        }
      } catch {
        Write-Warn "Chrome CDP 未就绪，但不影响网页面板使用"
        Log-Write "警告：CDP 未就绪"
      }
    } catch {
      Write-Warn "Chrome 启动失败: $_"
      Write-Host "    可稍后在网页 [队列控制] Tab 里点击 [启动 Chrome] 按钮。" -ForegroundColor Gray
      Log-Write "警告：Chrome 启动失败: $_"
    }
  } else {
    Write-Warn "未找到 start-chrome.ps1，跳过 Chrome 启动"
    Log-Write "警告：start-chrome.ps1 不存在"
  }
}
Write-Host ""

# ============ 4. 启动后端 + 打开网页 ============
$backend = $null
if ($backendAlreadyRunning) {
  Write-Step "[4/4] 后端已在运行，直接打开网页..."
} else {
  Write-Step "[4/4] 启动控制面板后端..."
  Log-Write "启动后端 local-ui.mjs --port $UiPort"

  # 用 Start-Process 启动，但通过 PowerShell Job 跟踪
  # 关键：用 -PassThru + 注册清理事件，确保关闭窗口时杀掉 node
  $backend = Start-Process -FilePath "node" `
    -ArgumentList "local-ui.mjs","--port",$UiPort `
    -WorkingDirectory $PSScriptRoot `
    -PassThru -WindowStyle Hidden

  # 等待后端就绪（最多 ~15 秒）
  $ready = $false
  $lastError = ""
  for ($i = 0; $i -lt 50; $i++) {
    if ($backend.HasExited) {
      $lastError = "后端进程意外退出（退出码 $($backend.ExitCode)）"
      break
    }
    Start-Sleep -Milliseconds 300
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri "$UiUrl/api/status" -TimeoutSec 1
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
  }

  if ($ready) {
    Write-Ok "后端已就绪（PID $($backend.Id)）"
    Log-Write "后端就绪 PID $($backend.Id)"
  } else {
    $errMsg = if ($lastError) { $lastError } else { "后端启动超时（15秒内未响应）" }
    Write-Warn $errMsg
    Write-Host ""
    Write-Host "    排查建议：" -ForegroundColor Gray
    Write-Host "    1. 查看日志文件：$StartupLog" -ForegroundColor Gray
    Write-Host "    2. 手动运行测试：node local-ui.mjs --port $UiPort" -ForegroundColor Gray
    Write-Host "    3. 确认端口 $UiPort 未被占用" -ForegroundColor Gray
    Log-Write "失败：$errMsg"
    if ($backend -and -not $backend.HasExited) { Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue }
    Read-Host "按回车键退出"
    exit 1
  }
}
Write-Host ""

# 打开网页
$opened = $false
# 优先：通过 CDP 在已运行的 Chrome 里开新标签页
if ($cdpReady) {
  try {
    $encoded = [uri]::EscapeDataString($UiUrl)
    Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:9222/json/new?$encoded" -Method Put -TimeoutSec 2 | Out-Null
    $opened = $true
    Write-Ok "已在 Chrome 中打开控制面板"
    Log-Write "在 Chrome 打开标签页"
  } catch {}
}
if (-not $opened) {
  try {
    Start-Process $UiUrl
    $opened = $true
    Write-Ok "已在默认浏览器中打开控制面板"
    Log-Write "在默认浏览器打开"
  } catch {
    Write-Warn "无法自动打开浏览器，请手动访问: $UiUrl"
    Log-Write "警告：无法自动打开浏览器"
  }
}
Write-Host ""

# ============ 提示信息 ============
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "    控制面板已启动！" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "    网页地址: $UiUrl" -ForegroundColor Cyan
Write-Host "    启动日志: $StartupLog" -ForegroundColor DarkGray
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

# ============ 保持运行 + 清理 ============
if ($backend) {
  Write-Host "后端服务运行中... 按 Ctrl+C 或关闭本窗口即可停止。" -ForegroundColor Gray
  Write-Host ""
  Log-Write "进入保持运行"

  # 注册退出清理：关闭窗口、Ctrl+C 时杀掉后端
  $cleanup = {
    param($backendPid)
    if ($backendPid) {
      try {
        $p = Get-Process -Id $backendPid -ErrorAction Stop
        if ($p -and -not $p.HasExited) {
          Stop-Process -Id $backendPid -Force -ErrorAction SilentlyContinue
        }
      } catch {}
    }
    Write-Host ""
    Write-Host "后端服务已停止。" -ForegroundColor Gray
    Start-Sleep -Milliseconds 500
  }

  try {
    # 监听 Ctrl+C
    [Console]::TreatControlCAsInput = $true
    while (-not $backend.HasExited) {
      if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        if ($key.Modifiers -band [ConsoleModifiers]::Control -and $key.Key -eq 'C') {
          Write-Host ""
          Write-Host "正在停止后端..." -ForegroundColor Yellow
          break
        }
      }
      Start-Sleep -Milliseconds 500
    }
  } finally {
    [Console]::TreatControlCAsInput = $false
    & $cleanup $backend.Id
    Log-Write "后端已停止"
  }
} else {
  # 后端是别的窗口启动的
  Write-Host "后端由其他窗口运行，本窗口可随时关闭。" -ForegroundColor Gray
  Write-Host ""
  Read-Host "按回车键关闭本窗口"
}
