import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const managerFile = new URL('./github-pages/release-manager.js', import.meta.url);
const scriptUrl = 'https://site.test/lesson-loop/release-manager.js';
const basePath = '/lesson-loop/';
const pinKey = `lessonloop.activeRelease:${basePath}`;
const initialVersion = '1.5.0';
const initialPath = `${basePath}releases/${initialVersion}/index.html`;
const previousPath = `${basePath}releases/1.4.3/index.html`;
const newest = { version: '1.6.0', url: 'releases/1.6.0/index.html', summary: '직접 적용하는 다음 버전' };
const newestPath = `${basePath}releases/${newest.version}/index.html`;
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function scenario({ path = previousPath, current = '1.4.3', pin = null,
  release = newest, prepare = null, bootstrap = false, initialRelease = initialVersion,
  managerUrl = scriptUrl, entries = [] } = {}) {
  const manager = new URL(managerUrl), base = new URL('./', manager);
  const key = `lessonloop.activeRelease:${base.pathname}`;
  const events = [], fetches = [];
  const storage = new Map(entries);
  if (pin !== null) storage.set(key, pin);
  const status = { dataset: {}, textContent: '' }, summary = { textContent: '' };
  const button = {
    disabled: false,
    addEventListener(type, listener) {
      assert.equal(type, 'click');
      this.click = listener;
    },
  };
  const dataset = { release: current };
  if (bootstrap) { dataset.releaseBootstrap = 'true'; dataset.initialRelease = initialRelease; }
  const sandbox = {
    URL,
    document: {
      documentElement: { dataset },
      getElementById(id) {
        return { 'apply-update': button, 'update-status': status, 'update-summary': summary }[id] || null;
      },
    },
    location: {
      origin: manager.origin,
      pathname: path,
      href: new URL(path, manager.origin).href,
      replace: url => events.push(['replace', url]),
      assign: url => events.push(['assign', url]),
    },
    localStorage: {
      getItem: name => storage.get(name) ?? null,
      setItem(name, value) { storage.set(name, value); events.push(['pin', name, value]); },
    },
    window: prepare ? { lessonLoopPrepareUpdate: () => { events.push(['prepare']); return prepare(); } } : {},
    fetch: async (url, options) => {
      fetches.push({ url: String(url), options });
      return { ok: true, json: async () => release };
    },
  };
  const source = fs.readFileSync(managerFile, 'utf8').replace(/\bimport\.meta\.url\b/g, JSON.stringify(managerUrl));
  new vm.Script(source, { filename: 'github-pages/release-manager.js' }).runInNewContext(sandbox);
  return { events, storage, status, summary, button, fetches, key };
}

test('a first project-root visit pins the bundled initial release, independently of the newest manifest', async () => {
  for (const path of [basePath, `${basePath}index.html`]) {
    const s = scenario({ path, current: 'bootstrap', bootstrap: true });
    await flush();
    assert.deepEqual(s.events, [['pin', pinKey, initialPath], ['replace', initialPath]]);
    assert.equal(s.storage.get(pinKey), initialPath);
    assert.equal(s.fetches.length, 0, 'bootstrap must not follow a newly announced release');
  }
});

test('the root reuses the previously chosen project release without changing its pin', async () => {
  const s = scenario({ path: basePath, current: 'bootstrap', bootstrap: true, pin: previousPath });
  await flush();
  assert.deepEqual(s.events, [['replace', previousPath]]);
  assert.equal(s.storage.get(pinKey), previousPath);
  assert.equal(s.fetches.length, 0);
});

test('a version page discovers a newer project release without writes, transport work, or navigation', async () => {
  const s = scenario({ prepare: () => true });
  await flush();
  assert.deepEqual(s.events, []);
  assert.equal(s.storage.size, 0);
  assert.equal(s.fetches.length, 1);
  assert.equal(new URL(s.fetches[0].url, scriptUrl).href, 'https://site.test/lesson-loop/release.json');
  assert.equal(s.fetches[0].options.cache, 'no-store');
  assert.equal(s.status.dataset.state, 'available');
  assert.equal(s.summary.textContent, newest.summary);
  assert.equal(s.button.disabled, false);
});

test('an explicit update click awaits the transport stop before pinning and navigating inside this project', async () => {
  const prepared = deferred();
  const s = scenario({ pin: previousPath, prepare: () => prepared.promise });
  await flush();
  const applying = s.button.click();
  await flush();
  assert.deepEqual(s.events, [['prepare']]);
  assert.equal(s.storage.get(pinKey), previousPath);
  assert.equal(s.button.disabled, true);
  prepared.resolve(true);
  await applying;
  assert.deepEqual(s.events, [['prepare'], ['pin', pinKey, newestPath], ['assign', newestPath]]);
  assert.equal(s.storage.get(pinKey), newestPath);
});

