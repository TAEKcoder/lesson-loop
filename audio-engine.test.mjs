import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from './next/audio-engine.js';

class FakeAudio extends EventTarget {
  paused = true;
  ended = false;
  duration = 180;
  _currentTime = 0;
  playPositions = [];
  readyState = 4;
  autoMetadata = false;
  loadCalls = 0;
  sourceCleared = false;
  seeking = false;
  asyncSeek = false;
  get currentTime() { return this._currentTime; }
  set currentTime(value) { this._currentTime = value; if (this.asyncSeek) this.seeking = true; }
  finishSeek() { this.seeking = false; this.dispatchEvent(new Event('seeked')); }
  playbackRate = 1;
  defaultPlaybackRate = 1;
  error = null;
  pendingPlay = null;
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  play() { this.playPositions.push(this.currentTime); this.paused = false; this.ended = false; return this.pendingPlay || Promise.resolve(); }
  load() { this.playbackRate = this.defaultPlaybackRate; this.loadCalls++; if (this.autoMetadata && this.src) queueMicrotask(() => this.metadata()); }
  removeAttribute(name) { if (name === 'src') { this.sourceCleared = true; this.src = ''; } }
  metadata() { this.readyState = this.metadataReadyState ?? 4; this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('canplay')); }
}

function setup(options = {}) {
  const audio = new FakeAudio();
  const elements = [audio];
  const playPositions = audio.playPositions;
  const sources = [];
  const jobs = new Map();
  let id = 0;
  const calls = [];
  const gain = {
    value: 0,
    cancelScheduledValues: time => calls.push(['cancel', time]),
    setValueAtTime: (value, time) => { gain.value = value; calls.push(['set', value, time]); },
    linearRampToValueAtTime: (value, time) => calls.push(['ramp', value, time]),
  };
  const context = {
    currentTime: 0, state: 'running', destination: {},
    createMediaElementSource: audio => { const source = { audio, connected: false, disconnected: false, connect() { this.connected = true; }, disconnect() { this.connected = false; this.disconnected = true; } }; sources.push(source); return source; },
    createGain: () => ({ gain, connect() {}, disconnect() {} }),
    close: () => Promise.resolve(), resume: () => { context.resumeCalls = (context.resumeCalls || 0) + 1; context.state = 'running'; return Promise.resolve(); },
  };
  let urls = 0;
  const revoked = [];
  const createdBlobs = [];
  const engine = new AudioEngine({ audio, prepareAudio: options.prepareAudio || (blob => ({ blob, mode: 'native', precise: true })), audioFactory: () => { const next = new FakeAudio(); next.readyState = 0; next.autoMetadata = options.autoMetadata !== false; next.metadataReadyState = options.replacementReadyState ?? 4; next.asyncSeek = engine.audio.asyncSeek; next.playPositions = playPositions; elements.push(next); return next; }, contextFactory: () => context,
    requestAnimationFrame: () => ++id, cancelAnimationFrame() {},
    setTimeout: (fn, ms) => { jobs.set(++id, { fn, ms }); return id; },
    clearTimeout: timer => jobs.delete(timer),
    urls: { createObjectURL: blob => { createdBlobs.push(blob); return `blob:${++urls}`; }, revokeObjectURL: url => revoked.push(url) },
  });
  const loaded = async () => { const promise = engine.load(new Blob(['audio'])); engine.audio.metadata(); await promise; };
  const run = ms => {
    const due = [...jobs.entries()].filter(([, job]) => job.ms <= ms);
    for (const [key, job] of due) { if (jobs.has(key)) { jobs.delete(key); job.fn(); } }
  };
  return { engine, get audio() { return engine.audio; }, context, gain, calls, jobs, loaded, run, revoked, elements, sources, playPositions, createdBlobs };
}

test('play fades from silence and pause waits for fade before pausing', async () => {
  const s = setup();
  await s.loaded();
  assert.equal(s.engine.state, 'ready');
  assert.equal(await s.engine.play(), true);
  assert.equal(s.engine.isPlaying, true);
  assert.deepEqual(s.calls.at(-1), ['ramp', 0.85, 1]);
  s.context.currentTime = 1;
  const paused = s.engine.pause();
  assert.equal(s.audio.paused, false);
  assert.equal(s.engine.state, 'pausing');
  assert.deepEqual(s.calls.at(-1), ['ramp', 0, 2]);
  s.context.currentTime = 2;
  s.run(1000);
  assert.equal(await paused, true);
  assert.equal(s.audio.paused, true);
  assert.equal(s.engine.state, 'paused');
});

