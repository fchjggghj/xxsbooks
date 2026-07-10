@echo off
chcp 65001 >nul
cd /d "%~dp0"
title XXSBooks Ò»¼üÆô¶¯
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"