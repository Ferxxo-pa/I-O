@echo off
setlocal
cd /d "%~dp0\.."
if not exist package.json (
  echo This script has to run from the I/O repo.
  exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22, then run scripts\start-shop.cmd again.
  exit /b 1
)
if not exist node_modules (
  call npm ci
  if errorlevel 1 exit /b 1
)
if not exist .env (
  copy /y .env.example .env >nul
  echo Created .env from .env.example. Square stays a dry run. The token stays in this file.
)
if not exist dist\index.js (
  call npm run build
  if errorlevel 1 exit /b 1
)
echo.
echo I/O is starting. Open the LAN_BASE_URL from .env, or http://127.0.0.1:5000 on this PC.
echo Leave SQUARE_PRESENCE_MIRROR unset. Do not deploy the mailbox from this script.
echo.
node scripts\run-with-env.mjs
exit /b %ERRORLEVEL%