test('play during fade-out cancels pending pause and continues from current gain', async () => {
  const s = setup();
  await s.loaded();
  await s.engine.play();
  s.context.currentTime = 1;
  const paused = s.engine.pause();
  s.context.currentTime = 1.5;
  assert.equal(await s.engine.play(), true);
  assert.equal(await paused, false);
  assert.ok(s.calls.some(call => call[0] === 'set' && Math.abs(call[1] - 0.425) < 1e-9));
  s.context.currentTime = 3;
  s.run(2000);
  assert.equal(s.audio.paused, false);
  assert.equal(s.engine.state, 'playing');
});

test('pending seek keeps media paused so playback cannot consume the selected beginning', async () => {
  const s = setup();
  await s.loaded();
  s.audio.seeking = true;
  const started = s.engine.play();
  await Promise.resolve();
  assert.equal(s.audio.paused, true);
  assert.equal(s.engine.state, 'starting');
  assert.equal(s.calls.some(call => call[0] === 'ramp' && call[1] > 0), false);
  s.audio.seeking = false;
  s.audio.dispatchEvent(new Event('seeked'));
  assert.equal(await started, true);
  assert.equal(s.engine.state, 'playing');
  assert.deepEqual(s.calls.at(-1), ['ramp', 0.85, 1]);
});

test('pause cancels a pending seek startup and prevents its later fade-in', async () => {
  const s = setup();
  await s.loaded();
  s.audio.seeking = true;
  const started = s.engine.play();
  s.engine.setFade(0);
  assert.equal(await s.engine.pause(), true);
  assert.equal(await started, false);
  s.audio.seeking = false;
  s.audio.dispatchEvent(new Event('seeked'));
  assert.equal(s.engine.state, 'paused');
  assert.equal(s.calls.some(call => call[0] === 'ramp' && call[1] > 0), false);
});

test('an interrupted Safari context is resumed during the user play call', async () => {
  const s = setup();
  await s.loaded();
  s.context.state = 'interrupted';
  const started = s.engine.play();
  assert.equal(s.context.resumeCalls, 1);
  assert.equal(s.audio.paused, true);
  assert.equal(await started, true);
});

test('a stale play rejection cannot stop a newer playback request', async () => {
  const s = setup();
  await s.loaded();
  let rejectOld;
  s.audio.pendingPlay = new Promise((_, reject) => { rejectOld = reject; });
  const oldPlay = s.engine.play();
  const pause = s.engine.pause();
  s.audio.pendingPlay = null;
  assert.equal(await s.engine.play(), true);
  assert.equal(await pause, false);
  rejectOld(new DOMException('Interrupted', 'AbortError'));
  assert.equal(await oldPlay, false);
  assert.equal(s.engine.state, 'playing');
  assert.equal(s.engine.isPlaying, true);
});

test('superseded loading releases its URL and rejects only its own promise', async () => {
  const s = setup();
  const first = s.engine.load(new Blob(['first']));
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = s.engine.load(new Blob(['second']));
  s.audio.metadata();
  await second;
  await rejected;
  assert.deepEqual(s.revoked, ['blob:1']);
  assert.equal(s.engine.state, 'ready');
});

test('queued pause and ended events do not interrupt newer active playback', async () => {
  const s = setup();
  await s.loaded();
  await s.engine.play();
  s.audio.dispatchEvent(new Event('pause'));
  s.audio.dispatchEvent(new Event('ended'));
  assert.equal(s.engine.state, 'playing');
  assert.equal(s.engine.isPlaying, true);
  s.audio.paused = true;
  s.audio.dispatchEvent(new Event('pause'));
  assert.equal(s.engine.state, 'paused');
});

test('looping rejects invalid ranges and preserves overshoot without repeated seeks', async () => {
  const s = setup();
  await s.loaded();
  assert.equal(s.engine.setLoop(20, 10, true), false);
  assert.equal(s.engine.loop.enabled, false);
  assert.equal(s.engine.setLoop(5, 10, true), true);
  assert.equal(s.engine.setRate(0.8), true);
  await s.engine.play();
  assert.equal(s.audio.currentTime, 5);
  assert.equal(s.audio.preservesPitch, true);
  assert.equal(s.audio.playbackRate, 0.8);
  let loops = 0;
  s.engine.on('loop', () => loops++);
  s.audio.currentTime = 10.04;
  s.audio.dispatchEvent(new Event('timeupdate'));
  assert.ok(Math.abs(s.audio.currentTime - 5.04) < 1e-9);
  s.audio.currentTime = 10.05;
  s.audio.dispatchEvent(new Event('timeupdate'));
  assert.equal(loops, 1);
  s.audio.currentTime = 5.04;
  s.audio.dispatchEvent(new Event('seeked'));
  s.audio.currentTime = 10.02;
  s.audio.dispatchEvent(new Event('timeupdate'));
  assert.equal(loops, 2);
});

