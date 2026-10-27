@echo off
rem Start dev env: free the dev port from vite.config.ts, then pnpm tauri dev
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1" %*
if errorlevel 1 (
  pause
  exit /b 1
)
