// Audio is kept as its original Blob. Nothing is transcoded or uploaded.
const DB_NAME = 'classroom-player-v1';
let dbPromise;

function storageError(error) {
  const message = error?.name === 'QuotaExceededError'
    ? '기기 저장 공간이 부족합니다. 사용하지 않는 곡을 지우거나 저장 공간을 확보해 주세요.'
    : error?.name === 'SecurityError' || error?.name === 'InvalidStateError'
      ? '이 브라우저에서 기기 저장소를 사용할 수 없습니다. 일반 브라우저 창에서 다시 열어 주세요.'
      : '기기에 저장하지 못했습니다. 브라우저의 저장 공간과 설정을 확인해 주세요.';
  return new Error(message, { cause: error });
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(storageError({ name: 'SecurityError' }));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    let finished = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('library')) db.createObjectStore('library');
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
    };
    request.onsuccess = () => {
      const db = request.result;
      if (finished) { db.close(); return; }
      finished = true;
      db.onversionchange = () => { db.close(); dbPromise = undefined; };
      resolve(db);
    };
    request.onerror = () => {
      if (finished) return;
      finished = true;
      reject(storageError(request.error));
    };
    request.onblocked = () => {
      if (finished) return;
      finished = true;
      reject(new Error('다른 창에서 저장소를 사용 중입니다. 플레이어의 다른 창을 닫고 다시 시도해 주세요.'));
    };
  }).catch(error => { dbPromise = undefined; throw error; });
  return dbPromise;
}

async function transaction(storeName, mode, operation) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let tx;
    let request;
    try {
      tx = db.transaction(storeName, mode);
      request = operation(tx.objectStore(storeName));
    } catch (error) {
      reject(storageError(error));
      return;
    }
    // Resolve only once the transaction commits, not merely when the request succeeds.
    tx.oncomplete = () => resolve(request?.result ?? null);
    tx.onabort = () => reject(storageError(tx.error || request?.error));
    tx.onerror = () => { /* The error aborts the transaction, handled above. */ };
  });
}

export const readLibrary = () => transaction('library', 'readonly', store => store.get('main'));
export const saveLibrary = library => transaction('library', 'readwrite', store => store.put(library, 'main'));
export const putAudio = (id, blob) => transaction('audio', 'readwrite', store => store.put(blob, id));
export const getAudio = id => transaction('audio', 'readonly', store => store.get(id));
export const deleteAudio = id => transaction('audio', 'readwrite', store => store.delete(id));

/** Restore settings and embedded originals together; quota errors roll back every overwrite. */
export async function restoreLibrary(library, audioEntries = []) {
  if (!library || !Array.isArray(audioEntries)) throw new TypeError('백업 데이터가 올바르지 않습니다.');
  for (const entry of audioEntries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || !entry.blob || typeof entry.blob.arrayBuffer !== 'function') {
      throw new TypeError('백업 음원 데이터가 올바르지 않습니다.');
    }
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(['library', 'audio'], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => { /* Do not prevent the default abort: both stores must roll back. */ };
      const audioStore = tx.objectStore('audio');
      for (const { id, blob } of audioEntries) audioStore.put(blob, id);
      // Keep existing blobs so settings-only backups can reconnect on this device.
      tx.objectStore('library').put(library, 'main');
    } catch (error) {
      try { tx?.abort(); } catch { /* It may already have aborted. */ }
      reject(storageError(error));
    }
  });
}

/** Parse seconds, m:ss(.sss), or h:mm:ss(.sss). Empty or invalid input returns null. */
export function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const parts = text.split(':');
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (!/^\d+$/.test(parts[0]) || !/^\d{1,2}(?:\.\d{1,3})?$/.test(parts.at(-1))) return null;
  const seconds = Number(parts.at(-1));
  if (seconds >= 60) return null;
  let total;
  if (parts.length === 2) {
    total = Number(parts[0]) * 60 + seconds;
  } else {
    if (!/^\d{1,2}$/.test(parts[1]) || Number(parts[1]) >= 60) return null;
    total = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + seconds;
  }
  return Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER ? total : null;
}

