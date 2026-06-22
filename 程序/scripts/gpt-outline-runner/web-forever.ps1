# ============================================================
# web-forever.ps1 — 守护「网页控制中心」(server.mjs)
# 目标：登录后自动起、崩了/被关了自动拉回，让 http://localhost:8787 任何时候都能打开。
#
# 自定位：$PSScriptRoot 即运行器目录（随项目搬迁自动跟随，无需改路径）。
# 控制：
#   暂停守护 : New-Item -ItemType File "<本目录>\STOP_WEB"  （想恢复就删掉它）
#   手动启动 : Start-ScheduledTask -TaskName GptOutlineWeb
#   停止     : Stop-ScheduledTask  -TaskName GptOutlineWeb
#   卸载     : Unregister-ScheduledTask -TaskName GptOutlineWeb -Confirm:$false
# ============================================================
$ErrorActionPreference = 'Continue'
$proj = $PSScriptRoot
$stop = Join-Path $proj 'STOP_WEB'
$log  = Join-Path $proj 'web-daemon.log'
$port = 8787

function Log($m) {
  $t = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $log -Value "[$t] $m"
}
function WebUp {
  try { Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 4 -UseBasicParsing | Out-Null; return $true }
  catch { return $false }
}

Log '=== WEB DAEMON START ==='
while ($true) {
  if (Test-Path $stop) { Log 'STOP_WEB flag -> exit'; break }
  if (WebUp) {
    Start-Sleep -Seconds 20
    continue
  }
  Log 'WEB_DOWN -> start server.mjs'
  try {
    $p = Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $proj -WindowStyle Hidden -PassThru
    Log ("server.mjs started pid=" + $p.Id)
  } catch {
    Log ('START_FAILED: ' + $_.Exception.Message)
  }
  # 给它点时间起监听，再回到循环探活
  Start-Sleep -Seconds 8
}
Log '=== WEB DAEMON END ==='
