import test from 'node:test';
import assert from 'node:assert/strict';
import { LinkedPeakLimiter, OutputStage, OUTPUT_CEILING } from './next/output-stage.js';
import { AudioEngine } from './next/audio-engine.js';

function process(core, left, right, db, muted = false) {
  const input = [Float32Array.from(left), Float32Array.from(right || left)];
  const output = input.map(channel => new Float32Array(channel.length));
  core.process(input, output, db, muted);
  return output;
}
const peak = channels => Math.max(...channels.map(channel => Math.max(0, ...Array.from(channel, Math.abs))));

test('0dB DSP bypass preserves source amplitude and timing even above full scale', () => {
  const core = new LinkedPeakLimiter(48000);
  const source = Float32Array.of(0, .1, -.2, 1.6, -1.4, 0);
  const output = process(core, source, source, 0);
  assert.deepEqual(output[0], source);
  assert.deepEqual(output[1], source);
});

test('positive trim increases quiet audio and keeps a stereo-linked strict peak ceiling', () => {
  const core = new LinkedPeakLimiter(48000);
  const quiet = process(core, Array(1024).fill(.1), Array(1024).fill(.025), 3);
  assert.ok(Math.abs(quiet[0].at(-1) - .1 * 10 ** (3 / 20)) < 1e-6);
  const loud = process(core, Array(4096).fill(1.6), Array(4096).fill(.4), 6);
  assert.ok(peak(loud) <= OUTPUT_CEILING + 1e-7);
  assert.ok(peak(loud) < 1);
  for (let i = core.delay; i < loud[0].length; i++) assert.ok(Math.abs(loud[1][i] / loud[0][i] - .25) < 1e-6);
});

test('lookahead catches isolated transients and release cannot overshoot the ceiling', () => {
  const core = new LinkedPeakLimiter(44100);
  const left = Array(8192).fill(.04), right = Array(8192).fill(.02);
  for (const at of [0, 220, 221, 4000, 7000]) { left[at] = -2; right[at] = .7; }
  const output = process(core, left, right, 6);
  assert.ok(peak(output) <= OUTPUT_CEILING + 1e-7);
  assert.ok(peak(output) > .9);
});

test('reset drops every old PCM sample and mute outputs exact zero at any boost', () => {
  const core = new LinkedPeakLimiter(48000);
  process(core, Array(512).fill(.8), Array(512).fill(.4), 6);
  core.reset();
  const newPhrase = Array(1024).fill(0); newPhrase[0] = .05;
  const output = process(core, newPhrase, newPhrase, 6);
  assert.equal(output[0].findIndex(value => value !== 0), core.delay);
  assert.ok(peak(output) < .101, 'no sample from the previous .8 phrase may survive reset');
  process(core, Array(512).fill(.9), Array(512).fill(.9), 6);
  assert.equal(peak(process(core, Array(512).fill(1), Array(512).fill(1), 6, true)), 0);
  assert.equal(peak(process(core, Array(512).fill(0), Array(512).fill(0), 6)), 0);
});

function node() {
  return { routes: new Set(), gain: { value: 1, setValueAtTime(value) { this.value = value; } }, connect(target) { this.routes.add(target); }, disconnect() { this.routes.clear(); } };
}
function workletContext() {
  const context = { currentTime: 0, state: 'running', destination: {}, loads: 0, createGain: node, audioWorklet: { addModule: async () => { context.loads++; } } };
  const nodes = [];
  const nodeFactory = () => {
    const result = node();
    result.parameters = new Map([['gainDb', { value: 0, setValueAtTime(value) { this.value = value; } }]]);
    result.port = { postMessage(message) { if (message.type === 'reset' && message.id) queueMicrotask(() => result.port.onmessage({ data: { type: 'reset-complete', id: message.id } })); } };
    nodes.push(result); return result;
  };
  return { context, nodes, nodeFactory };
}

test('output graph uses an untouched zero-dB route and only one boosted destination route', async () => {
  const { context, nodes, nodeFactory } = workletContext();
  const input = node();
  const stage = new OutputStage(context, input, context.destination, { nodeFactory });
  assert.deepEqual([...input.routes], [context.destination]);
  assert.equal(context.loads, 0);
  await Promise.all([stage.prepare(3), stage.prepare(1)]);
  assert.equal(context.loads, 1);
  assert.equal(nodes.length, 1);
  stage.activate(3); await stage.flush(); stage.open();
  assert.deepEqual([...input.routes], [nodes[0]]);
  assert.deepEqual([...stage.gate.routes], [context.destination]);
  assert.equal(stage.gate.gain.value, 1);
  stage.setMuted(true);
  assert.equal(stage.gate.gain.value, 0);
  stage.activate(0);
  assert.deepEqual([...input.routes], [context.destination]);
  assert.equal(stage.gate.routes.size, 0);
  stage.dispose();
});