test('natural track end loops when enabled and settles when disabled', async () => {
  const s = setup();
  await s.loaded();
  s.engine.setLoop(175, 180, true);
  await s.engine.play();
  s.context.currentTime = 5;
  s.audio.ended = true;
  s.audio.paused = true;
  s.audio.currentTime = 180;
  const beforeLoop = s.calls.length;
  s.audio.dispatchEvent(new Event('ended'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.audio.currentTime, 175);
  assert.equal(s.engine.state, 'playing');
  assert.equal(s.calls.slice(beforeLoop).some(call => call[0] === 'set' && call[1] === 0), false);
  s.engine.setLoop(175, 180, false);
  s.audio.ended = true;
  s.audio.paused = true;
  s.audio.dispatchEvent(new Event('ended'));
  assert.equal(s.engine.state, 'ended');
  assert.equal(s.engine.isPlaying, false);
});

test('failed playback reports an error instead of leaving active controls', async () => {
  const s = setup();
  await s.loaded();
  let failure;
  s.engine.on('error', detail => { failure = detail; });
  s.audio.pendingPlay = Promise.reject(new Error('NotAllowedError'));
  assert.equal(await s.engine.play(), false);
  assert.equal(s.engine.state, 'error');
  assert.equal(s.engine.isPlaying, false);
  assert.equal(failure.message, 'NotAllowedError');
});

test('disposing while loading cancels operations and releases media', async () => {
  const s = setup();
  const pending = s.engine.load(new Blob(['data']));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  s.engine.dispose();
  await rejected;
  assert.deepEqual(s.revoked, ['blob:1']);
  assert.equal(await s.engine.play(), false);
  assert.equal(await s.engine.pause(), false);
});


test('manual stop fades out then returns to an explicit week anchor even with repeat off', async () => {
  for (const rate of [1, 0.8]) {
    const s = setup();
    await s.loaded();
    s.engine.setLoop(59, 74, false);
    s.engine.setRate(rate);
    await s.engine.play();
    s.audio.currentTime = 65;
    s.context.currentTime = 1;
    s.audio.asyncSeek = true;
    const stopped = s.engine.stop(59);
    assert.equal(s.engine.state, 'stopping');
    assert.equal(s.audio.currentTime, 65, 'do not rewind audible audio while fading');
    assert.deepEqual(s.calls.at(-1), ['ramp', 0, 2]);
    s.context.currentTime = 2;
    s.run(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.audio.paused, true);
    assert.equal(s.audio.currentTime, 59);
    assert.equal(s.engine.state, 'stopping', 'stay stopping until native seek completes');
    let settled = false;
    stopped.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    s.audio.finishSeek();
    assert.equal(await stopped, true);
    assert.equal(s.engine.state, 'stopped');
    assert.equal(s.engine.playbackRate, rate);
    assert.equal(s.audio.playbackRate, rate, 'the fresh native decoder must retain the selected rate');
    assert.equal(s.audio.defaultPlaybackRate, rate);
    assert.equal(await s.engine.play(), true);
    assert.equal(s.audio.playPositions.at(-1), 59);
  }
});

test('a play during stop waits for silence and anchor positioning instead of resuming the tail', async () => {
  const s = setup();
  await s.loaded();
  await s.engine.play();
  s.audio.currentTime = 38;
  s.context.currentTime = 1;
  s.audio.asyncSeek = true;
  const stopped = s.engine.stop(30);
  const restarted = s.engine.play();
  assert.equal(s.engine.queuedPlay, true);
  assert.deepEqual(s.audio.playPositions, [0]);
  s.engine.setVolume(0.7);
  assert.deepEqual(s.calls.at(-1), ['ramp', 0, 2], 'volume changes cannot reverse a stop fade');
  s.context.currentTime = 2;
  s.run(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.audio.paused, true);
  assert.equal(s.audio.currentTime, 30);
  assert.deepEqual(s.audio.playPositions, [0]);
  s.audio.finishSeek();
  assert.equal(await stopped, true);
  assert.equal(await restarted, true);
  assert.equal(s.engine.queuedPlay, false);
  assert.deepEqual(s.audio.playPositions, [0, 30]);
  assert.deepEqual(s.calls.at(-1), ['ramp', 0.7, 3]);
});

test('warmup stops return to zero and an intentional paused seek can select a different start', async () => {
  const s = setup();
  await s.loaded();
  await s.engine.play();
  s.audio.currentTime = 21;
  s.context.currentTime = 1;
  const stopped = s.engine.stop(0);
  s.context.currentTime = 2;
  s.run(1000);
  assert.equal(await stopped, true);
  assert.equal(s.audio.currentTime, 0);
  assert.equal(s.engine.seek(8.25), true);
  await s.engine.play();
  assert.equal(s.audio.playPositions.at(-1), 8.25);
});

test('loop boundaries and natural ending cannot bypass an active stop anchor', async () => {
  const s = setup();
  await s.loaded();
  s.engine.setLoop(30, 44, true);
  await s.engine.play();
  s.audio.currentTime = 43.8;
  s.context.currentTime = 1;
  const stopped = s.engine.stop(30);
  s.audio.currentTime = 44.2;
  s.audio.dispatchEvent(new Event('timeupdate'));
  assert.equal(s.audio.currentTime, 44.2, 'a fade-out cannot wrap back into audible loop audio');
  s.audio.currentTime = 180;
  s.audio.ended = true;
  s.audio.paused = true;
  s.audio.dispatchEvent(new Event('ended'));
  s.context.currentTime = 2;
  s.run(1000);
  assert.equal(await stopped, true);
  assert.equal(s.audio.currentTime, 30);
  assert.equal(s.engine.state, 'stopped');
  assert.deepEqual(s.audio.playPositions, [30]);
});

test('a second stop replaces the old anchor and cancels an older queued play', async () => {
  const s = setup();
  await s.loaded();
  await s.engine.play();
  s.audio.currentTime = 65;
  s.context.currentTime = 1;
  const firstStop = s.engine.stop(30);
  const oldQueuedPlay = s.engine.play();
  const secondStop = s.engine.stop(44);
  assert.equal(await firstStop, false);
  assert.equal(await oldQueuedPlay, false);
  s.context.currentTime = 2;
  s.run(1000);
  assert.equal(await secondStop, true);
  assert.equal(s.audio.currentTime, 44);
  assert.equal(s.audio.paused, true);
});

test('loading another source cancels an old stop and its queued playback without stale seeks', async () => {
  const s = setup();
  await s.loaded();
  await s.engine.play();
  s.audio.currentTime = 65;
  const stopped = s.engine.stop(30);
  const started = s.engine.play();
  await s.loaded();
  assert.equal(await stopped, false);
  assert.equal(await started, false);
  s.run(2000);
  assert.equal(s.engine.state, 'ready');
  assert.equal(s.audio.paused, true);
  assert.notEqual(s.audio.currentTime, 30);
});

test('disposing cancels an unfinished stop and any queued start', async () => {
  const s = setup();
  await s.loaded();
  await s.engine.play();
  const stopped = s.engine.stop(30);
  const started = s.engine.play();
  s.engine.dispose();
  assert.equal(await stopped, false);
  assert.equal(await started, false);
  s.run(2000);
  assert.equal(s.audio.paused, true);
  assert.notEqual(s.audio.currentTime, 30);
});

test('a delayed context resume cannot consume audio before gain and seek are ready', async () => {
  const s = setup();
  await s.loaded();
  s.engine.seek(30);
  s.context.state = 'suspended';
  let resume;
  s.context.resume = () => { s.context.resumeCalls = 1; return new Promise(resolve => { resume = () => { s.context.state = 'running'; resolve(); }; }); };
  const started = s.engine.play();
  assert.equal(s.context.resumeCalls, 1, 'unlock is initiated inside the click');
  assert.equal(s.audio.paused, true);
  assert.deepEqual(s.audio.playPositions, []);
  assert.equal(s.audio.currentTime, 30);
  resume();
  assert.equal(await started, true);
  assert.deepEqual(s.audio.playPositions, [30]);
});


test('stop retires the previous decoder and source before a fresh element can replay the anchor', async () => {
  const s = setup();
  await s.loaded();
  await s.engine.play();
  const old = s.audio;
  const oldSource = s.sources[0];
  old.currentTime = 65;
  s.context.currentTime = 1;
  const stopped = s.engine.stop(59);
  s.context.currentTime = 2;
  s.run(1000);
  assert.equal(await stopped, true);
  assert.notEqual(s.audio, old);
  assert.equal(old.paused, true);
  assert.equal(old.muted, true);
  assert.equal(old.sourceCleared, true);
  assert.equal(oldSource.disconnected, true);
  assert.equal(s.sources.at(-1).audio, s.audio);
  assert.equal(s.sources.at(-1).connected, true);
  assert.equal(s.gain.value, 0, 'fresh decoder is connected only behind a silent gain');
  old.paused = false;
  old.ended = true;
  old.error = { code: 4 };
  for (const type of ['error', 'ended', 'pause', 'seeked', 'timeupdate']) old.dispatchEvent(new Event(type));
  assert.equal(s.engine.state, 'stopped', 'retired native events are inert');
  assert.equal(s.audio.currentTime, 59);
  await s.engine.play();
  assert.equal(s.playPositions.at(-1), 59);
});

test('queued replay waits for fresh metadata, anchor seek and future data instead of draining old samples', async () => {
  const s = setup({ replacementReadyState: 1 });
  await s.loaded();
  await s.engine.play();
  s.audio.asyncSeek = true;
  s.audio.currentTime = 38;
  s.context.currentTime = 1;
  const stopped = s.engine.stop(30);
  const replayed = s.engine.play();
  s.context.currentTime = 2;
  s.run(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.elements.length, 2);
  assert.equal(s.audio.currentTime, 30);
  assert.equal(s.audio.paused, true);
  s.audio.finishSeek();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.engine.state, 'stopping');
  assert.deepEqual(s.playPositions, [0]);
  assert.equal(s.gain.value, 0);
  s.audio.readyState = 3;
  s.audio.dispatchEvent(new Event('canplay'));
  assert.equal(await stopped, true);
  assert.equal(await replayed, true);
  assert.deepEqual(s.playPositions, [0, 30]);
});

