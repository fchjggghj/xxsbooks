@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   novel_pipeline v2.0  TypeScript Edition
echo   下载 -^> 拆大纲 -^> 改编大纲 -^> 写正文
echo ============================================
echo.

:: ====== 1. 检测 Node.js ======
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
    echo 下载 LTS 版本（^>=20），安装后重试。
    pause
    exit /b 1
)
echo [OK] Node.js 已安装

:: ====== 2. 检测 pnpm ======
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo [安装] pnpm 未安装，正在安装...
    call npm install -g pnpm@9
    if %errorlevel% neq 0 (
        echo [错误] pnpm 安装失败，请手动执行：npm install -g pnpm@9
        pause
        exit /b 1
    )
)
echo [OK] pnpm 已就绪

:: ====== 3. 检测依赖 ======
if not exist "node_modules" (
    echo [安装] 首次运行，安装依赖（约 1-2 分钟）...
    call pnpm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
)

:: ====== 4. 检测构建产物 ======
if not exist "packages\server\dist\index.js" (
    echo [构建] 首次运行，构建所有包...
    call pnpm build
    if %errorlevel% neq 0 (
        echo [错误] 构建失败
        pause
        exit /b 1
    )
)

:: ====== 5. 检测 Chrome 9222 端口 ======
set CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe
set CHROME_USER=C:\chrome-automation

powershell -Command "try { $null = Invoke-RestMethod -Uri 'http://localhost:9222/json/version' -TimeoutSec 3; exit 0 } catch { exit 1 }" >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] Chrome 已在 9222 端口运行
) else (
    echo [启动] Chrome 未在 9222 端口，正在启动...
    if not exist "%CHROME_EXE%" (
        if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
            set CHROME_EXE=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
        ) else (
            echo [错误] 未找到 Chrome，请安装 Google Chrome
            pause
            exit /b 1
        )
    )
    if not exist "%CHROME_USER%" mkdir "%CHROME_USER%"
    start "" "%CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="%CHROME_USER%" https://chatgpt.com/

    echo [等待] Chrome 启动中，最多 60 秒...
    set WAITED=0
    :wait_chrome
    if %WAITED% geq 60 (
        echo [超时] Chrome 60 秒内未就绪，可能需要手动登录后重试。
        pause
        exit /b 1
    )
    powershell -Command "try { $null = Invoke-RestMethod -Uri 'http://localhost:9222/json/version' -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>nul
    if %errorlevel% equ 0 (
        echo [OK] Chrome 已就绪
        goto chrome_ready
    )
    timeout /t 2 /nobreak >nul
    set /a WAITED+=2
    goto wait_chrome
    :chrome_ready
)

echo.

:: ====== 6. 显示当前进度 ======
echo ====== 当前进度 ======
call pnpm status
echo ======================
echo.

:: ====== 7. 用户选择 ======
:menu
echo 请选择操作：
echo   1. 跑拆大纲（step1）
echo   2. 跑改编大纲（step2）
echo   3. 跑全部流水线（step1 -^> step2，严格顺序）
echo   4. 启动控制中心 Web UI（http://localhost:8787）
echo   5. 启动守护脚本（自动跑全部，崩溃自动重启）
echo   6. 只看进度（dry-run）
echo   7. 退出
echo.
set /p CHOICE=请输入编号 (1-7):

if "%CHOICE%"=="1" goto step1
if "%CHOICE%"=="2" goto step2
if "%CHOICE%"=="3" goto step_all
if "%CHOICE%"=="4" goto webui
if "%CHOICE%"=="5" goto daemon
if "%CHOICE%"=="6" goto status
if "%CHOICE%"=="7" exit /b 0
echo 无效选择，请重新输入。
echo.
goto menu

:: ====== step1 ======
:step1
echo.
echo ====== 启动 step1 拆大纲 ======
call pnpm outline
echo.
echo ====== step1 已结束 ======
pause
goto menu

:: ====== step2 ======
:step2
echo.
echo ====== 启动 step2 改编大纲 ======
call pnpm adapt
echo.
echo ====== step2 已结束 ======
pause
goto menu

:: ====== step1 -> step2 ======
:step_all
echo.
echo ====== 启动流水线（严格顺序：拆 -^> 改）======
call pnpm pipeline
echo.
echo ====== 流水线已结束 ======
pause
goto menu

:: ====== Web UI ======
:webui
echo.
echo ====== 启动控制中心 Web UI ======
echo 浏览器访问：http://localhost:8787
echo 按 Ctrl+C 停止服务。
echo.
call pnpm start:server
pause
goto menu

:: ====== 守护脚本 ======
:daemon
echo.
echo ====== 启动守护脚本 ======
echo 自动跑 step1 -^> step2，崩溃 30 秒自动重启。
echo 优雅停止：在 程序\scripts 目录创建 STOP 文件
echo 日志：程序\scripts\logs\pipeline-daemon.log
echo.
powershell -ExecutionPolicy Bypass -File "程序\scripts\run-pipeline-forever.ps1"
pause
goto menu

:: ====== 只看进度 ======
:status
echo.
echo ====== 当前进度（dry-run）======
call pnpm pipeline:dry
echo ======================
echo.
goto menu
