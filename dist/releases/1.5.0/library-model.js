/** Library migrations are additive. Existing lesson tracks, ranges and audio IDs stay intact. */
export function normalizeLibrary(library) {
  if (!isRecord(library)) throw new Error('수업 정보를 읽을 수 없습니다.');
  if (!Array.isArray(library.warmupTracks)) library.warmupTracks = [];
  if (!['lesson', 'warmup'].includes(library.playbackMode)) library.playbackMode = 'lesson';
  const selected = library.warmupTracks.find(track => track?.id === library.selectedWarmupTrack);
  library.selectedWarmupTrack = selected?.id ?? library.warmupTracks[0]?.id ?? null;
  if (!isRecord(library.settings)) library.settings = {};
  library.settings.warmupRepeat = library.settings.warmupRepeat === true;
  library.settings.warmupAutoNext = library.settings.warmupAutoNext !== false;
  library.settings.warmupListRepeat = library.settings.warmupListRepeat === true;
  const outputGain = Number(library.settings.outputGainDb);
  library.settings.outputGainDb = [0, 1, 2, 3].includes(outputGain) ? outputGain : 0;
  // Speed changes are session controls: reopening or restoring always starts at original speed.
  library.settings.rate = 1;
  // Trims use original-source timestamps. In particular, never subtract the head trim from weeks.
  for (const track of allLibraryTracks(library)) {
    if (!isRecord(track)) continue;
    if (track.trim === undefined) track.trim = { start: 0, end: null };
    else if (isRecord(track.trim)) {
      if (track.trim.start === undefined) track.trim.start = 0;
      if (track.trim.end === undefined) track.trim.end = null;
    }
    // Explicitly malformed stored trims remain detectable by effectivePlaybackRange.
  }
  return library;
}

/** Shared warmup songs participate in the same original-blob backup as lesson songs. */
export function allLibraryTracks(library) {
  const lessons = Array.isArray(library?.teachers)
    ? library.teachers.flatMap(teacher => Array.isArray(teacher?.tracks) ? teacher.tracks : [])
    : [];
  return [...lessons, ...(Array.isArray(library?.warmupTracks) ? library.warmupTracks : [])];
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value) {
  return value === undefined || value === null || typeof value === 'string';
}

/** Validate old and new version-1 backups without changing their data. */
export function validateBackup(value) {
  if (!isRecord(value) || value.type !== 'lessonloop-backup' || value.version !== 1 ||
      !isRecord(value.library) || !Array.isArray(value.library.teachers) ||
      !value.library.teachers.length || value.library.teachers.length > 200) {
    throw new Error('Lesson Loop 백업 파일이 아닙니다.');
  }
  const ids = new Set();
  const songIds = new Set();
  const claimId = (id, message) => {
    if (typeof id !== 'string' || !id.trim() || ids.has(id)) throw new Error(message);
    ids.add(id);
  };
  const checkSong = (song, isWarmup = false) => {
    const message = isWarmup ? '백업의 준비운동곡 정보를 확인해 주세요.' : '백업의 곡 정보를 확인해 주세요.';
    if (!isRecord(song) || typeof song.title !== 'string' || !optionalText(song.artist) ||
        !optionalText(song.fileName) || !optionalText(song.expectedFile)) throw new Error(message);
    claimId(song.id, message);
    songIds.add(song.id);
    if (song.trim !== undefined && (!isRecord(song.trim) ||
        typeof song.trim.start !== 'number' || !Number.isFinite(song.trim.start) || song.trim.start < 0 ||
        (song.trim.end !== null && (typeof song.trim.end !== 'number' || !Number.isFinite(song.trim.end) ||
        song.trim.end - song.trim.start < 0.1 - 1e-9)))) {
      throw new Error('백업의 음원 다듬기 구간을 확인해 주세요.');
    }
    if (isWarmup) return;
    if (!Array.isArray(song.weeks) || song.weeks.length !== 4) throw new Error(message);
    for (const week of song.weeks) {
      if (!isRecord(week) || typeof week.start !== 'number' || !Number.isFinite(week.start) ||
          week.start < 0 || (week.end !== null && (typeof week.end !== 'number' ||
          !Number.isFinite(week.end) || week.end - week.start < 0.1))) {
        throw new Error('백업의 주차 구간을 확인해 주세요.');
      }
    }
  };
  for (const teacher of value.library.teachers) {
    if (!isRecord(teacher) || typeof teacher.name !== 'string' || !optionalText(teacher.schedule) ||
        !Array.isArray(teacher.tracks) || teacher.tracks.length > 500) {
      throw new Error('백업의 수업 정보를 확인해 주세요.');
    }
    claimId(teacher.id, '백업의 수업 정보를 확인해 주세요.');
    for (const song of teacher.tracks) checkSong(song);
  }
  if (value.library.warmupTracks !== undefined) {
    if (!Array.isArray(value.library.warmupTracks) || value.library.warmupTracks.length > 500) {
      throw new Error('백업의 준비운동곡 정보를 확인해 주세요.');
    }
    for (const song of value.library.warmupTracks) checkSong(song, true);
  }
  if (value.audio !== undefined && !Array.isArray(value.audio)) {
    throw new Error('백업 음원 정보가 올바르지 않습니다.');
  }
  const embeddedIds = new Set();
  for (const audio of value.audio || []) {
    if (!isRecord(audio) || !songIds.has(audio.id) || embeddedIds.has(audio.id) ||
        typeof audio.data !== 'string' || !/^data:[^,]*;base64,[A-Za-z0-9+/=]+$/.test(audio.data) ||
        !optionalText(audio.name) || !optionalText(audio.type)) {
      throw new Error('백업 음원 데이터를 확인해 주세요.');
    }
    embeddedIds.add(audio.id);
  }
  return value;
}