test('volume zero remains natively muted through decoder replacement and restart', async () => {
  const s = setup();
  await s.loaded();
  s.engine.setVolume(0);
  assert.equal(s.audio.muted, true);
  await s.engine.play();
  s.context.currentTime = 1;
  const stopped = s.engine.stop(30);
  s.context.currentTime = 2;
  s.run(1000);
  await stopped;
  assert.equal(s.audio.muted, true);
  await s.engine.play();
  assert.equal(s.audio.muted, true);
  assert.equal(s.engine.volume, 0);
  assert.deepEqual(s.calls.at(-1), ['ramp', 0, 3]);
});

test('loading a new file during replacement cancels stale readiness without reviving its source', async () => {
  const s = setup({ autoMetadata: false });
  await s.loaded();
  await s.engine.play();
  s.context.currentTime = 1;
  const stopped = s.engine.stop(30);
  const replayed = s.engine.play();
  s.context.currentTime = 2;
  s.run(1000);
  await new Promise(resolve => setImmediate(resolve));
  const candidate = s.audio;
  const pause = s.engine.pause();
  await s.loaded();
  assert.equal(await stopped, false);
  assert.equal(await replayed, false);
  assert.equal(await pause, false);
  candidate.metadata();
  candidate.finishSeek();
  assert.equal(s.engine.state, 'ready');
  assert.notEqual(s.audio, candidate);
  assert.equal(s.audio.paused, true);
  assert.equal(s.audio.currentTime, 0);
});