class FakeAudio extends EventTarget {
  paused = true; ended = false; currentTime = 0; duration = 180; readyState = 4; playbackRate = 1; defaultPlaybackRate = 1; plays = [];
  play() { this.paused = false; this.plays.push(this.currentTime); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() {} removeAttribute() {}
  metadata() { this.dispatchEvent(new Event('loadedmetadata')); }
}
function engineFixture(options = {}) {
  const audio = new FakeAudio(); const gains = [];
  const context = { state: 'running', currentTime: 0, destination: {}, createGain() { const result = node(); result.gain.cancelScheduledValues = () => {}; result.gain.linearRampToValueAtTime = value => { result.gain.target = value; }; gains.push(result); return result; }, createMediaElementSource: node, close: async () => {}, resume: async () => {} };
  const engine = new AudioEngine({ audio, contextFactory: () => context, prepareAudio: blob => ({ blob, precise: true }), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, urls: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, ...options });
  const loaded = async () => { const result = engine.load(new Blob(['audio'])); audio.metadata(); await result; };
  return { engine, audio, context, gains, loaded };
}

test('engine zero-dB default does not wait for or insert worklet processing, and mute stays zero', async () => {
  const s = engineFixture(); await s.loaded();
  assert.equal(s.engine.outputGainDb, 0);
  assert.equal(s.engine.setOutputGainDb(-1), false);
  assert.equal(s.engine.setOutputGainDb(7), false);
  assert.equal(s.engine.setOutputGainDb(NaN), false);
  s.engine.setVolume(0);
  const started = s.engine.play();
  assert.deepEqual(s.audio.plays, [0], 'bypass must retain the existing startup timing');
  await started;
  assert.equal(s.audio.muted, true);
  assert.equal(s.gains[0].gain.target, 0);
  assert.deepEqual([...s.gains[0].routes], [s.context.destination]);
  s.engine.dispose();
});

test('engine coalesces fast gain choices and waits for output reset ACK before native playback', async () => {
  let stage;
  const s = engineFixture({ outputStageFactory: (context, input, destination) => {
    input.connect(destination);
    stage = { activeDb: 0, requested: [], activated: [], flushes: [], muted: false, prepare(db) { return new Promise(resolve => this.requested.push({ db, resolve })); }, activate(db) { this.activeDb = db; this.activated.push(db); }, setMuted(value) { this.muted = value; }, flush() { return new Promise(resolve => this.flushes.push(resolve)); }, silence() {}, open() {}, dispose() {} };
    return stage;
  } });
  await s.loaded();
  s.engine.setOutputGainDb(3);
  const started = s.engine.play();
  const changed = s.engine.setOutputGainDb(1);
  stage.requested.find(request => request.db === 3).resolve();
  stage.requested.find(request => request.db === 1).resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(stage.activated, [1]);
  assert.deepEqual(s.audio.plays, []);
  stage.flushes.shift()();
  await changed;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(s.audio.plays, [], 'the manual start must clear old limiter PCM before the media advances');
  stage.flushes.shift()();
  assert.equal(await started, true);
  assert.equal(s.engine.outputGainDb, 1);
  assert.equal(s.engine.snapshot.outputGainDb, 1);
  assert.deepEqual(s.audio.plays, [0]);
  s.engine.dispose();
});

test('unsupported optional output processing falls back to original gain without an unhandled rejection', async () => {
  const s = engineFixture(); await s.loaded();
  let errors = 0; s.engine.on('error', () => errors++);
  s.engine.setOutputGainDb(3);
  assert.equal(await s.engine.play(), true);
  assert.equal(s.engine.outputGainDb, 0);
  assert.equal(errors, 1);
  assert.deepEqual([...s.gains[0].routes], [s.context.destination]);
  s.engine.dispose();
});


test('returning to zero dB cancels a pending worklet setup without holding original playback hostage', async () => {
  let stage;
  const s = engineFixture({ outputStageFactory: () => {
    stage = { activeDb: 0, prepare(db) { return db > 0 ? new Promise(resolve => { this.finish = resolve; }) : Promise.resolve(); }, activate(db) { this.activeDb = db; }, setMuted() {}, flush: async () => {}, silence() {}, open() {}, dispose() {} }; return stage;
  } });
  await s.loaded();
  s.engine.setOutputGainDb(3);
  const started = s.engine.play();
  await s.engine.setOutputGainDb(0);
  assert.equal(await started, true);
  assert.equal(s.engine.outputGainDb, 0);
  assert.deepEqual(s.audio.plays, [0]);
  stage.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stage.activeDb, 0);
  s.engine.dispose();
});
