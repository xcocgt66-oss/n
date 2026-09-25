@echo off
cd /d "%~dp0"
py -3 -c "import sys; assert sys.version_info >= (3,11)" >nul 2>&1
if errorlevel 1 goto missing
if not exist vendor\moonlight\web-server.exe goto setup
if not exist .venv\Scripts\python.exe py -3 -m venv .venv
if errorlevel 1 goto failed
.venv\Scripts\python.exe -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto failed
.venv\Scripts\python.exe agent.py
if errorlevel 1 goto failed
exit /b 0
:setup
echo Run Setup.cmd first.
pause
exit /b 1
:missing
echo Install Python 3.11 or newer with tkinter and the py launcher from https://www.python.org/downloads/windows/
pause
exit /b 1
:failed
echo Host setup or launch failed. Review the error above.
pause
exit /b 1
