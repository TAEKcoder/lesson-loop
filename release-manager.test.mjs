import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./dist/release-manager.js', import.meta.url), 'utf8');
const pinKey = 'lessonloop.activeRelease';
const newest = {
  version: '1.4.0',
  url: '/releases/1.4.0/index.html',
  summary: '수동으로 적용하는 새 수업 화면',
};
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function scenario({ path = '/', current = 'legacy', pin = null,
  release = newest, prepare = null } = {}) {
  const events = [];
  const fetches = [];
  const storage = new Map(pin ? [[pinKey, pin]] : []);
  const status = { dataset: {}, textContent: '' };
  const summary = { textContent: '' };
  const button = {
    disabled: false,
    addEventListener(type, listener) {
      assert.equal(type, 'click');
      this.click = listener;
    },
  };
  const window = prepare ? {
    lessonLoopPrepareUpdate: () => {
      events.push(['prepare']);
      return prepare();
    },
  } : {};
  const sandbox = {
    URL,
    document: {
      documentElement: { dataset: { release: current } },
      getElementById(id) {
        return { 'apply-update': button, 'update-status': status, 'update-summary': summary }[id] || null;
      },
    },
    location: {
      origin: 'https://lesson.test',
      pathname: path,
      replace: url => events.push(['replace', url]),
      assign: url => events.push(['assign', url]),
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) {
        storage.set(key, value);
        events.push(['pin', value]);
      },
    },
    window,
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return { ok: true, json: async () => release };
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'release-manager.js' });
  return { events, storage, status, summary, button, fetches };
}

test('discovering a newer release never pins it or navigates without a click', async () => {
  const s = scenario();
  await flush();
  assert.deepEqual(s.events, []);
  assert.equal(s.storage.size, 0);
  assert.equal(s.fetches.length, 1);
  assert.equal(s.fetches[0].url, '/release.json');
  assert.equal(s.fetches[0].options.cache, 'no-store');
  assert.equal(s.status.dataset.state, 'available');
  assert.equal(s.summary.textContent, newest.summary);
  assert.equal(s.button.disabled, false);
});

test('only an explicit click waits for transport preparation before pinning and navigating', async () => {
  const prepared = deferred();
  const s = scenario({ prepare: () => prepared.promise });
  await flush();
  const applying = s.button.click();
  await flush();
  assert.deepEqual(s.events, [['prepare']]);
  assert.equal(s.storage.size, 0);
  assert.equal(s.button.disabled, true);
  prepared.resolve(true);
  await applying;
  assert.deepEqual(s.events, [
    ['prepare'], ['pin', newest.url], ['assign', newest.url],
  ]);
  assert.equal(s.storage.get(pinKey), newest.url);

  // The transport hook is optional on the standalone update page.
  const page = scenario({ path: '/update.html' });
  await flush();
  await page.button.click();
  assert.deepEqual(page.events, [['pin', newest.url], ['assign', newest.url]]);
});

test('the current release reports its status without reloading or preparing transport', async () => {
  const s = scenario({ path: newest.url, current: newest.version, prepare: () => true });
  await flush();
  await s.button.click();
  assert.deepEqual(s.events, []);
  assert.equal(s.storage.size, 0);
  assert.equal(s.status.textContent, '최신 버전입니다.');
  assert.equal(s.button.disabled, false);
});

test('root reuses a valid previous pin but the update page never follows it automatically', async () => {
  const previous = '/releases/1.3.0/index.html';
  for (const path of ['/', '/index.html']) {
    const root = scenario({ path, pin: previous });
    assert.deepEqual(root.events, [['replace', previous]]);
    assert.equal(root.fetches.length, 0);
    assert.equal(root.storage.get(pinKey), previous);
  }
  const updatePage = scenario({ path: '/update.html', pin: previous });
  await flush();
  assert.deepEqual(updatePage.events, []);
  assert.equal(updatePage.fetches.length, 1);
  assert.equal(updatePage.storage.get(pinKey), previous);

  const invalidPin = scenario({ pin: 'https://outside.test/releases/1.3.0/index.html' });
  await flush();
  assert.deepEqual(invalidPin.events, []);
});

test('a foreign release URL is rejected before transport changes, pin writes or navigation', async () => {
  const s = scenario({
    release: { ...newest, url: 'https://outside.test/releases/1.4.0/index.html' },
    prepare: () => true,
  });
  await flush();
  await s.button.click();
  assert.deepEqual(s.events, []);
  assert.equal(s.storage.size, 0);
  assert.equal(s.status.dataset.state, 'error');
  assert.equal(s.button.disabled, false);
});

test('transport cancellation leaves the chosen release and current page unchanged', async () => {
  const previous = '/releases/1.3.0/index.html';
  const s = scenario({ path: previous, current: '1.3.0', pin: previous, prepare: () => false });
  await flush();
  await s.button.click();
  assert.deepEqual(s.events, [['prepare']]);
  assert.equal(s.storage.get(pinKey), previous);
  assert.equal(s.status.textContent, '업데이트 적용을 취소했습니다.');
  assert.equal(s.button.disabled, false);
});