test('same-project absolute paths are valid release targets', async () => {
  const s = scenario({ release: { ...newest, url: newestPath } });
  await flush();
  await s.button.click();
  assert.deepEqual(s.events, [['pin', pinKey, newestPath], ['assign', newestPath]]);
});

test('external, cross-project, traversal, query, hash, and version-mismatched release paths are rejected', async t => {
  const invalid = [
    ['external URL', { ...newest, url: 'https://outside.test/lesson-loop/releases/1.6.0/index.html' }],
    ['external protocol-relative URL', { ...newest, url: '//outside.test/lesson-loop/releases/1.6.0/index.html' }],
    ['cross-project path', { ...newest, url: '/other-project/releases/1.6.0/index.html' }],
    ['origin-root release path', { ...newest, url: '/releases/1.6.0/index.html' }],
    ['normalized traversal', { ...newest, url: 'releases/../releases/1.6.0/index.html' }],
    ['encoded traversal', { ...newest, url: 'releases/%2e%2e/releases/1.6.0/index.html' }],
    ['query suffix', { ...newest, url: 'releases/1.6.0/index.html?auto=1' }],
    ['hash suffix', { ...newest, url: 'releases/1.6.0/index.html#apply' }],
    ['version mismatch', { ...newest, url: 'releases/1.5.0/index.html' }],
    ['invalid version', { ...newest, version: '../1.6.0' }],
  ];
  for (const [label, release] of invalid) await t.test(label, async () => {
    const s = scenario({ release, prepare: () => true });
    await flush();
    await s.button.click();
    assert.deepEqual(s.events, []);
    assert.equal(s.storage.size, 0);
    assert.equal(s.status.dataset.state, 'error');
    assert.equal(s.button.disabled, false);
  });
});

test('foreign project and legacy global pins do not choose a project release', async () => {
  const foreignPath = '/other-project/releases/9.0.0/index.html';
  const s = scenario({ path: basePath, current: 'bootstrap', bootstrap: true,
    pin: foreignPath, entries: [['lessonloop.activeRelease', foreignPath], ['lessonloop.activeRelease:/other-project/', foreignPath]] });
  await flush();
  assert.deepEqual(s.events, [['pin', pinKey, initialPath], ['replace', initialPath]]);
  assert.equal(s.storage.get(pinKey), initialPath);
  assert.equal(s.storage.get('lessonloop.activeRelease:/other-project/'), foreignPath);
});

test('invalid project pins fall back to the bundled initial release', async t => {
  const pins = [
    'https://outside.test/lesson-loop/releases/1.4.3/index.html',
    '/other-project/releases/1.4.3/index.html',
    '/lesson-loop/releases/../releases/1.4.3/index.html',
    '/lesson-loop/releases/%2e%2e/releases/1.4.3/index.html',
    `${previousPath}?auto=1`, `${previousPath}#apply`,
  ];
  for (const pin of pins) await t.test(pin, async () => {
    const s = scenario({ path: basePath, current: 'bootstrap', bootstrap: true, pin });
    await flush();
    assert.deepEqual(s.events, [['pin', pinKey, initialPath], ['replace', initialPath]]);
    assert.equal(s.storage.get(pinKey), initialPath);
  });
});

test('the standalone update page never automatically follows either a pin or a bootstrap marker', async () => {
  const s = scenario({ path: `${basePath}update.html`, current: 'update', pin: previousPath, bootstrap: true });
  await flush();
  assert.deepEqual(s.events, []);
  assert.equal(s.storage.get(pinKey), previousPath);
  assert.equal(s.fetches.length, 1);
  await s.button.click();
  assert.deepEqual(s.events, [['pin', pinKey, newestPath], ['assign', newestPath]]);
});

test('transport cancellation preserves the selected release and current page', async () => {
  const s = scenario({ pin: previousPath, prepare: () => false });
  await flush();
  await s.button.click();
  assert.deepEqual(s.events, [['prepare']]);
  assert.equal(s.storage.get(pinKey), previousPath);
  assert.equal(s.button.disabled, false);
  assert.equal(s.status.textContent, '업데이트 적용을 취소했습니다.');
});

test('an already current release never stops transport, pins, or reloads', async () => {
  const s = scenario({ path: newestPath, current: newest.version, prepare: () => true });
  await flush();
  await s.button.click();
  assert.deepEqual(s.events, []);
  assert.equal(s.storage.size, 0);
  assert.equal(s.status.dataset.state, 'current');
});

test('script location supplies the deployment base for both user pages and nested project pages', async () => {
  for (const path of ['/', '/teaching/lesson-loop/']) {
    const managerUrl = `https://site.test${path}release-manager.js`;
    const s = scenario({ path, current: 'bootstrap', bootstrap: true, managerUrl });
    await flush();
    const key = `lessonloop.activeRelease:${path}`, target = `${path}releases/${initialVersion}/index.html`;
    assert.deepEqual(s.events, [['pin', key, target], ['replace', target]]);
    assert.equal(s.storage.get(key), target);
  }
});
