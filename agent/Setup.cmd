@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup.ps1"
if errorlevel 1 goto failed
echo Setup finished.
pause
exit /b 0
:failed
echo Setup failed. Keep this window open and read the error above.
pause
exit /b 1
