# ============================================================
# run-pipeline-forever.ps1  —  统一守护脚本（TypeScript 版）
# 自动管理 Chrome + 先跑 step1 再跑 step2，崩溃 30 秒自动重启
#
# 功能：
#   1) 保证调试 Chrome（端口 9222）在线，不在就自动拉起来
#   2) 先跑 step1（拆大纲），待处理为 0 时自动切到 step2
#   3) 再跑 step2（改编大纲），待处理为 0 时完成退出
#   4) 崩溃 30 秒自动重启
#   5) STOP 文件优雅停止
#   6) daemon.lock 防重复启动
#   7) 所有日志写到 程序\scripts\logs\pipeline-daemon.log
#
# 控制命令（在 PowerShell 里）：
#   优雅停止 : New-Item -ItemType File "<项目根>\程序\scripts\STOP"
#   查看日志 : Get-Content 程序\scripts\logs\pipeline-daemon.log -Tail 50
# ============================================================

$ErrorActionPreference = 'Continue'
$projRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)  # 项目根
$scriptsDir = $PSScriptRoot                                          # 程序\scripts
$userDir   = 'C:\chrome-automation'
$cdp       = 'http://localhost:9222/json/version'
$stop      = Join-Path $scriptsDir 'STOP'
$logDir    = Join-Path $scriptsDir 'logs'
$dlog      = Join-Path $logDir 'pipeline-daemon.log'
$daemonLock = Join-Path $scriptsDir 'daemon.lock'

# 确保日志目录存在
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}

function Log($m) {
    $t = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $dlog -Value "[$t] $m"
    Write-Host "[$t] $m"
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
    } catch { /* ignore */ }
}

# 查某个 runner 的待处理数（--dry-run 输出 __PENDING__=N）
function GetPending($step) {
    $dry = & pnpm -s "$step:dry" 2>$null
    $ms  = [regex]::Match(($dry -join "`n"), '__PENDING__=(\d+)')
    if ($ms.Success) { return [int]$ms.Groups[1].Value } else { return -1 }
}

# 跑某个 runner，返回退出码
function RunStep($step, $stepName) {
    Log "STEP_START $stepName"
    $p = Start-Process -FilePath 'pnpm' -ArgumentList '-s', $step -WorkingDirectory $projRoot -NoNewWindow -PassThru -Wait
    $code = $p.ExitCode
    Log "STEP_EXIT $stepName code=$code"
    return $code
}

# ============================================================
# 主循环
# ============================================================
AcquireDaemonLock
try {
    Log '=== PIPELINE DAEMON START (TypeScript) ==='

    while ($true) {
        if (Test-Path $stop) { Log 'STOP_FLAG exit'; break }

        EnsureChrome

        # ---- Step 1: 拆大纲 ----
        $s1pending = GetPending 'outline'
        Log "STEP1_PENDING=$s1pending"

        if ($s1pending -eq 0) {
            Log 'STEP1_ALL_DONE'
        } elseif ($s1pending -gt 0) {
            # 反复跑 step1 直到待处理为 0
            while ($true) {
                if (Test-Path $stop) { Log 'STOP_FLAG exit'; break 2 }

                EnsureChrome

                $s1pending = GetPending 'outline'
                Log "STEP1_PENDING=$s1pending"
                if ($s1pending -eq 0) { Log 'STEP1_ALL_DONE'; break }
                if ($s1pending -lt 0) { Log 'STEP1_PENDING_UNKNOWN retry'; Start-Sleep -Seconds 30; continue }

                $code = RunStep 'outline' 'step1_outline'

                if (Test-Path $stop) { Log 'STOP_FLAG exit'; break 2 }
                Start-Sleep -Seconds 30
            }
        }

        # ---- Step 2: 改编大纲 ----
        $s2pending = GetPending 'adapt'
        Log "STEP2_PENDING=$s2pending"

        if ($s2pending -eq 0) {
            Log 'STEP2_ALL_DONE'
        } elseif ($s2pending -gt 0) {
            # 反复跑 step2 直到待处理为 0
            while ($true) {
                if (Test-Path $stop) { Log 'STOP_FLAG exit'; break 2 }

                EnsureChrome

                $s2pending = GetPending 'adapt'
                Log "STEP2_PENDING=$s2pending"
                if ($s2pending -eq 0) { Log 'STEP2_ALL_DONE'; break }
                if ($s2pending -lt 0) { Log 'STEP2_PENDING_UNKNOWN retry'; Start-Sleep -Seconds 30; continue }

                $code = RunStep 'adapt' 'step2_adapt'

                if (Test-Path $stop) { Log 'STOP_FLAG exit'; break 2 }
                Start-Sleep -Seconds 30
            }
        }

        # 两步都完成
        Log 'PIPELINE_ALL_DONE'
        break
    }

    Log '=== PIPELINE DAEMON END ==='
} finally {
    ReleaseDaemonLock
}
