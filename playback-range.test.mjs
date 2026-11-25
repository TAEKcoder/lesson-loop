import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from './next/audio-engine.js';

function setup({ duration = 30, prepareAudio } = {}) {
  let now = 0, id = 0, preparations = 0;
  const jobs = new Map(), frames = new Map();
  class AudioDouble extends EventTarget {
    paused = true; ended = false; error = null; readyState = 4; duration = duration; volume = 0; muted = false; base = 0; began = 0; rate = 1; defaultPlaybackRate = 1; plays = 0;
    get currentTime() { return this.base + (this.paused ? 0 : (now - this.began) / 1000 * this.rate); }
    set currentTime(value) { this.base = value; this.began = now; }
    get playbackRate() { return this.rate; }
    set playbackRate(value) { const position = this.currentTime; this.rate = value; this.currentTime = position; }
    play() { this.began = now; this.paused = false; this.ended = false; this.plays++; return Promise.resolve(); }
    pause() { const playing = !this.paused, position = this.currentTime; this.paused = true; this.base = position; if (playing) this.dispatchEvent(new Event('pause')); }
    removeAttribute(name) { if (name === 'src') { this.src = ''; this.currentTime = 0; this.readyState = 0; } }
    load() { this.playbackRate = this.defaultPlaybackRate; if (this.src) queueMicrotask(() => { this.readyState = 4; this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('canplay')); }); }
    finish() { this.base = this.duration; this.paused = true; this.ended = true; this.dispatchEvent(new Event('ended')); }
  }
  const audio = new AudioDouble();
  const engine = new AudioEngine({ audio, outputMode: 'native', nativeNow: () => now,
    prepareAudio: prepareAudio || (blob => { preparations++; return { blob, mode: 'decoded-pcm', precise: true }; }),
    requestAnimationFrame: callback => { frames.set(++id, callback); return id; }, cancelAnimationFrame: key => frames.delete(key),
    setTimeout: (callback, delay) => { jobs.set(++id, { callback, at: now + delay }); return id; }, clearTimeout: key => jobs.delete(key),
    urls: { createObjectURL: () => 'blob:range-fixture', revokeObjectURL() {} },
  });
  const advance = milliseconds => {
    const until = now + milliseconds;
    for (let guard = 0; guard < 10000; guard++) {
      const due = [...jobs].filter(([, job]) => job.at <= until).sort((a,b) => a[1].at-b[1].at);
      if (!due.length) break;
      const [key, job] = due[0]; jobs.delete(key); now = job.at; job.callback();
    }
    now = until;
    for (const [key, callback] of [...frames]) if (frames.has(key)) { frames.delete(key); callback(now); }
  };
  const load = options => engine.load(new Blob(['source'], { type: 'audio/wav' }), options);
  const ready = async (start=2,end=10,fade=1) => { await load(); engine.setVolume(.8); engine.setFade(1); engine.setPlaybackRange(start,end,{fadeOutSeconds:fade}); await engine.preparePosition(start); };
  return { engine, audio, advance, ready, load, get preparations() { return preparations; } };
}
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7, `${a} != ${b}`);

test('trim completion fades before its source end, pauses at the trim endpoint, and emits once', async () => {
  const s=setup();await s.ready();let events=0,detail;s.engine.on('segmentend',value=>{events++;detail=value;});
  await s.engine.play();s.advance(6000);assert.equal(s.engine.segmentEnding,false);close(s.audio.volume,.8);
  s.advance(1000);assert.equal(s.engine.segmentEnding,true);close(s.engine.currentTime,9);
  s.advance(500);close(s.audio.volume,.4);assert.equal(events,0);
  s.advance(500);assert.equal(events,1);assert.equal(s.engine.state,'segment-ended');assert.equal(s.audio.paused,true);close(s.engine.currentTime,10);assert.equal(s.audio.volume,0);
  assert.equal(detail.reason,'playback-range');assert.equal(detail.range.start,2);assert.equal(detail.range.end,10);
  s.audio.finish();s.advance(5000);assert.equal(events,1);s.engine.dispose();
});

test('manual stop cancels auto-next but retains the configured trim for a later manual play', async()=>{
  const s=setup();await s.ready();let events=0;s.engine.on('segmentend',()=>events++);await s.engine.play();s.advance(7300);
  const stopped=s.engine.stop();s.advance(1000);await stopped;s.advance(20000);assert.equal(events,0);close(s.engine.currentTime,2);assert.equal(s.engine.playbackRange.enabled,true);
  await s.engine.play();s.advance(8000);assert.equal(events,1);s.engine.dispose();
});

test('manual pause cancels a pending auto completion; resumed playback completes only its new pass', async()=>{
  const s=setup();await s.ready();let events=0;s.engine.on('segmentend',()=>events++);await s.engine.play();s.advance(7200);
  const paused=s.engine.pause();s.advance(1000);assert.equal(await paused,true);s.advance(10000);assert.equal(events,0);assert.equal(s.audio.paused,true);
  await s.engine.play();close(s.engine.currentTime,2);s.advance(8001);assert.equal(events,1);s.engine.dispose();
});

