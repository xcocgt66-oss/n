"""Package only known release files; never include configured host secrets."""
from pathlib import Path
import hashlib
import importlib.metadata
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
executable = root / '.host-build' / 'dist' / 'S-Power-Host.exe'
destination = root / 'downloads' / 'S-Power-Host.zip'
files = ['agent.py', 'bridge.py', 'windows_job.py', 'Setup.ps1', 'Setup.cmd',
         'Start-Host.cmd', 'versions.json', 'requirements.txt', 'README.txt', 'THIRD-PARTY.txt']
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.write(executable, 'S-Power-Host.exe')
    for name in files:
        archive.write(root / 'agent' / name, name)
    archive.write(root / 'REMOTE-AR.md', 'REMOTE-AR.md')
    for distribution in importlib.metadata.distributions():
        for file in distribution.files or []:
            if file.name.lower().startswith(('license', 'copying', 'notice')):
                source = Path(distribution.locate_file(file))
                if source.is_file():
                    archive.write(source, 'licenses/' + distribution.metadata['Name'] + '/' + str(file).replace('\\', '/'))
    for relative in ['LICENSE.txt', 'tcl/tcl8.6/license.terms', 'tcl/tk8.6/license.terms']:
        source = Path(sys.base_prefix) / relative
        if source.exists():
            archive.write(source, 'licenses/python/' + relative)
digest = hashlib.sha256(destination.read_bytes()).hexdigest()
destination.with_suffix('.zip.sha256').write_text(digest + '  S-Power-Host.zip\n', encoding='ascii')
print(f'Packaged {destination.name}: {destination.stat().st_size:,} bytes; SHA256 {digest}')
