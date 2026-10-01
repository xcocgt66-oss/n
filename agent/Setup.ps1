$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-Location $PSScriptRoot
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$osBuild = [Environment]::OSVersion.Version.Build
$hostArch = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')
if (-not $hostArch) { $hostArch = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') }
if ($hostArch -ne 'AMD64' -or $osBuild -lt 19045) { throw 'Requires Windows 10 22H2 or Windows 11, x64.' }
$manifest = Get-Content 'versions.json' -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force 'vendor','installer-cache' | Out-Null
function Get-Verified($item, $destination) {
    if (-not (Test-Path $destination) -or (Get-FileHash $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) {
        Invoke-WebRequest -UseBasicParsing -Uri $item.url -OutFile $destination
    }
    if ((Get-FileHash $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) { throw 'Download checksum mismatch. Nothing was executed.' }
}
$moonlightExe = Join-Path $PSScriptRoot 'vendor\moonlight\web-server.exe'
if (-not (Test-Path $moonlightExe)) {
    Write-Host 'Downloading verified Moonlight Web 2.10.0...'
    Get-Verified $manifest.moonlight 'installer-cache\moonlight.zip'
    $unpackDir = Join-Path $PSScriptRoot ('installer-cache\unpack-' + [Guid]::NewGuid().ToString('N'))
    Expand-Archive 'installer-cache\moonlight.zip' $unpackDir
    $found = @(Get-ChildItem $unpackDir -Recurse -Filter 'web-server.exe')
    if ($found.Count -ne 1) { throw 'Unexpected Moonlight archive layout.' }
    New-Item -ItemType Directory -Force 'vendor\moonlight' | Out-Null
    Copy-Item (Join-Path $found[0].Directory.FullName '*') 'vendor\moonlight' -Recurse -Force
    $resolvedUnpack = [IO.Path]::GetFullPath($unpackDir)
    $cacheRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'installer-cache')) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedUnpack.StartsWith($cacheRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected extraction directory.' }
    Remove-Item -LiteralPath $resolvedUnpack -Recurse -Force
}
$service = Get-Service -Name 'SunshineService' -ErrorAction SilentlyContinue
$existing = Test-Path (Join-Path $env:ProgramFiles 'Sunshine\sunshine.exe')
if ($service -or $existing) {
    Write-Host 'Existing Sunshine installation retained. Check its service and settings before connecting.'
} else {
    if ($osBuild -ge 22000) {
        $sunshine = $manifest.sunshine11
        $installerPath = Join-Path $PSScriptRoot 'installer-cache\Sunshine.msi'
    } else {
        $sunshine = $manifest.sunshine10
        $installerPath = Join-Path $PSScriptRoot 'installer-cache\Sunshine.exe'
        Write-Host 'Windows 10 uses a pinned legacy Sunshine build. It is not current upstream Windows support.'
    }
    Write-Host ('Downloading Sunshine ' + $sunshine.version + '...')
    Get-Verified $sunshine $installerPath
    Write-Host 'Complete the official installer and enable the Sunshine service. Approve its Windows UAC prompt.'
    if ($installerPath.EndsWith('.msi')) {
        $installed = Start-Process 'msiexec.exe' -ArgumentList @('/i', ('"' + $installerPath + '"')) -Wait -PassThru
    } else {
        $installed = Start-Process $installerPath -Wait -PassThru
    }
    if ($installed.ExitCode -notin @(0,3010,1641)) { throw ('Installer exited with code ' + $installed.ExitCode) }
}
Write-Host 'Setup complete. Read README.txt, then open Start-Host.cmd.'
Write-Host 'Keep UAC enabled. Set Sunshine encoder to Auto. No paid virtual input driver is required for basic desktop input.'
