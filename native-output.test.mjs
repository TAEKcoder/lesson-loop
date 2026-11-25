import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeOutput, shouldUseNativeOutput } from './next/native-output.js';

const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15';
function setup() {
  let milliseconds = 12000, audio = { volume: 1, muted: false }, id = 0;
  const frames = new Map(), timers = new Map();
  const output = createNativeOutput({ getAudio: () => audio, now: () => milliseconds,
    requestAnimationFrame: callback => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: key => frames.delete(key),
    setTimeout: (callback, delay) => { timers.set(++id, { callback, at: milliseconds + delay }); return id; },
    clearTimeout: key => timers.delete(key),
  });
  const advance = (elapsed, { raf = true, timeouts = true } = {}) => {
    milliseconds = 12000 + elapsed;
    if (timeouts) for (const [key, timer] of [...timers]) if (timer.at <= milliseconds && timers.has(key)) {
      timers.delete(key); timer.callback();
    }
    if (raf) for (const [key, callback] of [...frames]) if (frames.has(key)) {
      frames.delete(key); callback(milliseconds);
    }
  };
  return { output, parameter: output.gain.gain, frames, timers, advance,
    get audio() { return audio; }, set audio(value) { audio = value; } };
}
const close = s => s.output.dispose();

test('native routing detects desktop Safari without capturing other browsers or iPad desktop mode', () => {
  assert.equal(shouldUseNativeOutput(safari, { platform: 'MacIntel', maxTouchPoints: 0 }), true);
  assert.equal(shouldUseNativeOutput(safari, { platform: 'MacIntel', maxTouchPoints: 5 }), false);
  assert.equal(shouldUseNativeOutput(safari.replace('Version/27.0', 'Chrome/150.0'), {}), false);
  assert.equal(shouldUseNativeOutput(safari + ' Edg/150.0', {}), false);
  assert.equal(shouldUseNativeOutput(safari + ' OPR/120.0', {}), false);
  assert.equal(shouldUseNativeOutput(safari.replace('Macintosh; Intel Mac OS X 15_6', 'iPhone; CPU iPhone OS 18_0 like Mac OS X'), {}), false);
  assert.equal(shouldUseNativeOutput('Mozilla/5.0 Firefox/150.0', {}), false);
});

test('native output starts silent and uses a monotonic running clock without any Web Audio API', async () => {
  const s = setup();
  assert.equal(s.audio.volume, 0);
  assert.equal(s.audio.muted, false, 'mute ownership stays with the engine');
  assert.equal(s.output.context.state, 'running');
  assert.equal(s.output.context.currentTime, 0);
  s.advance(500);
  assert.equal(s.output.context.currentTime, .5);
  s.advance(250);
  assert.equal(s.output.context.currentTime, .5, 'clock cannot regress');
  await s.output.context.resume();
  close(s);
  assert.equal(s.output.context.state, 'closed');
  s.advance(2000);
  assert.equal(s.output.context.currentTime, .5);
  await assert.rejects(s.output.context.resume(), { name: 'InvalidStateError' });
});

test('gain automation fades the native element and reaches the exact terminal volume', () => {
  const s = setup();
  s.parameter.setValueAtTime(0, 0).linearRampToValueAtTime(1, 1);
  s.advance(250); assert.equal(s.audio.volume, .25);
  s.advance(500); assert.equal(s.audio.volume, .5);
  assert.equal(s.parameter.value, .5);
  s.advance(1000); assert.equal(s.audio.volume, 1);
  assert.equal(s.frames.size, 0); assert.equal(s.timers.size, 0);
  close(s);
});

test('a bounded end timer completes fade-in when requestAnimationFrame is suspended', () => {
  const s = setup();
  s.parameter.setValueAtTime(0, 0).linearRampToValueAtTime(.8, 1);
  assert.equal(s.timers.size, 1);
  s.advance(500, { raf: false, timeouts: false });
  assert.equal(s.audio.volume, 0, 'there was no frame callback');
  s.advance(1000, { raf: false });
  assert.equal(s.audio.volume, .8, 'the end timer must prevent permanent silence');
  assert.equal(s.frames.size, 0); assert.equal(s.timers.size, 0);
  close(s);
});

