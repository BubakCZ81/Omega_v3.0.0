@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing project dependencies...
  call npm.cmd install || (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Starting Omega in Electron...
call npm.cmd run desktop
