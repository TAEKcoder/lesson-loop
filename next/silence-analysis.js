/** Conservative head/tail suggestions only. The caller must ask the user to Save a trim. */
const DEFAULT_THRESHOLD_DB = -72;

function problem(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * channels: a Float32Array (mono) or an array of equally sized channel arrays.
 * Returns absolute source-second candidates, with 50ms of sound-edge context by default.
 * Peak OR low RMS counts as audio, so quiet sustained attacks are retained conservatively.
 */
export function detectSilence(channels, sampleRate, options = {}) {
  if (ArrayBuffer.isView(channels) || (Array.isArray(channels) && typeof channels[0] === 'number')) channels = [channels];
  if (!Array.isArray(channels) || !channels.length || !channels[0]?.length ||
      !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw problem('분석할 음원 샘플을 읽을 수 없습니다.', 'INVALID_SAMPLES');
  }
  const length = channels[0].length;
  if (!channels.every(channel => channel && channel.length === length)) throw problem('음원 채널 길이가 올바르지 않습니다.', 'INVALID_SAMPLES');
  const thresholdDb = options.thresholdDb ?? DEFAULT_THRESHOLD_DB;
  const padding = options.padding ?? 0.05;
  const minSilence = options.minSilence ?? 0.12;
  if (!Number.isFinite(thresholdDb) || thresholdDb < -120 || thresholdDb > -20 ||
      !Number.isFinite(padding) || padding < 0 || padding > 5 ||
      !Number.isFinite(minSilence) || minSilence < 0 || minSilence > 60) {
    throw problem('무음 분석 설정을 확인해 주세요.', 'INVALID_OPTIONS');
  }
  const peakThreshold = 10 ** (thresholdDb / 20);
  const rmsThreshold = peakThreshold * 0.25;
  const window = Math.max(1, Math.round(sampleRate * 0.01));
  let first = null, last = null;
  for (let start = 0; start < length; start += window) {
    const end = Math.min(length, start + window);
    let active = false;
    for (const channel of channels) {
      let square = 0, peak = 0;
      for (let i = start; i < end; i++) {
        const sample = channel[i];
        if (!Number.isFinite(sample)) throw problem('음원에 올바르지 않은 샘플이 있어 분석할 수 없습니다.', 'INVALID_SAMPLES');
        square += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      if (peak >= peakThreshold || Math.sqrt(square / (end - start)) >= rmsThreshold) active = true;
    }
    if (active) { if (first === null) first = start; last = end; }
  }
  if (first === null) throw problem('음원 전체가 무음이거나 소리가 너무 작아 자동으로 구간을 정할 수 없습니다. 직접 시간을 입력해 주세요.', 'ALL_SILENCE');
  const duration = length / sampleRate;
  const headSilence = first / sampleRate;
  const tailSilence = (length - last) / sampleRate;
  let start = headSilence >= minSilence ? Math.max(0, headSilence - padding) : 0;
  let end = tailSilence >= minSilence ? Math.min(duration, last / sampleRate + padding) : duration;
  // Preserve a usable context around an isolated transient as well as normal music.
  if (end - start < Math.min(0.1, duration)) {
    const center = (start + end) / 2;
    start = Math.max(0, Math.min(center - 0.05, duration - 0.1));
    end = Math.min(duration, Math.max(center + 0.05, 0.1));
  }
  return { start, end, duration, headSilence, tailSilence, padding, thresholdDb, changed: start > 0 || end < duration };
}

/** Decode into an offline context, never into or through the real-time output route. */
export async function analyzeSilence(blob, options = {}) {
  const checkAbort = () => { if (options.signal?.aborted) throw new DOMException('분석을 취소했습니다.', 'AbortError'); };
  checkAbort();
  if (!blob || !blob.size || typeof blob.arrayBuffer !== 'function') throw problem('분석할 음원을 연결해 주세요.', 'MISSING_AUDIO');
  if (blob.size > (options.maxBytes ?? 512 * 1024 * 1024)) {
    throw problem('음원이 커서 자동 분석을 생략했습니다. 원본을 유지한 채 다듬기 시간을 직접 입력해 주세요.', 'FILE_TOO_LARGE');
  }
  const OfflineContext = options.OfflineAudioContext || globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineContext) throw problem('이 브라우저는 자동 무음 분석을 지원하지 않습니다. 다듬기 시간을 직접 입력해 주세요.', 'UNSUPPORTED');
  let decoded;
  try {
    const context = new OfflineContext(2, 1, 22050);
    const input = await blob.arrayBuffer();
    checkAbort();
    decoded = await context.decodeAudioData(input);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw problem('이 음원의 자동 분석을 완료하지 못했습니다. 원본을 유지한 채 다듬기 시간을 직접 입력해 주세요.', 'DECODE_FAILED');
  }
  checkAbort();
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
  return detectSilence(channels, decoded.sampleRate, options);
}
