import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMp3SampleRate, encodeFloat32Wave, prepareAudioForPlayback } from './next/audio-source.js';

const fakeBuffer = (samples = [[0, 0.25, -0.5], [0.75, -1, 1.25]], sampleRate = 44100) => ({
  numberOfChannels: samples.length, length: samples[0].length, sampleRate,
  getChannelData: channel => Float32Array.from(samples[channel]),
});
const mp3 = () => new Blob([Uint8Array.of(255, 251, 144, 0)], { type: 'audio/mpeg' });

test('Float32 WAV stores the decoded channel samples exactly, with source rate and fact frame count', async () => {
  const blob = await encodeFloat32Wave(fakeBuffer());
  const view = new DataView(await blob.arrayBuffer());
  const ascii = (at, n) => String.fromCharCode(...new Uint8Array(view.buffer, at, n));
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(view.getUint16(20, true), 3);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(34, true), 32);
  assert.equal(ascii(38, 4), 'fact');
  assert.equal(view.getUint32(46, true), 3);
  assert.equal(ascii(50, 4), 'data');
  assert.deepEqual(Array.from({length: 6}, (_, i) => view.getFloat32(58 + i * 4, true)), [0, 0.75, 0.25, -1, -0.5, 1.25]);
});

test('MP3 source-rate parser skips ID3 and preserves MPEG1 and MPEG2 sample rates', () => {
  const tagged = Uint8Array.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 2, 0, 0, 255, 251, 144, 0]);
  assert.equal(detectMp3SampleRate(tagged), 44100);
  assert.equal(detectMp3SampleRate(Uint8Array.of(255, 251, 148, 0)), 48000);
  assert.equal(detectMp3SampleRate(Uint8Array.of(255, 243, 128, 0)), 22050);
  assert.equal(detectMp3SampleRate(Uint8Array.of(0, 0, 0, 0)), null);
});

test('compressed source is decoded once into PCM at its parsed source sample rate without changing original', async () => {
  const original = mp3();
  let calls = 0;
  const result = await prepareAudioForPlayback(original, { probe: async () => 1, decode: async (input, rate) => {
    calls++;
    assert.equal(rate, 44100);
    assert.equal(input.byteLength, original.size);
    return fakeBuffer();
  }});
  assert.equal(calls, 1);
  assert.equal(result.mode, 'decoded-pcm');
  assert.equal(result.precise, true);
  assert.equal(result.sampleRate, 44100);
  assert.equal(result.blob.type, 'audio/wav');
  assert.notEqual(result.blob, original);
  assert.deepEqual([...new Uint8Array(await original.arrayBuffer())], [255, 251, 144, 0]);
});

test('native WAV keeps its original bytes and preparation never invokes the compressed decoder', async () => {
  const original = await encodeFloat32Wave(fakeBuffer([[0, .25, -.5]], 96000));
  const result = await prepareAudioForPlayback(original, { decode: () => { throw new Error('must not decode'); } });
  assert.equal(result.blob, original);
  assert.equal(result.mode, 'native');
  assert.equal(result.precise, true);
});

test('memory bounds return an explicit native fallback before allocating the decoded PCM', async () => {
  const original = mp3();
  const result = await prepareAudioForPlayback(original, { maxPcmBytes: 100, probe: async () => 180, decode: () => { throw new Error('must not allocate'); } });
  assert.equal(result.blob, original);
  assert.equal(result.precise, false);
  assert.equal(result.reason, 'decoded-memory-limit');
});

test('canceled compressed decoding cannot produce a late playback backing', async () => {
  const controller = new AbortController();
  let finish;
  const pending = prepareAudioForPlayback(mp3(), { signal: controller.signal, probe: async () => 1, decode: () => new Promise(resolve => { finish = resolve; }) });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  finish(fakeBuffer());
  await assert.rejects(pending, { name: 'AbortError' });
});
