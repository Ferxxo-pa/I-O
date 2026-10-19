@echo off
REM Lock .env and DATA_DIR to the dedicated io user. Best effort: startup continues if icacls fails.
set "IO_USER=%IO_SERVICE_USER%"
if "%IO_USER%"=="" set "IO_USER=io"
set "ROOT=%~dp0..\.."
if exist "%ROOT%\.env" icacls "%ROOT%\.env" /inheritance:r /grant:r "%IO_USER%:(R,W)" >nul 2>&1
if not "%DATA_DIR%"=="" icacls "%DATA_DIR%" /inheritance:r /grant:r "%IO_USER%:(OI)(CI)F" >nul 2>&1
if exist "%ROOT%\data" icacls "%ROOT%\data" /inheritance:r /grant:r "%IO_USER%:(OI)(CI)F" >nul 2>&1
exit /b 0
