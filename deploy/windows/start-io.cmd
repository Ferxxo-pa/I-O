@echo off
cd /d "%~dp0\..\.."
:again
node scripts\run-with-env.mjs
timeout /t 3 /nobreak >nul
goto again
