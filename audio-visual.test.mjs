import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from './next/audio-engine.js';

class FakeAudio extends EventTarget {
  paused = true; ended = false; duration = 120; currentTime = 0; readyState = 4;
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() { if (this.autoMetadata && this.src) queueMicrotask(() => this.metadata()); }
  metadata() { this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('canplay')); }
  removeAttribute() {}
}
function setup() {
  const initial = new FakeAudio(), jobs = new Map(), calls = [];
  let id = 0;
  const context = { currentTime: 0, state: 'running', destination: {},
    createGain: () => ({ gain: { value: 0, cancelScheduledValues: value => calls.push(['cancel', value]), setValueAtTime(value, time) { this.value = value; calls.push(['set', value, time]); }, linearRampToValueAtTime: (value, time) => calls.push(['ramp', value, time]) }, connect() {}, disconnect() {} }),
    createMediaElementSource: () => ({ connect() {}, disconnect() {} }), close: async () => {}, resume: async () => {},
  };
  const engine = new AudioEngine({ audio: initial, audioFactory: () => { const audio = new FakeAudio(); audio.autoMetadata = true; return audio; }, prepareAudio: blob => ({ blob, precise: true }), contextFactory: () => context,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: (callback, delay) => { jobs.set(++id, { callback, delay }); return id; }, clearTimeout: key => jobs.delete(key),
    urls: { createObjectURL: () => 'blob:visual-test', revokeObjectURL() {} },
  });
  const loaded = async () => { const result = engine.load(new Blob(['audio'])); initial.metadata(); await result; };
  const run = delay => { for (const [key, job] of [...jobs]) if (job.delay <= delay && jobs.has(key)) { jobs.delete(key); job.callback(); } };
  return { engine, context, calls, loaded, run };
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('visual telemetry follows context-clock fade in/out and completed stop without changing audio state', async () => {
  const s = setup(); await s.loaded(); s.engine.setVolume(.8);
  assert.deepEqual(s.engine.visualState, { masterGain: 0, envelopeLevel: 0, phase: 'idle', progress: 1, muted: false });
  await s.engine.play();
  s.context.currentTime = .25;
  const visual = s.engine.visualState;
  close(visual.masterGain, .2); close(visual.envelopeLevel, .25); close(visual.progress, .25); assert.equal(visual.phase, 'in');
  const calls = s.calls.length, sourceTime = s.engine.currentTime;
  for (let i = 0; i < 20; i++) assert.deepEqual(s.engine.visualState, visual);
  assert.equal(s.calls.length, calls, 'reading display values must not schedule AudioParams');
  assert.equal(s.engine.currentTime, sourceTime, 'reading display values must not seek or advance media');
  assert.deepEqual(s.engine.snapshot.visualState, visual);
  s.context.currentTime = 1;
  assert.equal(s.engine.visualState.phase, 'idle'); close(s.engine.visualState.envelopeLevel, 1);
  const stopped = s.engine.stop(30);
  s.context.currentTime = 1.4;
  close(s.engine.visualState.masterGain, .48); close(s.engine.visualState.envelopeLevel, .6); close(s.engine.visualState.progress, .4); assert.equal(s.engine.visualState.phase, 'out');
  s.context.currentTime = 2; s.run(1000); await stopped;
  assert.deepEqual(s.engine.visualState, { masterGain: 0, envelopeLevel: 0, phase: 'idle', progress: 1, muted: false });
  assert.equal(s.engine.currentTime, 30);
  s.engine.dispose();
});

test('muted playback retains an honest zero master gain while the display envelope can animate and reverse', async () => {
  const s = setup(); await s.loaded(); s.engine.setVolume(0); await s.engine.play();
  s.context.currentTime = .25;
  assert.equal(s.engine.visualState.muted, true); assert.equal(s.engine.audio.muted, true);
  close(s.engine.visualState.masterGain, 0); close(s.engine.visualState.envelopeLevel, .25); assert.equal(s.engine.visualState.phase, 'in');
  const paused = s.engine.pause();
  s.context.currentTime = .5;
  close(s.engine.visualState.envelopeLevel, .1875); close(s.engine.visualState.masterGain, 0); assert.equal(s.engine.visualState.phase, 'out');
  const before = s.engine.visualState.envelopeLevel;
  await s.engine.play(); assert.equal(await paused, false);
  close(s.engine.visualState.envelopeLevel, before); assert.equal(s.engine.visualState.phase, 'in');
  s.context.currentTime = 1;
  close(s.engine.visualState.envelopeLevel, .59375); close(s.engine.visualState.masterGain, 0);
  assert.equal(s.engine.audio.muted, true);
  s.engine.dispose();
});

test('nonmuted fade reversal is continuous and telemetry stays finite at clock boundaries', async () => {
  const s = setup(); await s.loaded(); s.engine.setVolume(.8); await s.engine.play();
  s.context.currentTime = 1;
  const paused = s.engine.pause();
  s.context.currentTime = 1.4;
  const before = s.engine.visualState;
  await s.engine.play(); assert.equal(await paused, false);
  close(s.engine.visualState.masterGain, before.masterGain); close(s.engine.visualState.envelopeLevel, before.envelopeLevel);
  s.context.currentTime = 1.9;
  close(s.engine.visualState.masterGain, .64); close(s.engine.visualState.envelopeLevel, .8); close(s.engine.visualState.progress, .5);
  s.context.currentTime = 100;
  const complete = s.engine.visualState;
  assert.equal(complete.phase, 'idle'); assert.equal(complete.progress, 1);
  for (const value of [complete.masterGain, complete.envelopeLevel, complete.progress]) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
  s.engine.dispose();
});


test('master volume adjustments do not label a full transport envelope as fade in or out', async () => {
  const s = setup(); await s.loaded(); s.engine.setVolume(.8); await s.engine.play();
  s.context.currentTime = 1;
  s.engine.setVolume(.5);
  assert.equal(s.engine.visualState.phase, 'idle'); close(s.engine.visualState.envelopeLevel, 1); assert.equal(s.engine.visualState.progress, 1);
  s.context.currentTime = 1.03;
  close(s.engine.visualState.masterGain, .65); close(s.engine.visualState.envelopeLevel, 1);
  assert.equal(s.engine.visualState.phase, 'idle');
  s.context.currentTime = 1.1;
  s.engine.setVolume(0);
  assert.equal(s.engine.visualState.phase, 'idle'); close(s.engine.visualState.envelopeLevel, 1); assert.equal(s.engine.visualState.muted, true);
  s.engine.dispose();
});

test('muting during fade stabilizes a coherent normalized envelope without claiming a false fade out', async () => {
  const s = setup(); await s.loaded(); s.engine.setVolume(.8); await s.engine.play();
  s.context.currentTime = .25;
  s.engine.setVolume(0);
  close(s.engine.visualState.envelopeLevel, .25); assert.equal(s.engine.visualState.phase, 'idle');
  s.context.currentTime = .4;
  close(s.engine.visualState.masterGain, 0); close(s.engine.visualState.envelopeLevel, .25); assert.equal(s.engine.visualState.muted, true);
  const paused = s.engine.pause();
  s.context.currentTime = .9;
  assert.equal(s.engine.visualState.phase, 'out'); close(s.engine.visualState.envelopeLevel, .125); close(s.engine.visualState.masterGain, 0);
  s.context.currentTime = 1.4; s.run(1000); await paused;
  s.engine.dispose();
});
