@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS or newer, then reopen this file.
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1)"
if errorlevel 1 (
  echo Node.js 24 LTS or newer is required.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  call npm ci
  if errorlevel 1 (
    echo Dependencies could not be installed. Check your network and retry.
    pause
    exit /b 1
  )
)
call npm run pet
if errorlevel 1 pause
