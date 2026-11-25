import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from './next/audio-engine.js';

class AudioDouble extends EventTarget {
  paused = true; ended = false; error = null; duration = 180; readyState = 4; _currentTime = 0; asyncSeek = false; seeking = false; volume = 1; muted = false;
  plays = []; rates = []; _rate = 1; defaultPlaybackRate = 1;
  get currentTime() { return this._currentTime; }
  set currentTime(value) { this._currentTime = value; if (this.asyncSeek) this.seeking = true; }
  finishSeek() { this.seeking = false; this.dispatchEvent(new Event('seeked')); this.dispatchEvent(new Event('canplay')); }
  get playbackRate() { return this._rate; }
  set playbackRate(value) { this._rate = value; this.rates.push({ value, paused: this.paused }); }
  play() { this.plays.push({ position: this.currentTime, rate: this.playbackRate, volume: this.volume }); this.paused = false; this.ended = false; return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() { this.playbackRate = this.defaultPlaybackRate; if (this.src) queueMicrotask(() => { this.readyState = 4; this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('canplay')); }); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
function setup() {
  const audio = new AudioDouble(), jobs = new Map(), frames = new Map();
  let now = 0, id = 0, factories = 0, contexts = 0;
  const engine = new AudioEngine({ audio, outputMode: 'native', nativeNow: () => now,
    audioFactory: () => { factories++; return new AudioDouble(); }, contextFactory: () => { contexts++; throw new Error('must not create an AudioContext'); },
    prepareAudio: blob => ({ blob, mode: 'decoded-pcm', precise: true }),
    requestAnimationFrame: callback => { frames.set(++id, callback); return id; }, cancelAnimationFrame: key => frames.delete(key),
    setTimeout: (callback, delay) => { jobs.set(++id, { callback, due: now + delay }); return id; }, clearTimeout: key => jobs.delete(key),
    urls: { createObjectURL: () => 'blob:native-test', revokeObjectURL() {} },
  });
  const advance = milliseconds => {
    now += milliseconds;
    for (const [key, callback] of [...frames]) if (frames.has(key)) { frames.delete(key); callback(now); }
    for (let guard = 0; guard < 20; guard++) {
      const due = [...jobs].filter(([, job]) => job.due <= now);
      if (!due.length) break;
      for (const [key, job] of due) if (jobs.has(key)) { jobs.delete(key); job.callback(); }
    }
  };
  const loaded = () => engine.load(new Blob(['pcm-wav'], { type: 'audio/wav' }));
  return { engine, audio, advance, loaded, get factories() { return factories; }, get contexts() { return contexts; } };
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('native Safari route starts synchronously after preparation and never creates a Web Audio graph', async () => {
  const s = setup(); await s.loaded(); s.engine.setVolume(.8);
  assert.equal(await s.engine.preparePosition(30), true);
  const playing = s.engine.play();
  assert.equal(s.audio.plays.length, 1, 'native play is called inside the original gesture when preparation is complete');
  assert.equal(await playing, true);
  assert.equal(s.engine.outputMode, 'native'); assert.equal(s.engine.snapshot.outputMode, 'native');
  assert.equal(s.contexts, 0); assert.equal(s.factories, 0);
  s.advance(500); close(s.audio.volume, .4);
  s.advance(500); close(s.audio.volume, .8);
  s.audio.currentTime = 37;
  const stopped = s.engine.stop(30);
  s.advance(500); close(s.audio.volume, .4);
  s.advance(500); assert.equal(await stopped, true);
  assert.equal(s.engine.audio, s.audio, 'the gesture-authorized native element is reused');
  assert.equal(s.factories, 0); assert.equal(s.audio.currentTime, 30); assert.equal(s.audio.volume, 0);
  s.engine.dispose();
});

test('native compatibility output preserves mute/unmute and rejects unsupported positive output trim clearly', async () => {
  const s = setup(); await s.loaded(); s.engine.setVolume(0);
  let error; s.engine.on('error', value => { error = value.message; });
  assert.equal(s.engine.setOutputGainDb(2), false); assert.equal(s.engine.outputGainDb, 0); assert.match(error, /Safari/);
  await s.engine.play(); s.advance(1000);
  assert.equal(s.audio.muted, true); assert.equal(s.audio.volume, 0);
  s.engine.setVolume(.7); s.advance(30); close(s.audio.volume, .35); s.advance(30); close(s.audio.volume, .7);
  assert.equal(s.audio.muted, false); assert.equal(s.contexts, 0);
  s.engine.dispose();
});

test('a running rate change fades, pauses and positions before applying native rate and resumes at the same source position', async () => {
  const s = setup(); await s.loaded(); s.engine.setVolume(.8); await s.engine.play(); s.advance(1000);
  s.audio.currentTime = 37.15;
  const changed = s.engine.changeRate(.8);
  assert.equal(s.engine.rateChanging, true); assert.equal(s.engine.state, 'changing-rate'); assert.equal(s.audio.playbackRate, 1);
  s.advance(50);
  assert.equal(await changed, true);
  assert.equal(s.engine.rateChanging, false); assert.equal(s.engine.playbackRate, .8); assert.equal(s.audio.playbackRate, .8);
  assert.equal(s.audio.plays.at(-1).position, 37.15); assert.equal(s.audio.plays.at(-1).rate, .8);
  assert.ok(s.audio.rates.filter(item => item.value === .8).every(item => item.paused), 'rate must not be changed on an active native decoder');
  assert.equal(s.factories, 0); assert.equal(s.contexts, 0);
  s.advance(60); close(s.audio.volume, .8);
  s.engine.dispose();
});

test('rapid rate choices are latest-wins without briefly starting the obsolete slow version', async () => {
  const s = setup(); await s.loaded(); await s.engine.play(); s.advance(1000); s.audio.currentTime = 42;
  const slow = s.engine.changeRate(.8), normal = s.engine.changeRate(1);
  assert.equal(await slow, false);
  s.advance(50); assert.equal(await normal, true);
  assert.equal(s.audio.playbackRate, 1); assert.equal(s.engine.rateChanging, false);
  assert.deepEqual(s.audio.plays.map(item => item.rate), [1, 1]);
  assert.equal(s.audio.plays.at(-1).position, 42);
  s.engine.dispose();
});

test('manual stop during rate preparation cancels auto-resume and preserves the requested week start', async () => {
  const s = setup(); await s.loaded(); s.engine.setVolume(0); await s.engine.play(); s.advance(1000); s.audio.currentTime = 38;
  const changed = s.engine.changeRate(.8); s.advance(20);
  const stopped = s.engine.stop(30);
  assert.equal(await changed, false); assert.equal(s.engine.rateChanging, false);
  s.advance(1000); assert.equal(await stopped, true);
  assert.equal(s.audio.plays.length, 1); assert.equal(s.audio.paused, true); assert.equal(s.audio.currentTime, 30); assert.equal(s.audio.volume, 0);
  s.engine.dispose();
});

test('source change or disposal cancels a rate change without reviving the previous audio', async () => {
  const s = setup(); await s.loaded(); await s.engine.play();
  const changed = s.engine.changeRate(.8);
  await s.loaded();
  assert.equal(await changed, false); s.advance(1000);
  assert.equal(s.audio.plays.length, 1); assert.equal(s.audio.paused, true); assert.equal(s.engine.rateChanging, false);
  await s.engine.play();
  const pending = s.engine.changeRate(.8); s.engine.dispose();
  assert.equal(await pending, false); assert.equal(s.audio.volume, 0);
});


test('a later native stop invalidates an older same-element reset waiting for seek', async () => {
  const s = setup(); await s.loaded(); s.engine.setVolume(0); await s.engine.play(); s.advance(1000);
  s.audio.currentTime = 38; s.audio.asyncSeek = true;
  const changed = s.engine.changeRate(.8); s.advance(50);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.engine.rateChanging, true); assert.equal(s.audio.seeking, true);
  const oldGeneration = s.engine._mediaGeneration;
  const stopped = s.engine.stop(30);
  assert.equal(await changed, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(s.engine._mediaGeneration > oldGeneration);
  assert.equal(s.engine.audio, s.audio);
  s.audio.finishSeek();
  assert.equal(await stopped, true);
  assert.equal(s.engine.state, 'stopped'); assert.equal(s.audio.currentTime, 30); assert.equal(s.audio.plays.length, 1);
  assert.equal(s.engine._mediaReady, null); assert.equal(s.engine._cancelMediaWait, null);
  s.engine.dispose();
});

test('native decoder error during a rate fade settles the pending request instead of hanging the controls', async () => {
  const s = setup(); await s.loaded(); await s.engine.play(); s.advance(1000);
  const changed = s.engine.changeRate(.8);
  s.audio.error = { code: 3 }; s.audio.dispatchEvent(new Event('error'));
  assert.equal(await changed, false); assert.equal(s.engine.rateChanging, false); assert.equal(s.engine.state, 'error');
  s.advance(1000); assert.equal(s.audio.plays.length, 1);
  s.engine.dispose();
});
