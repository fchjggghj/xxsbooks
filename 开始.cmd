@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   novel_pipeline  下载 -^> 拆 -^> 改 -^> 写
echo ============================================
echo.
echo 各阶段进度：
call pnpm status
echo.
echo ----- 常用命令 -----
echo   一键启动（推荐）  ： 双击「一键启动.cmd」选择菜单
echo   跑拆大纲          ： pnpm outline
echo   只看计划（dry-run）： pnpm outline:dry
echo   跑改编大纲        ： pnpm adapt
echo   全部流水线        ： pnpm pipeline
echo   启动 Web UI       ： pnpm dev:all
echo.
pause
