@echo off
title XXSBooks Launcher
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo ============================================
  echo  Startup failed. See logs\startup.log
  echo ============================================
  pause
)