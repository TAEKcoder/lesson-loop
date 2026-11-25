/** Browser-local source preparation. Original files are never changed or uploaded.
 * Compressed native seeks may land on an earlier decoder frame. Decode once and
 * retain those Float32 samples in a WAV backing so subsequent seeks are PCM based.
 */
const DEFAULT_MAX_PCM_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 32 * 1024 * 1024;
const aborted = signal => { if (signal?.aborted) throw new DOMException('Audio preparation was superseded.', 'AbortError'); };
const text = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));

export function detectMp3SampleRate(bytes) {
  let start = 0;
  if (text(bytes, 0, 3) === 'ID3' && bytes.length >= 10) {
    const size = ((bytes[6] & 127) << 21) | ((bytes[7] & 127) << 14) | ((bytes[8] & 127) << 7) | (bytes[9] & 127);
    start = 10 + size + ((bytes[5] & 16) ? 10 : 0);
  }
  for (let i = start; i + 4 <= bytes.length; i++) {
    if (bytes[i] !== 255 || (bytes[i + 1] & 224) !== 224) continue;
    const version = (bytes[i + 1] >> 3) & 3, layer = (bytes[i + 1] >> 1) & 3;
    const rateIndex = (bytes[i + 2] >> 2) & 3, bitRateIndex = bytes[i + 2] >> 4;
    if (version === 1 || layer === 0 || rateIndex === 3 || bitRateIndex === 0 || bitRateIndex === 15) continue;
    return [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  }
  return null;
}

function waveFormat(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 12; at + 24 <= bytes.length;) {
    const length = view.getUint32(at + 4, true);
    if (text(bytes, at, 4) === 'fmt ' && length >= 16) {
      const tag = view.getUint16(at + 8, true);
      const subTag = tag === 0xfffe && length >= 40 && at + 48 <= bytes.length ? view.getUint16(at + 32, true) : tag;
      return { pcm: subTag === 1 || subTag === 3, sampleRate: view.getUint32(at + 12, true) };
    }
    const next = at + 8 + length + (length & 1);
    if (next <= at) break;
    at = next;
  }
  return null;
}

function sampleRateHint(bytes, format) {
  if (format === 'wav') return waveFormat(bytes)?.sampleRate || null;
  if (format === 'mp3') return detectMp3SampleRate(bytes);
  if (format === 'aac' && bytes.length >= 4 && bytes[0] === 255 && (bytes[1] & 246) === 240) {
    return [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][(bytes[2] >> 2) & 15] || null;
  }
  if (format === 'ogg') {
    for (let i = 0; i + 16 < bytes.length; i++) {
      if (text(bytes, i, 8) === 'OpusHead') return 48000;
      if (bytes[i] === 1 && text(bytes, i + 1, 6) === 'vorbis') return new DataView(bytes.buffer, bytes.byteOffset + i + 12, 4).getUint32(0, true);
    }
  }
  if (format === 'm4a') {
    for (let i = 4; i + 32 < bytes.length; i++) {
      if (text(bytes, i, 4) === 'mp4a') {
        const rate = new DataView(bytes.buffer, bytes.byteOffset + i + 28, 4).getUint32(0, false) >>> 16;
        if (rate >= 8000 && rate <= 192000) return rate;
      }
    }
  }
  return null;
}