test('manual pause and stop cap their long fade at the remaining trim time without auto-next', async()=>{
  for (const action of ['pause','stop']) for (const rate of [1,.8]) {
    const s=setup();await s.ready();s.engine.setRate(rate);let events=0;s.engine.on('segmentend',()=>events++);await s.engine.play();
    s.advance(7.95/rate*1000);const position=s.engine.currentTime,stopped=s.engine[action]();
    close(s.engine._ramp.endAt-s.engine._ramp.startAt,(10-position)/rate);
    s.advance(70);assert.equal(s.audio.paused,true);assert.ok(s.engine.currentTime<=10+1e-7);assert.equal(await stopped,true);assert.equal(s.audio.volume,0);assert.equal(events,0);
    if(action==='stop')close(s.engine.currentTime,2);else close(s.engine.currentTime,10);
    s.advance(2000);assert.equal(events,0);s.engine.dispose();
  }
});

test('seeking past a trim endpoint silences immediately and does not turn a manual pause into auto-next', async()=>{
  for (const pausing of [false,true]) {
    const s=setup();await s.ready();let events=0;s.engine.on('segmentend',()=>events++);await s.engine.play();s.advance(5000);
    const paused=pausing?s.engine.pause():null;s.engine.seek(20);
    assert.equal(s.audio.paused,true);assert.equal(s.audio.volume,0);close(s.engine.currentTime,10);assert.equal(events,pausing?0:1);
    s.advance(1000);if(paused)assert.equal(await paused,true);assert.equal(events,pausing?0:1);s.engine.dispose();
  }
});

test('a rate-change fade that reaches the trim endpoint completes once instead of replaying its head', async()=>{
  const s=setup();await s.ready();let events=0;s.engine.on('segmentend',()=>events++);await s.engine.play();s.advance(7980);
  const changed=s.engine.changeRate(.8);s.advance(30);assert.equal(await changed,true);assert.equal(events,1);assert.equal(s.engine.state,'segment-ended');close(s.engine.currentTime,10);assert.equal(s.audio.paused,true);assert.equal(s.audio.volume,0);assert.equal(s.audio.plays,1);s.engine.dispose();
});

test('replay after a trimmed native file end starts at the head trim even before the ended flag clears', async()=>{
  const s=setup({duration:3});await s.ready(2,3,0);await s.engine.play();s.audio.finish();assert.equal(s.engine.state,'segment-ended');
  await s.engine.play();close(s.engine.currentTime,2);assert.equal(s.engine.isPlaying,true);s.engine.dispose();
});

test('seeking cancels an old fade completion and reschedules the same trim at the new position', async()=>{
  const s=setup();await s.ready();let events=0;s.engine.on('segmentend',()=>events++);await s.engine.play();s.advance(7300);assert.equal(s.engine.segmentEnding,true);
  s.engine.seek(4);s.advance(700);assert.equal(events,0);close(s.engine.currentTime,4.7);s.advance(5300);assert.equal(events,1);close(s.engine.currentTime,10);s.engine.dispose();
});

test('0.8x rate changes recalculate pre-end fade in wall seconds without losing the trim', async()=>{
  const s=setup();await s.ready();let events=0;s.engine.on('segmentend',()=>events++);await s.engine.play();s.advance(5000);
  const changed=s.engine.changeRate(.8);s.advance(50);assert.equal(await changed,true);close(s.engine.currentTime,7.05);
  s.advance(2687.5);assert.equal(s.engine.segmentEnding,true);close(s.engine.currentTime,9.2);s.advance(500);close(s.audio.volume,.4);assert.equal(events,0);s.advance(500);assert.equal(events,1);s.engine.dispose();
});

test('range fade is capped at half the trimmed wall duration and native file end cannot duplicate completion', async()=>{
  const s=setup({duration:3});await s.ready(2,3,5);let events=0;s.engine.on('segmentend',()=>events++);await s.engine.play();s.advance(499);assert.equal(s.engine.segmentEnding,false);s.advance(1);assert.equal(s.engine.segmentEnding,true);
  close(s.engine._ramp.endAt-s.engine._ramp.startAt,.5);s.audio.finish();assert.equal(events,1);s.advance(500);assert.equal(events,1);s.engine.dispose();
});

test('single-track loop takes priority, while disabled range leaves ordinary lesson playback unchanged', async()=>{
  const s=setup();await s.ready();let events=0;s.engine.on('segmentend',()=>events++);s.engine.setLoop(2,10,true);await s.engine.play();s.advance(8000);assert.equal(events,0);assert.equal(s.engine.segmentEnding,false);close(s.engine.currentTime,2);
  s.engine.setLoop(2,10,false);s.engine.clearPlaybackRange();s.advance(10000);assert.equal(events,0);assert.equal(s.engine.isPlaying,true);s.engine.dispose();
});

test('source load/disposal cancels a pending trim completion and preprepared PCM avoids another decode', async()=>{
  const s=setup();await s.ready();let events=0;s.engine.on('segmentend',()=>events++);await s.engine.play();s.advance(7200);
  const count=s.preparations,prepared={blob:new Blob(['prepared-pcm'],{type:'audio/wav'}),mode:'decoded-pcm',precise:true};
  await s.load({prepared});assert.equal(s.preparations,count);assert.equal(s.engine.sourcePreparation.mode,'decoded-pcm');assert.equal(s.engine.playbackRange.enabled,false);s.advance(2000);assert.equal(events,0);
  s.engine.setPlaybackRange(2,10,{fadeOutSeconds:1});await s.engine.preparePosition(2);await s.engine.play();s.advance(7200);s.engine.dispose();s.advance(10000);assert.equal(events,0);
});
