"""Package release assets for a GitHub Pages project path, without private media."""
from pathlib import Path
import json
import re
import shutil

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'dist'
OUTPUT = ROOT / '_site'
VERSION = re.compile(r'^[a-zA-Z0-9._-]+$')
manifest = json.loads((SOURCE / 'release.json').read_text())
version = manifest['version']
if not VERSION.fullmatch(version) or version in {'.', '..'}:
    raise ValueError('Invalid release version')
if not (SOURCE / 'releases' / version / 'index.html').is_file():
    raise ValueError('The announced release is missing')

# This folder is generated only by this script and excluded from source control.
if OUTPUT.is_symlink():
    raise ValueError('The output folder must not be a symlink')
if OUTPUT.exists():
    if not (OUTPUT / '.lesson-loop-build').is_file():
        raise ValueError('Refusing to replace an unrecognized output folder')
    shutil.rmtree(OUTPUT)
OUTPUT.mkdir()
(OUTPUT / '.lesson-loop-build').write_text('Generated GitHub Pages assets\n')
(OUTPUT / '.nojekyll').touch()

for release in sorted((SOURCE / 'releases').iterdir()):
    if not release.is_dir() or not VERSION.fullmatch(release.name):
        raise ValueError('Unexpected release entry')
    for source in release.rglob('*'):
        if source.is_symlink():
            raise ValueError('Symlinks are not deployable assets')
        if not source.is_file():
            continue
        if source.suffix.lower() not in {'.html', '.js', '.css', '.svg', '.json'}:
            raise ValueError(f'Unexpected deployable asset: {source.name}')
        relative = source.relative_to(SOURCE)
        target = OUTPUT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        content = source.read_text()
        if source.name == 'index.html':
            content = content.replace('src="/release-manager.js"', 'src="../../release-manager.js"')
        if source.name == 'storage.js':
            original = "const DB_NAME = 'classroom-player-v1';"
            if content.count(original) != 1:
                raise ValueError('Unexpected storage module; review the Pages namespace')
            content = content.replace(original, "const DB_NAME = 'classroom-player-v1:' + new URL('../../', import.meta.url).pathname;")
        target.write_text(content)

shutil.copy2(ROOT / 'github-pages' / 'release-manager.js', OUTPUT / 'release-manager.js')
shutil.copy2(SOURCE / 'update.html', OUTPUT / 'update.html')
shutil.copy2(SOURCE / 'icon.svg', OUTPUT / 'icon.svg')
manifest['url'] = f'releases/{version}/index.html'
(OUTPUT / 'release.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

# A new visitor starts on this build's release and pins it immediately.
# Returning visitors retain their own pin until they click the update button.
(OUTPUT / 'index.html').write_text(f'''<!doctype html>
<html lang="ko" data-release="bootstrap" data-initial-release="{version}">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#151b17"><link rel="icon" href="./icon.svg">
<title>Lesson Loop · 수업용 음악 플레이어</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#151b17;color:#edf5e8;font:17px system-ui;line-height:1.7}}main{{max-width:520px;padding:30px}}button{{font:inherit;padding:12px 20px;background:#cbef9d;color:#172810;border:0;border-radius:7px;cursor:pointer}}a{{color:#cbef9d}}</style>
<main><h1>Lesson Loop</h1><p id="update-status" role="status">플레이어를 준비하고 있습니다.</p><p id="update-summary"></p><button id="apply-update" type="button">플레이어 열기</button><noscript><p>플레이어를 사용하려면 JavaScript를 켜 주세요.</p></noscript></main>
<script type="module" src="./release-manager.js"></script></html>''')
print(f'GitHub Pages release {version} packaged in {OUTPUT}')
