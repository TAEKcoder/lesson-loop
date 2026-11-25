import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, formatTime, inspectAudio } from './dist/storage.js';

test('parses minute and hour timestamps, fractional seconds, and integer seconds', () => {
  assert.equal(parseTime('01:23'), 83);
  assert.equal(parseTime('1:23.125'), 83.125);
  assert.equal(parseTime('1:02:03.4'), 3723.4);
  assert.equal(parseTime('120:59'), 7259);
  assert.equal(parseTime(' 83 '), 83);
  assert.equal(parseTime('0:00'), 0);
});

test('rejects invalid or ambiguous timestamps instead of silently normalizing', () => {
  for (const input of ['', ' ', '-1', 'NaN', '1:60', '1:99', '1:60:00', '1::2', '1:2:3:4', '1:23abc', '1.5', '1:00.1234', Infinity, -1]) {
    assert.equal(parseTime(input), null, String(input));
  }
});

test('formats fractional rounding with carry and invalid media duration safely', () => {
  assert.equal(formatTime(83.987), '01:23');
  assert.equal(formatTime(59.999, true), '01:00.00');
  assert.equal(formatTime(3723.4, true), '62:03.40');
  assert.equal(formatTime(NaN), '00:00');
  assert.equal(formatTime(Infinity), '00:00');
  assert.equal(formatTime(-2), '00:00');
});

function namedBlob(buffer, name) {
  const blob = new Blob([buffer]);
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

test('reads 96kHz / 24-bit stereo WAV metadata from the original fmt chunk', async () => {
  const b = new ArrayBuffer(60);
  const view = new DataView(b);
  const u = new Uint8Array(b);
  const text = (offset, value) => u.set(new TextEncoder().encode(value), offset);
  text(0, 'RIFF'); text(8, 'WAVE');
  text(12, 'JUNK'); view.setUint32(16, 3, true); // Chunk padding is required.
  text(24, 'fmt '); view.setUint32(28, 16, true);
  view.setUint16(32, 1, true); view.setUint16(34, 2, true);
  view.setUint32(36, 96000, true); view.setUint16(46, 24, true);
  assert.deepEqual(await inspectAudio(namedBlob(b, 'song.wav')), { format: 'WAV', sampleRate: 96000, bitDepth: 24, channels: 2 });
});

test('reads packed FLAC STREAMINFO source metadata', async () => {
  const b = new Uint8Array(42);
  b.set(new TextEncoder().encode('fLaC'));
  b[4] = 0x80; b[7] = 34;
  const rate = 192000, channels = 2, depth = 24;
  b[18] = rate >> 12;
  b[19] = (rate >> 4) & 255;
  b[20] = ((rate & 15) << 4) | ((channels - 1) << 1) | ((depth - 1) >> 4);
  b[21] = ((depth - 1) & 15) << 4;
  assert.deepEqual(await inspectAudio(namedBlob(b, 'song.flac')), { format: 'FLAC', sampleRate: 192000, bitDepth: 24, channels: 2 });
});

test('truncated and compressed files do not invent a sample rate or bit depth', async () => {
  assert.deepEqual(await inspectAudio(namedBlob(new Uint8Array([1, 2]), 'song.m4a')), { format: 'M4A' });
  assert.deepEqual(await inspectAudio(namedBlob(new TextEncoder().encode('RIFF1234WAVEfmt '), 'song.wav')), { format: 'WAV' });
});

test('atomic restore waits for commit, retains unrelated audio, and rolls back a quota failure', async t => {
  const originalIndexedDB = globalThis.indexedDB;
  t.after(() => { globalThis.indexedDB = originalIndexedDB; });
  const oldBlob = new Blob(['old audio']);
  let saved = { library: new Map([['main', { version: 1, name: 'old' }]]), audio: new Map([['song', oldBlob], ['retained', oldBlob]]) };
  let active;
  const db = {
    transaction(names, mode) {
      assert.deepEqual(names, ['library', 'audio']);
      assert.equal(mode, 'readwrite');
      const staged = { library: new Map(saved.library), audio: new Map(saved.audio) };
      const tx = {
        objectStore(name) { return { put(value, key) { staged[name].set(key, value); } }; },
        abort() { queueMicrotask(() => tx.onabort?.()); },
        commitForTest() { saved = staged; tx.oncomplete?.(); },
        failForTest() { tx.error = new DOMException('Full', 'QuotaExceededError'); tx.onabort?.(); }
      };
      active = tx;
      return tx;
    },
    close() {}
  };
  globalThis.indexedDB = {
    open() {
      const request = { result: db };
      queueMicrotask(() => request.onsuccess());
      return request;
    }
  };
  const { restoreLibrary } = await import('./dist/storage.js?atomic-restore-test');
  const newBlob = new Blob(['replacement audio']);
  let settled = false;
  const success = restoreLibrary({ version: 1, name: 'new' }, [{ id: 'song', blob: newBlob }]).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'writes must not report success before transaction commit');
  assert.equal(saved.audio.get('song'), oldBlob);
  active.commitForTest();
  await success;
  assert.deepEqual(saved.library.get('main'), { version: 1, name: 'new' });
  assert.equal(saved.audio.get('song'), newBlob);
  assert.equal(saved.audio.get('retained'), oldBlob, 'settings-only and unrelated audio must remain available');

  const failed = restoreLibrary({ version: 1, name: 'broken' }, [{ id: 'song', blob: oldBlob }]);
  const rejected = assert.rejects(failed, /저장 공간이 부족/);
  await new Promise(resolve => setImmediate(resolve));
  active.failForTest();
  await rejected;
  assert.deepEqual(saved.library.get('main'), { version: 1, name: 'new' });
  assert.equal(saved.audio.get('song'), newBlob, 'a failed restore must preserve the previous original');
});
