@echo off
rem Stop dev env: kill dev processes and free the dev port
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1" -Stop %*
echo.
pause
