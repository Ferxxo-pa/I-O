@echo off
cd /d "%~dp0\..\.."
call "%~dp0lock-secrets.cmd"
:again
node scripts\run-with-env.mjs
timeout /t 3 /nobreak >nul
goto again