/** Display total minutes so classroom inputs have the same m:ss format at any length. */
export function formatTime(seconds, withFraction = false) {
  const safe = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
  if (withFraction) {
    const hundredths = Math.round(safe * 100);
    const minutes = Math.floor(hundredths / 6000);
    const rest = Math.floor(hundredths / 100) % 60;
    return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`;
  }
  const whole = Math.floor(safe);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** Read source metadata, never AudioContext's output sample rate. */
export async function inspectAudio(file) {
  const extension = String(file.name || '').split('.').at(-1)?.toUpperCase();
  const formats = new Set(['WAV', 'WAVE', 'FLAC', 'MP3', 'M4A', 'AAC', 'OGG', 'OPUS', 'AIFF', 'AIF', 'WEBM']);
  const info = { format: formats.has(extension) ? (extension === 'WAVE' ? 'WAV' : extension) : 'AUDIO' };
  const buffer = await file.slice(0, 1024 * 1024).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = ascii(bytes, 0, 4);
  if (['RIFF', 'RIFX', 'RF64'].includes(magic) && ascii(bytes, 8, 4) === 'WAVE') {
    info.format = 'WAV';
    const little = magic !== 'RIFX';
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = ascii(bytes, offset, 4);
      const length = view.getUint32(offset + 4, little);
      if (type === 'fmt ' && length >= 16 && offset + 24 <= bytes.length) {
        const channels = view.getUint16(offset + 10, little);
        const sampleRate = view.getUint32(offset + 12, little);
        const bitDepth = view.getUint16(offset + 22, little);
        if (channels) info.channels = channels;
        if (sampleRate) info.sampleRate = sampleRate;
        if (bitDepth) info.bitDepth = bitDepth;
        break;
      }
      const next = offset + 8 + length + (length % 2);
      if (next <= offset) break;
      offset = next;
    }
  } else if (magic === 'fLaC') {
    info.format = 'FLAC';
    for (let offset = 4; offset + 4 <= bytes.length;) {
      const type = bytes[offset] & 0x7f;
      const last = !!(bytes[offset] & 0x80);
      const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
      const start = offset + 4;
      if (type === 0 && length >= 34 && start + 34 <= bytes.length) {
        const sampleRate = (bytes[start + 10] << 12) | (bytes[start + 11] << 4) | (bytes[start + 12] >> 4);
        if (sampleRate) info.sampleRate = sampleRate;
        info.channels = ((bytes[start + 12] >> 1) & 7) + 1;
        info.bitDepth = (((bytes[start + 12] & 1) << 4) | (bytes[start + 13] >> 4)) + 1;
        break;
      }
      if (last || !length) break;
      offset = start + length;
    }
  } else if (ascii(bytes, 0, 3) === 'ID3' || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    if (!['AAC', 'M4A'].includes(info.format)) info.format = 'MP3';
  } else if (ascii(bytes, 0, 4) === 'OggS') {
    info.format = 'OGG';
  }
  return info;
}

/** Optional display-only waveform. Large source files keep playing without being decoded twice. */
export async function makePeaks(blob, bins = 200) {
  if (blob.size > 70 * 1024 * 1024) return null;
  const OfflineContext = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineContext) return null;
  try {
    const context = new OfflineContext(1, 1, 22050);
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const count = Math.max(8, Math.min(2000, Math.round(bins)));
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    const peaks = new Array(count).fill(0);
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * decoded.length / count);
      const end = Math.floor((i + 1) * decoded.length / count);
      // Sampling at most ~1000 points per bin bounds work on long songs.
      const stride = Math.max(1, Math.floor((end - start) / 1000));
      for (let p = start; p < end; p += stride) {
        for (const channel of channels) peaks[i] = Math.max(peaks[i], Math.abs(channel[p] || 0));
      }
    }
    return peaks;
  } catch {
    return null; // Unsupported waveform decoding must never prevent native media playback.
  }
}
