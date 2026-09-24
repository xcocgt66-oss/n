@echo off
cd /d "%~dp0"
py -3 --version >nul 2>&1
if errorlevel 1 goto missing
if not exist .venv\Scripts\python.exe py -3 -m venv .venv
if errorlevel 1 goto failed
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto failed
.venv\Scripts\python.exe agent.py
if errorlevel 1 goto failed
exit /b 0
:missing
echo Install Python 3.11 or newer from https://www.python.org/downloads/windows/
pause
exit /b 1
:failed
echo Host setup or launch failed. Review the error above.
pause
exit /b 1
