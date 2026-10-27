@echo off
rem Stop dev env: kill dev processes and free the dev port.
rem No unconditional pause: this script is also called from editor tasks / CI.
powershell -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1" -Stop %*
if errorlevel 1 (
  echo.
  echo Not fully stopped -- port still held, or a process there is not this project's.
  pause
  exit /b 1
)
exit /b 0
