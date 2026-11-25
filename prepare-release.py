from pathlib import Path
import shutil
ROOT=Path(__file__).resolve().parent
VERSION='1.5.0'
source=ROOT/'next'
target=ROOT/'dist'/'releases'/VERSION
target.mkdir(parents=True,exist_ok=True)
for path in source.iterdir():
    if path.is_file():
        shutil.copy2(path,target/path.name)
print(f'Prepared {VERSION}: {target}')