function sourceFormat(blob, bytes) {
  if (text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WAVE') return 'wav';
  if (text(bytes, 0, 4) === 'fLaC') return 'flac';
  if (text(bytes, 0, 4) === 'OggS') return 'ogg';
  if (text(bytes, 4, 4) === 'ftyp') return 'm4a';
  const type = String(blob.type || '').toLowerCase(), name = String(blob.name || '').toLowerCase();
  if (/mpeg|mp3/.test(type) || /\.mp3$/.test(name) || text(bytes, 0, 3) === 'ID3') return 'mp3';
  if (/aac/.test(type) || /\.aac$/.test(name)) return 'aac';
  if (/mp4|m4a/.test(type) || /\.m4a$/.test(name)) return 'm4a';
  if (/ogg|opus/.test(type) || /\.(ogg|opus)$/.test(name)) return 'ogg';
  if (/webm/.test(type) || /\.webm$/.test(name)) return 'webm';
  if (detectMp3SampleRate(bytes)) return 'mp3';
  return 'native';
}

function durationProbe(blob, signal) {
  if (typeof Audio !== 'function') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.muted = true;
    audio.preload = 'metadata';
    const url = URL.createObjectURL(blob);
    let finished = false;
    const clean = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      audio.removeEventListener('loadedmetadata', loaded);
      audio.removeEventListener('error', failed);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };
    const finish = (value, error) => { if (finished) return; finished = true; clean(); error ? reject(error) : resolve(value); };
    const loaded = () => finish(Number.isFinite(audio.duration) ? audio.duration : null);
    const failed = () => finish(null);
    const cancel = () => finish(null, new DOMException('Audio preparation was superseded.', 'AbortError'));
    const timer = setTimeout(() => finish(null), 8000);
    audio.addEventListener('loadedmetadata', loaded);
    audio.addEventListener('error', failed);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    audio.src = url;
    audio.load();
  });
}

/** Encode the browser-decoded samples without integer quantization or lossy encoding. */
export async function encodeFloat32Wave(buffer, options = {}) {
  const channels = buffer.numberOfChannels, frames = buffer.length, sampleRate = buffer.sampleRate;
  const dataBytes = frames * channels * 4, headerBytes = 58;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > (options.maxPcmBytes ?? DEFAULT_MAX_PCM_BYTES) || dataBytes + headerBytes > 0xffffffff) {
    throw new RangeError('Decoded audio is too large for a local PCM backing.');
  }
  const result = new ArrayBuffer(headerBytes + dataBytes), view = new DataView(result);
  const put = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  put(0, 'RIFF'); view.setUint32(4, result.byteLength - 8, true); put(8, 'WAVE');
  put(12, 'fmt '); view.setUint32(16, 18, true); view.setUint16(20, 3, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 4, true); view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true); view.setUint16(36, 0, true);
  put(38, 'fact'); view.setUint32(42, 4, true); view.setUint32(46, frames, true);
  put(50, 'data'); view.setUint32(54, dataBytes, true);
  const samples = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  for (let base = 0; base < frames; base += 262144) {
    aborted(options.signal);
    const end = Math.min(frames, base + 262144);
    for (let frame = base; frame < end; frame++) for (let channel = 0; channel < channels; channel++) {
      view.setFloat32(headerBytes + (frame * channels + channel) * 4, samples[channel][frame], true);
    }
    if (end < frames) await new Promise(resolve => setTimeout(resolve, 0));
  }
  aborted(options.signal);
  return new Blob([result], { type: 'audio/wav' });
}

export async function prepareAudioForPlayback(blob, options = {}) {
  const native = (format, reason, precise = false) => ({ blob, mode: 'native', format, reason, precise });
  aborted(options.signal);
  const bytes = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
  aborted(options.signal);
  const format = sourceFormat(blob, bytes);
  if (format === 'wav' && waveFormat(bytes)?.pcm) return native(format, 'pcm-source', true);
  if (format === 'flac' || format === 'native') return native(format, 'original-source');
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!options.decode && !Offline) return native(format, 'decoder-unavailable');
  if (blob.size > (options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES)) return native(format, 'input-memory-limit');
  const sampleRate = sampleRateHint(bytes, format) || 48000;
  const maxPcmBytes = options.maxPcmBytes ?? DEFAULT_MAX_PCM_BYTES;
  const duration = await (options.probe || durationProbe)(blob, options.signal);
  aborted(options.signal);
  if (Number.isFinite(duration) && duration * sampleRate * 2 * 4 > maxPcmBytes) return native(format, 'decoded-memory-limit');
  try {
    const input = await blob.arrayBuffer();
    aborted(options.signal);
    const decoded = options.decode ? await options.decode(input, sampleRate) : await new Offline(1, 1, sampleRate).decodeAudioData(input);
    aborted(options.signal);
    const backing = await encodeFloat32Wave(decoded, { signal: options.signal, maxPcmBytes });
    return { blob: backing, mode: 'decoded-pcm', precise: true, format, sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels, frames: decoded.length };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return native(format, error instanceof RangeError ? 'decoded-memory-limit' : 'native-decode-fallback');
  }
}
