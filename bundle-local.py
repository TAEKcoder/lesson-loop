"""Build a private, self-contained player without changing deployable sources."""
from pathlib import Path
import base64
import re

root = Path(__file__).parent
source = root / 'next' if (root / 'next/index.html').exists() else root / 'dist'
html = (source / 'index.html').read_text()
css = re.sub(r"@import url\([^;]+;", '', (source / 'styles.css').read_text(), count=1)


def inline_module(name):
    """Flatten this app's local declaration modules into one module scope."""
    path = source / name
    if not path.exists():
        return ''
    code = path.read_text()
    code = re.sub(r'^import\b[\s\S]*?;\s*\n', '', code, flags=re.M)
    code = re.sub(r'^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)', '', code, flags=re.M)
    code = re.sub(r'^export default [A-Za-z_$][\w$]*;\s*$', '', code, flags=re.M)
    if re.search(r'^\s*(?:import|export)\s', code, flags=re.M):
        raise ValueError(f'Unhandled module declaration in {path.name}')
    return code


worklet_bootstrap = ''
output_stage = inline_module('output-stage.js')
if output_stage:
    # The worklet remains a distinct module and receives the exact original UTF-8
    # bytes, including its exports and processor registration. Only the window
    # copy's relative URL is replaced; file:// cannot resolve sibling modules.
    encoded_worklet = base64.b64encode((source / 'output-stage.js').read_bytes()).decode('ascii')
    worklet_bootstrap = '''
const BUNDLED_OUTPUT_WORKLET_BASE64 = "''' + encoded_worklet + '''";
const BUNDLED_OUTPUT_WORKLET_URL = URL.createObjectURL(new Blob([
  Uint8Array.from(atob(BUNDLED_OUTPUT_WORKLET_BASE64), byte => byte.charCodeAt(0))
], { type: 'text/javascript' }));
window.addEventListener('pagehide', event => {
  if (!event.persisted) URL.revokeObjectURL(BUNDLED_OUTPUT_WORKLET_URL);
});
'''
    output_stage, count = re.subn(
        r"new URL\(['\"]\./output-stage\.js['\"],\s*import\.meta\.url\)\.href",
        'BUNDLED_OUTPUT_WORKLET_URL', output_stage,
    )
    if count != 1:
        raise ValueError('Expected exactly one output-stage AudioWorklet module URL')

modules = [
    worklet_bootstrap,
    inline_module('audio-source.js'),
    output_stage,
    inline_module('native-output.js'),
    inline_module('audio-engine.js'),
    inline_module('storage.js'),
    inline_module('library-model.js'),
    'const { effectivePlaybackRange, nextWarmup } = (() => {\n' + inline_module('playback-plan.js') + '\nreturn { effectivePlaybackRange, nextWarmup }; })();',
    'const { analyzeSilence } = (() => {\n' + inline_module('silence-analysis.js') + '\nreturn { analyzeSilence }; })();',
    'const { WarmupQueue } = (() => {\n' + inline_module('warmup-controller.js') + '\nreturn { WarmupQueue }; })();',
]
app = inline_module('app.js')
restore_seed = '''else {
      const bundled=JSON.parse(document.getElementById('bundled-backup').textContent);
      library=bundled.library;
      const entries=bundled.audio.map(item=>{const raw=atob(item.data.split(',')[1]);return {id:item.id,blob:new Blob([Uint8Array.from(raw,ch=>ch.charCodeAt(0))],{type:item.type||'audio/mpeg'})};});
      await restoreLibrary(library,entries);
    }'''
if app.count('else await saveLibrary(library);') != 1:
    raise ValueError('Expected exactly one initial library save for bundled audio restoration')
modules.append(app.replace('else await saveLibrary(library);', restore_seed, 1))
script = '\n'.join(modules).replace('</script', '<\\/script')
backup = (root / '11월-수업-음원포함.lessonloop').read_text()
icon = base64.b64encode((source / 'icon.svg').read_bytes()).decode('ascii')
html, asset_count = re.subn(
    r'<link rel="icon" href="icon\.svg" type="image/svg\+xml"><link rel="stylesheet" href="styles\.css">',
    lambda _: '<link rel="icon" href="data:image/svg+xml;base64,' + icon + '"><style>' + css + '</style>',
    html,
)
if asset_count != 1:
    raise ValueError('Expected exactly one local icon and stylesheet pair')
html, script_count = re.subn(
    r'<script type="module" src="app\.js(?:\?[^\"]*)?"></script>',
    lambda _: '<script type="application/json" id="bundled-backup">' + backup.replace('</', '<\\/') + '</script><script type="module">' + script + '</script>',
    html,
)
if script_count != 1:
    raise ValueError('Expected exactly one app module entry point')
html = re.sub(r'<script[^>]+src=[\"\'](?:\./|/)?release-manager\.js[^>]*></script>', '', html)
html = html.replace('</body>', '<script>const b=document.getElementById("apply-update");if(b)b.onclick=()=>{document.getElementById("update-status").textContent="로컬 파일은 새 파일을 열어 업데이트하세요.";};</script></body>')
output = root / 'Lesson Loop.html'
output.write_text(html)
print(f'{output} ({output.stat().st_size:,} bytes)')
