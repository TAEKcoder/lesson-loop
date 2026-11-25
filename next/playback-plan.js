/** Pure playback planning. All boundaries are absolute seconds in the untouched source file. */
const MIN_RANGE = 0.1;
const EPSILON = 0.01;

const invalid = (reason, warning) => ({ valid: false, start: null, end: null, warning, reason, trimmed: false, clipped: false });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readRange(range, duration) {
  if (!isRecord(range) || typeof range.start !== 'number' || !Number.isFinite(range.start) || range.start < 0 ||
      (range.end !== null && (typeof range.end !== 'number' || !Number.isFinite(range.end)))) return null;
  const end = range.end === null ? duration : range.end;
  if (range.start >= duration || end > duration + EPSILON || Math.min(end, duration) - range.start < MIN_RANGE - 1e-9) return null;
  // Tolerate codec metadata rounding only; out-of-file user input is otherwise rejected.
  return { start: range.start, end: Math.min(end, duration) };
}

/**
 * Return {valid,start,end,warning,reason,trimmed,clipped}.
 * Invalid ranges have null bounds and must not be passed to a player.
 * Lesson ranges intersect the selected week with the trim; warmup ranges use the trim alone.
 */
export function effectivePlaybackRange(song, mode, selectedWeek, duration) {
  if (!isRecord(song)) return invalid('missing-track', '재생할 곡을 선택해 주세요.');
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < MIN_RANGE) {
    return invalid('missing-duration', '음원을 불러온 뒤 재생 구간을 확인해 주세요.');
  }
  const trim = readRange(song.trim === undefined ? { start: 0, end: null } : song.trim, duration);
  if (!trim) return invalid('invalid-trim', '음원 다듬기 구간이 올바르지 않거나 곡 길이를 벗어났습니다. 다듬기 시간을 확인해 주세요.');
  const trimmed = trim.start > 0 || trim.end < duration;
  if (mode === 'warmup') return { valid: true, ...trim, warning: '', reason: null, trimmed, clipped: false };
  if (mode !== 'lesson') return invalid('invalid-mode', '재생할 수업 또는 준비운동곡을 선택해 주세요.');
  if (!Number.isInteger(selectedWeek) || selectedWeek < 0 || selectedWeek > 3 || !Array.isArray(song.weeks)) {
    return invalid('invalid-week', '1~4주차 중 재생할 주차를 선택해 주세요.');
  }
  const source = readRange(song.weeks[selectedWeek], duration);
  if (!source) return invalid('invalid-week', '이 주차의 구간이 올바르지 않거나 곡 길이를 벗어났습니다. 주차 시간을 확인해 주세요.');
  const start = Math.max(source.start, trim.start), end = Math.min(source.end, trim.end);
  if (end - start < MIN_RANGE - 1e-9) {
    return invalid('outside-trim', '이 주차 구간과 음원 다듬기 구간이 겹치지 않습니다. 주차 시간이나 다듬기 시간을 확인해 주세요.');
  }
  const clipped = start !== source.start || end !== source.end;
  return { valid: true, start, end, warning: clipped ? '다듬기 범위와 겹치는 구간만 재생합니다. 주차 시간은 원본 기준으로 유지됩니다.' : '', reason: null, trimmed, clipped };
}

/**
 * Select a different connected warmup track in saved list order; null means stop.
 * connectedIds (Set or array), when supplied, is authoritative over stale hasAudio flags.
 * Auto-next is a caller policy; this helper also serves manual next/previous buttons.
 * Repeat-all intentionally returns the current track when it is the only connected song.
 */
export function nextWarmup(library, currentId, direction = 1, { connectedIds } = {}) {
  const tracks = Array.isArray(library?.warmupTracks) ? library.warmupTracks : [];
  if (!tracks.length) return null;
  const step = direction === 'previous' || direction === 'prev' || direction === -1 ? -1
    : direction === 'next' || direction === 1 ? 1 : 0;
  if (!step) return null;
  const connected = connectedIds instanceof Set ? connectedIds : Array.isArray(connectedIds) ? new Set(connectedIds) : null;
  const playable = track => isRecord(track) && typeof track.id === 'string' && track.id !== currentId &&
    (connected ? connected.has(track.id) : track.hasAudio === true);
  const current = tracks.findIndex(track => track?.id === currentId);
  if (current === -1) {
    const candidates = step > 0 ? tracks : [...tracks].reverse();
    return candidates.find(playable) || null;
  }
  const wrap = library?.settings?.warmupListRepeat === true;
  for (let distance = 1; distance < tracks.length; distance++) {
    let index = current + distance * step;
    if (index < 0 || index >= tracks.length) {
      if (!wrap) return null;
      index = (index % tracks.length + tracks.length) % tracks.length;
    }
    if (playable(tracks[index])) return tracks[index];
  }
  if (wrap) {
    const connectedTracks = tracks.filter(track => isRecord(track) && typeof track.id === 'string' &&
      (connected ? connected.has(track.id) : track.hasAudio === true));
    if (connectedTracks.length === 1 && connectedTracks[0].id === currentId) return connectedTracks[0];
  }
  return null;
}
