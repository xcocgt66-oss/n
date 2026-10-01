$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path '.host-build-env\Scripts\python.exe')) {
    py -3 -m venv .host-build-env
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.11+ with Tkinter is required to build.' }
}
$buildPython = Join-Path (Get-Location) '.host-build-env\Scripts\python.exe'
& $buildPython -m pip install --disable-pip-version-check -r agent/build-requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Build dependency installation failed.' }
& $buildPython -m PyInstaller --noconfirm --clean --onefile --windowed --name S-Power-Host --distpath .host-build/dist --workpath .host-build/work --specpath .host-build agent/agent.py
if ($LASTEXITCODE -ne 0) { throw 'Executable build failed.' }
$check = Start-Process -FilePath '.host-build\dist\S-Power-Host.exe' -ArgumentList '--self-test' -WindowStyle Hidden -PassThru
if (-not $check.WaitForExit(30000)) { Stop-Process -Id $check.Id; throw 'Executable self-test timed out.' }
if ($check.ExitCode -ne 0) { throw 'Executable self-test failed.' }
& $buildPython scripts/package-host.py
if ($LASTEXITCODE -ne 0) { throw 'Host packaging failed.' }