test('paused week changes and the restart button also use an empty decoder instead of the previous phrase tail', async () => {
  const s = setup();
  await s.loaded();
  await s.engine.play();
  const old = s.audio;
  old.currentTime = 65;
  s.engine.setFade(0);
  await s.engine.pause();
  assert.equal(s.engine.seek(44), true);
  assert.notEqual(s.audio, old);
  await s.engine.play();
  assert.equal(s.playPositions.at(-1), 44);
  const next = s.audio;
  s.audio.currentTime = 50;
  assert.equal(await s.engine.restart(44), true);
  assert.notEqual(s.audio, next);
  assert.equal(s.playPositions.at(-1), 44);
});

test('rapid paused scrubbing retargets the fresh preparation without letting its original anchor win', async () => {
  const s = setup({ autoMetadata: false });
  await s.loaded();
  await s.engine.play();
  s.engine.setFade(0);
  await s.engine.pause();
  s.engine.seek(30);
  const fresh = s.audio;
  s.engine.seek(44.25);
  assert.equal(s.audio, fresh);
  fresh.metadata();
  assert.equal(await s.engine.play(), true);
  assert.equal(s.audio.currentTime, 44.25);
  assert.equal(s.playPositions.at(-1), 44.25);
});


test('resuming a fully paused media element also replaces its retained decoder at the current position', async () => {
  const s = setup();
  await s.loaded();
  await s.engine.play();
  s.engine.setFade(0);
  s.audio.currentTime = 38.25;
  const old = s.audio;
  await s.engine.pause();
  assert.equal(await s.engine.play(), true);
  assert.notEqual(s.audio, old);
  assert.equal(s.audio.currentTime, 38.25);
  assert.equal(s.playPositions.at(-1), 38.25);
});


