@echo off
rem Start dev env: free the dev port (from vite.config.ts), then pnpm tauri dev.
rem Ctrl+C: cmd asks "Terminate batch job (Y/N)" -- answer N so dev.ps1 can clean up
rem (kill the tree, release the port). Answering Y takes powershell down with it and the
rem cleanup never runs; the leftovers are then cleared by the next start.bat.
powershell -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1" %*
if errorlevel 1 (
  echo.
  echo Dev env failed to start -- see the error above.
  pause
  exit /b 1
)