test('cancel and reverse preserve the current level without an old endpoint returning', () => {
  const s = setup();
  s.parameter.setValueAtTime(0, 0).linearRampToValueAtTime(1, 1);
  s.advance(400);
  s.parameter.cancelScheduledValues(.4);
  assert.equal(s.audio.volume, .4);
  s.parameter.setValueAtTime(.4, .4).linearRampToValueAtTime(0, .9);
  s.advance(650); assert.ok(Math.abs(s.audio.volume - .2) < 1e-12);
  s.advance(900); assert.equal(s.audio.volume, 0);
  s.advance(2000); assert.equal(s.audio.volume, 0);
  assert.equal(s.frames.size, 0); assert.equal(s.timers.size, 0);
  close(s);
});

test('a replacement element receives only the current envelope and the retired element is silenced', () => {
  const s = setup(), previous = s.audio;
  s.parameter.setValueAtTime(0, 0).linearRampToValueAtTime(.8, 1);
  s.advance(500);
  s.audio = { volume: 1, muted: false };
  s.output.refreshAudio();
  assert.equal(previous.volume, 0);
  assert.equal(s.audio.volume, .4);
  s.advance(1000);
  assert.equal(previous.volume, 0);
  assert.equal(s.audio.volume, .8);
  close(s);
});

test('zero volume remains silent across fresh elements, delayed frames, and scheduled fades', () => {
  const s = setup();
  s.audio.muted = true;
  s.parameter.setValueAtTime(0, 0).linearRampToValueAtTime(0, 1);
  s.advance(500);
  s.audio = { volume: 1, muted: true };
  s.output.refreshAudio();
  assert.equal(s.audio.volume, 0); assert.equal(s.audio.muted, true);
  s.advance(1000, { raf: false });
  assert.equal(s.audio.volume, 0); assert.equal(s.audio.muted, true);
  close(s);
});

test('future sets do not apply early and a canceled future ramp holds at its cutoff', () => {
  const s = setup();
  s.parameter.setValueAtTime(.5, 1);
  s.advance(500); assert.equal(s.audio.volume, 0);
  s.advance(1000); assert.equal(s.audio.volume, .5);
  s.parameter.setValueAtTime(0, 1).linearRampToValueAtTime(1, 2);
  s.parameter.cancelScheduledValues(1.75);
  s.advance(1500); assert.equal(s.audio.volume, .5);
  s.advance(1750); assert.equal(s.audio.volume, .75);
  s.advance(2500); assert.equal(s.audio.volume, .75);
  close(s);
});

test('dispose silences output and stale callbacks cannot revive either an old or fresh element', () => {
  const s = setup();
  s.parameter.setValueAtTime(0, 0).linearRampToValueAtTime(1, 1);
  const staleFrame = [...s.frames.values()][0], staleTimer = [...s.timers.values()][0].callback;
  s.advance(500);
  close(s);
  assert.equal(s.audio.volume, 0);
  assert.equal(s.frames.size, 0); assert.equal(s.timers.size, 0);
  staleFrame(); staleTimer();
  s.audio = { volume: 1, muted: false }; s.output.refreshAudio();
  s.parameter.value = 1; s.parameter.setValueAtTime(1, 0).linearRampToValueAtTime(1, 2);
  assert.equal(s.audio.volume, 0); assert.equal(s.parameter.value, 0);
  assert.equal(s.frames.size, 0); assert.equal(s.timers.size, 0);
});

test('native levels are clamped and invalid automation is rejected without setting invalid audio volume', () => {
  const s = setup();
  s.parameter.value = 2; assert.equal(s.audio.volume, 1);
  s.parameter.value = -1; assert.equal(s.audio.volume, 0);
  assert.throws(() => s.parameter.setValueAtTime(NaN, 0), TypeError);
  assert.throws(() => s.parameter.linearRampToValueAtTime(1, -1), RangeError);
  close(s);
});