test('native load rate reset retains 0.8x across initial load, stop replacement and native readiness', async () => {
  const s = setup({ replacementReadyState: 1 });
  s.engine.setRate(0.8);
  await s.loaded();
  assert.equal(s.audio.defaultPlaybackRate, 0.8);
  assert.equal(s.audio.playbackRate, 0.8);
  await s.engine.play();
  s.context.currentTime = 1;
  const stopped = s.engine.stop(30);
  s.context.currentTime = 2;
  s.run(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.audio.defaultPlaybackRate, 0.8);
  assert.equal(s.audio.playbackRate, 0.8);
  // Also defend against a late native readiness update restoring the old rate.
  s.audio.playbackRate = 1;
  s.audio.readyState = 3;
  s.audio.dispatchEvent(new Event('canplay'));
  assert.equal(await stopped, true);
  assert.equal(s.audio.playbackRate, 0.8);
  assert.equal(s.audio.defaultPlaybackRate, 0.8);
  await s.engine.play();
  assert.equal(s.audio.playbackRate, 0.8);
  assert.equal(s.audio.preservesPitch, true);
});


test('pause waiting for a fresh decoder cannot report success after a newer play has started', async () => {
  const s = setup({ autoMetadata: false });
  await s.loaded();
  await s.engine.play();
  s.engine.setFade(0);
  await s.engine.pause();
  s.engine.seek(30);
  const paused = s.engine.pause();
  const started = s.engine.play();
  s.audio.metadata();
  assert.equal(await started, true);
  assert.equal(await paused, false, 'the older week-change pause cannot seek under newer playback');
  assert.equal(s.engine.state, 'playing');
});


test('compressed source preparation runs once per load and fresh stops reuse its PCM backing', async () => {
  const backing = new Blob(['pcm-wav'], { type: 'audio/wav' });
  let preparations = 0;
  const s = setup({ prepareAudio: original => { preparations++; return { blob: backing, mode: 'decoded-pcm', precise: true, sampleRate: 44100 }; } });
  await s.loaded();
  assert.equal(s.createdBlobs[0], backing);
  assert.equal(s.engine.sourcePreparation.mode, 'decoded-pcm');
  await s.engine.play();
  s.engine.setFade(0);
  await s.engine.stop(30);
  await s.engine.play();
  await s.engine.stop(30);
  assert.equal(preparations, 1);
  assert.equal(s.createdBlobs.length, 1);
});

test('a canceled compressed decode cannot install its URL after a newer load', async () => {
  const requests = [];
  const s = setup({ prepareAudio: (original, options) => new Promise(resolve => requests.push({ original, signal: options.signal, resolve })) });
  const first = s.engine.load(new Blob(['old']));
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = s.engine.load(new Blob(['new']));
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ blob: new Blob(['old-pcm']), mode: 'decoded-pcm', precise: true });
  await Promise.resolve();
  assert.equal(s.createdBlobs.length, 0);
  const backing = new Blob(['new-pcm']);
  requests[1].resolve({ blob: backing, mode: 'decoded-pcm', precise: true });
  await Promise.resolve();
  s.audio.metadata();
  await second;
  await rejected;
  assert.deepEqual(s.createdBlobs, [backing]);
});

test('dispose aborts a pending source preparation and does not retain its late PCM Blob', async () => {
  let finish, signal;
  const s = setup({ prepareAudio: (original, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  const loaded = s.engine.load(new Blob(['old']));
  const rejected = assert.rejects(loaded, { name: 'AbortError' });
  s.engine.dispose();
  assert.equal(signal.aborted, true);
  finish({ blob: new Blob(['late-pcm']), mode: 'decoded-pcm', precise: true });
  await Promise.resolve();
  await rejected;
  assert.equal(s.createdBlobs.length, 0);
});
