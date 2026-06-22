# 启动本地监控网页（零依赖，复用项目 lib）。开浏览器看 http://localhost:8787
# 用法： powershell -ExecutionPolicy Bypass -File .\launch-web.ps1
$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8787
Write-Host "启动监控网页 http://localhost:$port  （Ctrl+C 退出）" -ForegroundColor Cyan
Start-Process "http://localhost:$port"
node "$proj\server.mjs"
