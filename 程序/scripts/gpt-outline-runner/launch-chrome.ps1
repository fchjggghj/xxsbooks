# 用「调试端口 + 独立配置目录」启动 Chrome，供脚本通过 CDP 连接。
# 第一次运行后，在弹出的这个 Chrome 窗口里登录 ChatGPT、打开你的自定义 GPT；
# 登录态会保存在 C:\chrome-automation，以后不用重复登录。
# 注意：这是独立窗口，和你平时用的 Chrome 互不干扰。

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { Write-Host "找不到 chrome.exe，请改这个脚本里的路径"; exit 1 }

$userData = "C:\chrome-automation"
New-Item -ItemType Directory -Force -Path $userData | Out-Null

# 注意：已去掉 --disable-extensions，以便加载你装的油猴(Tampermonkey)+ChatGPTKeep 脚本。
& $chrome --remote-debugging-port=9222 --user-data-dir="$userData" "https://chatgpt.com/"
