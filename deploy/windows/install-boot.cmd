@echo off
setlocal
net session >nul 2>&1
if errorlevel 1 (
  echo Right-click this file and choose Run as administrator.
  exit /b 1
)
set "ROOT=%~dp0..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
schtasks /Create /F /TN "I/O" /SC ONSTART /RL HIGHEST /TR "\"%ROOT%\deploy\windows\start-io.cmd\""
if errorlevel 1 exit /b 1
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
echo I/O starts when Windows starts. This computer stays awake while it is plugged in.
echo Close any scripts\start-shop.cmd window so only one copy is running.
schtasks /Run /TN "I/O"
exit /b 0
