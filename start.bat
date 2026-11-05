@echo off
chcp 65001 >nul
title Skills Studio
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo         Install Node.js 22.19 or newer, then run this file again.
  pause
  exit /b 1
)

node "scripts\dev-start.mjs" %*
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] Launcher exited with code %EXITCODE%.
  pause
)
exit /b %EXITCODE%
