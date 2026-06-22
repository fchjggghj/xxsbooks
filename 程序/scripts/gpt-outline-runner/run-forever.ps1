# ============================================================
# run-forever.ps1  —  守护脚本：开机自动跑 + 崩溃自动重启
# 目标：把全库分档计划（约 23 万章）尽量全部拆完。
#
# 它做四件事：
#   1) 保证调试 Chrome（端口 9222）在线，不在就自动拉起来
#   2) 反复运行 node run.mjs；若已有 runner 在跑则等待，崩了/断了 30 秒后自动重开（断点续传，不重复）
#   3) 每轮先查待处理数（__PENDING__ 标记），为 0 时判定全部完成、自动退出
#   4) 所有动作写 daemon.log；每轮逐章日志写 run.log
#
# 控制命令（在 PowerShell 里）：
#   优雅停止 : New-Item -ItemType File "C:\Users\Administrator\Desktop\novel_pipeline\程序\scripts\gpt-outline-runner\STOP"
#             （守护跑完当前这章后退出；想恢复就删掉 STOP 文件再 Start-ScheduledTask）
#   立即停止 : Stop-ScheduledTask -TaskName GptOutlineRunner
#             再杀残留: Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
#                       ? { $_.CommandLine -like '*run.mjs*' } | % { Stop-Process $_.ProcessId -Force }
#   手动开始 : Start-ScheduledTask -TaskName GptOutlineRunner
#   彻底卸载 : Unregister-ScheduledTask -TaskName GptOutlineRunner -Confirm:$false
#   看进度   : run.log（当前这轮逐章）、daemon.log（重启/完成等大事件）
# ============================================================

$ErrorActionPreference = 'Continue'
$proj    = $PSScriptRoot   # 自定位：脚本所在目录即运行器目录（随项目搬迁自动跟随）
$userDir = 'C:\chrome-automation'
$cdp     = 'http://localhost:9222/json/version'
$stop    = Join-Path $proj 'STOP'
$dlog    = Join-Path $proj 'daemon.log'
$runLog  = Join-Path $proj 'run.log'
$runErr  = Join-Path $proj 'run.err.log'
$daemonLock = Join-Path $proj '.daemon.lock'

function Log($m) {
  $t = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $dlog -Value "[$t] $m"
}

function ChromeUp {
  try { Invoke-RestMethod -Uri $cdp -TimeoutSec 5 | Out-Null; return $true } catch { return $false }
}

function EnsureChrome {
  if (ChromeUp) { return }
  Log 'CHROME_DOWN launching debug chrome'
  $chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
  if (-not (Test-Path $chrome)) { $chrome = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe' }
  if (-not (Test-Path $chrome)) { Log 'CHROME_NOT_FOUND'; return }
  New-Item -ItemType Directory -Force -Path $userDir | Out-Null
  # 已去掉 --disable-extensions：让油猴(Tampermonkey)+ChatGPTKeep 扩展正常加载。
  Start-Process -FilePath $chrome -ArgumentList @('--remote-debugging-port=9222', "--user-data-dir=$userDir", 'https://chatgpt.com/')
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep 2; if (ChromeUp) { Log 'CHROME_READY'; return } }
  Log 'CHROME_WAIT_TIMEOUT (maybe needs manual login)'
}

function Test-ProcessAlive($processId) {
  if (-not $processId) { return $false }
  try { Get-Process -Id $processId -ErrorAction Stop | Out-Null; return $true } catch { return $false }
}

function AcquireDaemonLock {
  if (Test-Path $daemonLock) {
    $raw = Get-Content -Raw -Path $daemonLock -ErrorAction SilentlyContinue
    $m = [regex]::Match([string]$raw, 'pid=(\d+)')
    if ($m.Success -and (Test-ProcessAlive ([int]$m.Groups[1].Value))) {
      Log ('DAEMON_ALREADY_RUNNING pid=' + $m.Groups[1].Value + ' exit')
      exit 0
    }
    Remove-Item -Path $daemonLock -Force -ErrorAction SilentlyContinue
  }

  try {
    New-Item -ItemType File -Path $daemonLock -Value ("pid=$PID`nstartedAt=$(Get-Date -Format o)`n") -ErrorAction Stop | Out-Null
  } catch {
    Log ('DAEMON_LOCK_FAILED exit: ' + $_.Exception.Message)
    exit 1
  }
}

function ReleaseDaemonLock {
  try {
    if (-not (Test-Path $daemonLock)) { return }
    $raw = Get-Content -Raw -Path $daemonLock -ErrorAction SilentlyContinue
    if ([string]$raw -match "pid=$PID(\r?\n|$)") {
      Remove-Item -Path $daemonLock -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

function GetActiveRunners {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*run.mjs*' } |
    Select-Object ProcessId,CommandLine)
}

AcquireDaemonLock
try {
  Log '=== DAEMON START ==='
  while ($true) {
    if (Test-Path $stop) { Log 'STOP_FLAG exit'; break }

    EnsureChrome

    # 查还剩多少待处理：run.mjs --dry-run 会打印 ASCII 标记 __PENDING__=<n>
    $dry = & node "$proj\run.mjs" --dry-run 2>$null
    $ms  = [regex]::Match(($dry -join "`n"), '__PENDING__=(\d+)')
    $pending = if ($ms.Success) { [int]$ms.Groups[1].Value } else { -1 }
    Log "PENDING=$pending"
    if ($pending -eq 0) { Log 'ALL_DONE exit'; break }

    $active = GetActiveRunners
    if ($active.Count -gt 0) {
      Log ('RUNNER_ALREADY_ACTIVE pid=' + (($active | Select-Object -First 1).ProcessId) + ' wait')
      Start-Sleep -Seconds 30
      continue
    }

    Log 'RUN_START'
    $p = Start-Process -FilePath 'node' -ArgumentList 'run.mjs' -WorkingDirectory $proj -NoNewWindow -PassThru -RedirectStandardOutput $runLog -RedirectStandardError $runErr
    $p.WaitForExit()
    Log ('RUN_EXIT code=' + $p.ExitCode)

    if (Test-Path $stop) { Log 'STOP_FLAG exit'; break }
    Start-Sleep -Seconds 30
  }
  Log '=== DAEMON END ==='
} finally {
  ReleaseDaemonLock
}
