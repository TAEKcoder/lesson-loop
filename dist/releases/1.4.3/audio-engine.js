import { prepareAudioForPlayback } from './audio-source.js';
import { OutputStage } from './output-stage.js';
import { createNativeOutput, shouldUseNativeOutput } from './native-output.js';

/**
 * Original-file playback through HTMLAudioElement, with a Web Audio gain stage.
 * `on(type, callback)` passes event.detail and returns an unsubscribe function.
 * All times are source seconds. Volume is 0..1; fade duration is 0..10 seconds.
 * Looping follows browser media timing, not sample-accurate editing timing.
 */
export class AudioEngine extends EventTarget {
  constructor(options = {}) {
    super();
    this._outputMode = options.outputMode === 'native' || (options.outputMode !== 'webaudio' && !options.contextFactory && shouldUseNativeOutput()) ? 'native' : 'webaudio';
    this._nativeOutputFactory = options.nativeOutputFactory || createNativeOutput;
    this._nativeNow = options.nativeNow;
    this._rateChangeId = 0;
    this._mediaGeneration = 0;
    this._outputStageFactory = options.outputStageFactory || ((context, input, destination, stageOptions) => new OutputStage(context, input, destination, stageOptions));
    this._outputGainDb = 0;
    this._outputGeneration = 0;
    this._prepareAudio = options.prepareAudio || prepareAudioForPlayback;
    this._audioFactory = options.audioFactory || (() => new Audio());
    this.audio = options.audio || this._audioFactory();
    this._contextFactory = options.contextFactory || (() => {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) throw new Error('This browser does not support Web Audio.');
      return new Context();
    });
    this._raf = options.requestAnimationFrame || (fn => requestAnimationFrame(fn));
    this._caf = options.cancelAnimationFrame || (id => cancelAnimationFrame(id));
    this._setTimeout = options.setTimeout || globalThis.setTimeout.bind(globalThis);
    this._clearTimeout = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    this._urls = options.urls || URL;
    this._volume = 0.85;
    this._fade = 1;
    this._rate = 1;
    this._loop = { start: 0, end: 0, enabled: false };
    this._action = 0;
    this._playWaitId = 0;
    this._queuedPlay = false;
    this._loadId = 0;
    this._intent = false;
    this._state = 'empty';
    this._disposed = false;
    this._listeners = [];
    this._playedMedia = new WeakSet();
    this._configureAudio(this.audio);
    this._bindMediaListeners();
  }

  get state() { return this._state; }
  get queuedPlay() { return this._queuedPlay; }
  get isPlaying() { return !this.audio.paused && !this.audio.ended; }
  get fading() { return Boolean(this._ramp && this._context && this._context.currentTime < this._ramp.endAt); }
  /** Display-only master fade telemetry; this is not a signal/VU meter.
   * masterGain is the scheduled master GainNode value (0..1).
   * envelopeLevel is the normalized fade shape, including a visible envelope
   * while user volume is zero. progress follows AudioContext time, so it freezes
   * with a suspended context. No audio parameters are read back or changed.
   */
  get visualState() {
    const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    const now = this._context?.currentTime ?? 0;
    const ramp = this._ramp;
    const progress = ramp && ramp.endAt > ramp.startAt ? clamp((now - ramp.startAt) / (ramp.endAt - ramp.startAt)) : 1;
    const masterGain = ramp ? clamp(ramp.from + (ramp.to - ramp.from) * progress) : clamp(this._gain?.gain.value ?? 0);
    const visual = this._visualRamp;
    const envelopeLevel = visual ? clamp(visual.from + (visual.to - visual.from) * progress) : 0;
    const active = Boolean(ramp && now < ramp.endAt && ramp.endAt > ramp.startAt);
    const phase = active ? visual?.phase || 'idle' : 'idle';
    return { masterGain, envelopeLevel, phase, progress: phase === 'idle' ? 1 : progress, muted: this._volume === 0 || this.audio.muted === true };
  }
  get currentTime() { return this._positionHint !== null && this._positionHint !== undefined && this.audio.readyState < 1 ? this._positionHint : this.audio.currentTime || 0; }
  get duration() { return Number.isFinite(this.audio.duration) ? this.audio.duration : this._duration || 0; }
  get playbackRate() { return this._rate; }
  get sourcePreparation() { return this._sourcePreparation ? { ...this._sourcePreparation } : null; }
  get volume() { return this._volume; }
  get outputGainDb() { return this._outputGainDb; }
  get outputMode() { return this._outputMode; }
  get rateChanging() { return Boolean(this._rateRequest); }
  get fadeDuration() { return this._fade; }
  get loop() { return { ...this._loop }; }
  get snapshot() {
    return { state: this.state, isPlaying: this.isPlaying, fading: this.fading, visualState: this.visualState,
      sourcePreparation: this.sourcePreparation, queuedPlay: this.queuedPlay, currentTime: this.currentTime, duration: this.duration, playbackRate: this._rate,
      volume: this._volume, outputMode: this.outputMode, rateChanging: this.rateChanging, outputGainDb: this._outputGainDb, fadeDuration: this._fade, loop: this.loop };
  }

  on(type, callback) {
    const listener = event => callback(event.detail);
    this.addEventListener(type, listener);
    return () => this.removeEventListener(type, listener);
  }

  load(blob) {
    if (this._disposed) return Promise.reject(new Error('Audio engine has been disposed.'));
    if (!blob || typeof blob.arrayBuffer !== 'function' || !blob.size) {
      return Promise.reject(new TypeError('Please select a non-empty audio file.'));
    }
    this._cancelRateChange();
    this._cancelStop();
    this._cancelQueuedPlay();
    const loadId = ++this._loadId;
    this._action++;
    this._intent = false;
    this._cancelSeekWait?.();
    this._cancelPause();
    this._cancelLoad?.();
    this._stopTick();
    this._loopSeeking = false;
    this._cancelMediaWait?.();
    this._mediaReady = null;
    this._positionHint = null;
    this._duration = 0;
    this._sourcePreparation = null;
    const oldUrl = this._url;
    if (oldUrl) this._replaceAudio();
    this._url = null;
    if (oldUrl) this._urls.revokeObjectURL(oldUrl);
    this.audio.pause();
    this._rampTo(0, 0);
    this._loop = { start: 0, end: 0, enabled: false };
    this._setState('loading');
    const audio = this.audio;
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let canceled = false;
      const clean = () => {
        audio.removeEventListener('loadedmetadata', loaded);
        audio.removeEventListener('error', failed);
        if (loadId === this._loadId) this._cancelLoad = null;
      };
      const loaded = () => {
        if (canceled || loadId !== this._loadId || this._disposed || audio.readyState < 1 || !Number.isFinite(audio.duration)) return;
        clean();
        this._duration = audio.duration;
        this._applyRate(audio);
        if (!this._intent) this._setState('ready');
        this._emit('loaded');
        resolve(this.snapshot);
      };
      const failed = () => { if (this._outputMode === 'native' && !audio.error) return; clean(); reject(this._audioError()); };
      this._cancelLoad = () => {
        canceled = true;
        controller.abort();
        clean();
        reject(new DOMException('Audio loading was superseded.', 'AbortError'));
      };
      const install = result => {
        if (canceled || loadId !== this._loadId || this._disposed) return;
        const backing = result?.blob || result;
        if (!backing || typeof backing.arrayBuffer !== 'function') throw new TypeError('Audio preparation did not return an audio Blob.');
        const { blob: _ignored, ...info } = result?.blob ? result : { mode: 'native', precise: false };
        this._sourcePreparation = info;
        this._url = this._urls.createObjectURL(backing);
        audio.src = this._url;
        this._applyRate(audio);
        audio.addEventListener('loadedmetadata', loaded);
        audio.addEventListener('error', failed);
        audio.load();
      };
      const preparationFailed = error => {
        if (canceled || loadId !== this._loadId || this._disposed) return;
        clean();
        this._setState('error');
        this._emitError(error);
        reject(error);
      };
      try {
        const prepared = this._prepareAudio(blob, { signal: controller.signal });
        if (prepared && typeof prepared.then === 'function') prepared.then(install).catch(preparationFailed);
        else install(prepared);
      } catch (error) { preparationFailed(error); }
    });
  }

  async play(options = {}) {
    if (this._rateRequest && options.rateChangeId !== this._rateRequest.id) this._cancelRateChange();
    if (this._disposed || !this._url) return false;
    const playId = ++this._playWaitId;
    const pendingStop = this._stopRequest;
    let action;
    try {
      // Unlock the audio context in the click handler. Do not start or advance
      // the media until a prior stop has reached silence and its anchor seek.
      this._ensureContext();
      const resumed = ['suspended', 'interrupted'].includes(this._context.state) ? this._context.resume() : null;
      if (pendingStop) {
        this._queuedPlay = true;
        this._emit('statechange');
        const [stopped] = await Promise.all([pendingStop.promise, resumed || Promise.resolve()]);
        if (!stopped || playId !== this._playWaitId || this._disposed) return false;
      }
      this._queuedPlay = false;
      action = ++this._action;
      const fadeIn = options.fadeIn !== false;
      this._intent = true;
      this._cancelSeekWait?.();
      this._cancelPause();
      if (this.audio.paused && fadeIn) {
        this._rampTo(0, 0);
        if (this._playedMedia.has(this.audio) && !this._mediaReady) this._resetMediaAt(this.currentTime);
      }
      if (this._loop.enabled && (this.currentTime >= this._loop.end || this.currentTime < this._loop.start)) {
        this.audio.currentTime = this._loop.start;
      } else if (!this._loop.enabled && this.audio.ended && this.duration) this.audio.currentTime = 0;
      this._setState('starting');
      // A muted play used to run concurrently with seeking, consuming the start
      // of the selected phrase. Keep the media paused until positioning ends.
      if (!pendingStop && resumed) await resumed;
      if (this._mediaReady) await this._mediaReady;
      if (playId !== this._playWaitId || action !== this._action || !this._intent || this._disposed) return false;
      if (this.audio.seeking) await this._waitForSeek();
      if (playId !== this._playWaitId || action !== this._action || !this._intent || this._disposed) return false;
      if (this._outputPending) {
        let prepared;
        do { prepared = this._outputReady; await prepared; } while (prepared !== this._outputReady);
      }
      if (playId !== this._playWaitId || action !== this._action || !this._intent || this._disposed) return false;
      if (fadeIn && this.audio.paused && this._outputStage?.activeDb > 0) {
        this._outputStage.setMuted(this._volume === 0);
        await this._outputStage.flush();
        if (playId !== this._playWaitId || action !== this._action || !this._intent || this._disposed) return false;
      }
      this._applyRate(this.audio);
      await this.audio.play();
      if (playId !== this._playWaitId || action !== this._action || !this._intent || this._disposed) return false;
      this._playedMedia.add(this.audio);
      this._rampTo(this._volume, fadeIn ? (Number.isFinite(options.fadeSeconds) ? Math.max(0, Math.min(10, options.fadeSeconds)) : this._fade) : 0.005);
      this._setState('playing');
      this._startTick();
      return true;
    } catch (error) {
      if (playId !== this._playWaitId || (action !== undefined && action !== this._action) || this._disposed) return false;
      this._queuedPlay = false;
      // Context failure for a queued start must not interrupt the stop itself.
      if (pendingStop && this._stopRequest === pendingStop) {
        this._emitError(error);
        this._emit('statechange');
        return false;
      }
      this._intent = false;
      this._cancelSeekWait?.();
      this.audio.pause();
      this._rampTo(0, 0);
      this._setState('error');
      this._emitError(error);
      return false;
    }
  }

  /** Internal transport pause retains position and can reverse its fade. */
  pause() {
    this._cancelRateChange();
    this._cancelStop();
    this._cancelQueuedPlay();
    const prepared = this._mediaReady;
    const loadId = this._loadId;
    const paused = this._pause();
    const action = this._action;
    if (!prepared) return paused;
    return paused.then(async completed => {
      if (!completed) return false;
      try { await prepared; } catch { return false; }
      return !this._disposed && this._loadId === loadId && this._action === action;
    });
  }

  _pause(state = 'pausing', fadeSeconds = this._fade) {
    if (this._disposed) return Promise.resolve(false);
    const action = ++this._action;
    this._intent = false;
    this._cancelSeekWait?.();
    this._cancelPause();
    this._clearLoopTimer();
    if (this.audio.paused || !this._context || !fadeSeconds) {
      this.audio.pause();
      this._rampTo(0, 0);
      this._stopTick();
      this._setState(this._url ? (['stopping', 'changing-rate'].includes(state) ? state : 'paused') : 'empty');
      return Promise.resolve(true);
    }
    this._rampTo(0, fadeSeconds);
    this._setState(state);
    return new Promise(resolve => {
      const timer = this._setTimeout(() => {
        this._pendingPause = null;
        if (action !== this._action || this._disposed) { resolve(false); return; }
        this.audio.pause();
        this._rampTo(0, 0);
        this._stopTick();
        this._setState(['stopping', 'changing-rate'].includes(state) ? state : 'paused');
        resolve(true);
      }, fadeSeconds * 1000);
      this._pendingPause = { timer, resolve };
    });
  }

  /** Fade the current audio to silence, then position the paused media at start.
   * A play during this operation waits for the anchor; it never resumes the tail.
   */
  stop(start = this._loop.start) {
    const target = Number(start);
    if (this._disposed || !this._url || !this.duration || !Number.isFinite(target)) return Promise.resolve(false);
    this._cancelRateChange();
    this._cancelStop();
    this._cancelQueuedPlay();
    const request = { loadId: this._loadId, target: Math.max(0, Math.min(target, this.duration)) };
    request.promise = new Promise(resolve => { request.resolve = resolve; });
    this._stopRequest = request;
    this._pause('stopping').then(async paused => {
      if (!paused || this._stopRequest !== request || request.loadId !== this._loadId || this._disposed) return;
      try {
        await this._resetMediaAt(request.target);
        if (this._stopRequest !== request || request.loadId !== this._loadId || this._disposed) return;
        this._finishStop(request, true);
        this._setState('stopped');
        this._emit('timeupdate');
      } catch (error) {
        if (this._stopRequest !== request || this._disposed) return;
        this._finishStop(request, false);
        this._setState('error');
        this._emitError(error);
      }
    });
    return request.promise;
  }

  seek(seconds) {
    const time = Number(seconds);
    if (!Number.isFinite(time) || !this._url || !this.duration) return false;
    const target = Math.max(0, Math.min(time, this.duration));
    if (this.audio.paused && this._mediaReady) {
      this._positionHint = target;
      this._prepareTarget = target;
      if (this.audio.readyState >= 1) this.audio.currentTime = target;
      this._emit('timeupdate');
      return true;
    }
    if (this.audio.paused && this._playedMedia.has(this.audio)) {
      this._resetMediaAt(target).catch(error => {
        if (error.name !== 'AbortError' && !this._disposed) { this._setState('error'); this._emitError(error); }
      });
      return true;
    }
    this.audio.currentTime = target;
    this._loopSeeking = false;
    this._scheduleLoop();
    this._emit('timeupdate');
    return true;
  }

  /** Prepare a paused source fully before enabling its first user-gesture play. */
  async preparePosition(seconds) {
    const target = Number(seconds);
    if (this._disposed || !this._url || !this.duration || !Number.isFinite(target) || !this.audio.paused || this._stopRequest) return false;
    this._cancelRateChange();
    this._cancelQueuedPlay();
    this._intent = false;
    this._cancelPause();
    this._stopTick();
    this._rampTo(0, 0);
    const action = ++this._action, loadId = this._loadId;
    this._setState('positioning');
    try {
      await this._resetMediaAt(Math.max(0, Math.min(target, this.duration)));
      if (this._disposed || action !== this._action || loadId !== this._loadId) return false;
      this._setState('ready'); this._emit('timeupdate');
      return true;
    } catch (error) {
      if (this._disposed || action !== this._action || loadId !== this._loadId || error.name === 'AbortError') return false;
      this._setState('error'); this._emitError(error); return false;
    }
  }

  async restart(start = this._loop.start) {
    if (this.isPlaying || this._state === 'starting') {
      if (!await this.pause()) return false;
    }
    if (!this.seek(start)) return false;
    return this.play();
  }

  /** Change a running rate without changing WebKit's active decoder in place. */
  changeRate(rate) {
    const value = Number(rate);
    if (this._disposed || !Number.isFinite(value) || value < .25 || value > 4 || this._stopRequest) return Promise.resolve(false);
    const previous = this._rateRequest;
    const resume = previous?.resume === true || (this._intent && (this.isPlaying || this._state === 'starting'));
    if (!previous && (value === this._rate || !resume || !this._url)) return Promise.resolve(this.setRate(value));
    this._cancelRateChange();
    this._cancelQueuedPlay();
    const request = { id: ++this._rateChangeId, loadId: this._loadId, resume };
    request.promise = new Promise(resolve => { request.resolve = resolve; });
    this._rateRequest = request;
    const current = () => this._rateRequest === request && !this._disposed && this._loadId === request.loadId;
    (async () => {
      try {
        const paused = await this._pause('changing-rate', .05);
        if (!current()) return;
        if (!paused) { this._finishRateChange(request, false); return; }
        const position = this.currentTime;
        this.setRate(value);
        await this._resetMediaAt(position);
        if (!current()) return;
        if (request.resume) {
          const played = await this.play({ rateChangeId: request.id, fadeSeconds: .06 });
          if (!current()) return;
          this._finishRateChange(request, played);
        } else {
          this._setState('paused');
          this._finishRateChange(request, true);
        }
      } catch (error) {
        if (!current()) return;
        this._finishRateChange(request, false);
        if (error.name !== 'AbortError') { this._setState('error'); this._emitError(error); }
      }
    })();
    return request.promise;
  }

  _finishRateChange(request, completed) {
    if (this._rateRequest === request) { this._rateRequest = null; this._emit('statechange'); }
    request.resolve(completed);
  }
  _cancelRateChange() {
    if (this._rateRequest) this._finishRateChange(this._rateRequest, false);
  }

  setRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value) || value < 0.25 || value > 4) return false;
    this._rate = value;
    this._applyRate(this.audio);
    this.audio.preservesPitch = true;
    this._scheduleLoop();
    this._emit('ratechange');
    return true;
  }

  setVolume(volume) {
    const value = Number(volume);
    if (!Number.isFinite(value)) return false;
    this._volume = Math.max(0, Math.min(1, value));
    this.audio.muted = this._volume === 0;
    this._outputStage?.setMuted(this._volume === 0);
    if (this._intent && this.isPlaying) this._rampTo(this._volume, 0.06);
    this._emit('volumechange');
    return true;
  }

  /** Optional user-selected output trim. Zero dB remains a direct, unprocessed route. */
  setOutputGainDb(db) {
    const value = Number(db);
    if (!Number.isFinite(value) || value < 0 || value > 6 || this._disposed) return false;
    if (this._outputMode === 'native' && value > 0) {
      this._outputGainDb = 0;
      this._emit('outputgainchange');
      this._emitError(new Error('Safari 호환 출력에서는 추가 음량 보정을 사용할 수 없습니다. 원본 음량으로 재생합니다.'));
      return false;
    }
    if (value === this._outputGainDb && !this._outputPending) return true;
    this._outputGainDb = value;
    this._emit('outputgainchange');
    if (!this._context) return true;
    return this._queueOutputChange(value);
  }

  _queueOutputChange(value) {
    this._cancelOutputChange?.();
    const generation = ++this._outputGeneration;
    let cancel;
    const canceled = new Promise(resolve => { cancel = resolve; });
    const cancelChange = () => cancel(false);
    this._cancelOutputChange = cancelChange;
    this._outputPending = true;
    const valid = () => !this._disposed && this._outputGeneration === generation;
    const stage = this._outputStage;
    const job = (async () => {
      let restore = false, action;
      try {
        await Promise.race([stage.prepare(value), canceled]);
        if (!valid()) return false;
        restore = this._intent && this.isPlaying && !this._stopRequest;
        action = this._action;
        if (restore) {
          this._rampTo(0, 0.025);
          await Promise.race([new Promise(resolve => this._setTimeout(resolve, 30)), canceled]);
          if (!valid()) return false;
        }
        stage.activate(value);
        stage.setMuted(this._volume === 0);
        if (value > 0 && this._context.state === 'running') await Promise.race([stage.flush(), canceled]);
        if (!valid()) return false;
        if (restore && action === this._action && this._intent && this.isPlaying) this._rampTo(this._volume, 0.025);
        else stage.silence();
        return true;
      } catch (error) {
        if (!valid()) return false;
        this._outputGainDb = 0;
        stage.activate(0);
        if (restore && action === this._action && this._intent && this.isPlaying) this._rampTo(this._volume, 0.025);
        this._emit('outputgainchange');
        this._emitError(error);
        return false;
      } finally {
        if (valid()) { this._outputPending = false; if (this._cancelOutputChange === cancelChange) this._cancelOutputChange = null; }
      }
    })();
    this._outputReady = job;
    return job;
  }

  setFade(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0 || value > 10) return false;
    this._fade = value;
    this._emit('statechange');
    return true;
  }

  setLoop(start, end, enabled = true) {
    const from = Number(start), to = Number(end);
    const valid = Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to - from >= 0.1 && (!this.duration || to <= this.duration + 0.01);
    this._loop = { start: valid ? from : 0, end: valid ? Math.min(to, this.duration || to) : 0, enabled: Boolean(enabled && valid) };
    this._loopSeeking = false;
    this._scheduleLoop();
    this._emit('loopchange');
    return valid;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._cancelRateChange();
    this._nativeOutput?.dispose();
    this._outputGeneration++;
    this._cancelOutputChange?.();
    this._outputStage?.dispose();
    this._cancelStop();
    this._cancelQueuedPlay();
    this._action++;
    this._intent = false;
    this._cancelSeekWait?.();
    this._cancelLoad?.();
    this._cancelMediaWait?.();
    this._cancelPause();
    this._stopTick();
    this._clearTimeout(this._fadeTimer);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this._url) this._urls.revokeObjectURL(this._url);
    for (const [audio, type, callback] of this._listeners) audio.removeEventListener(type, callback);
    this._source?.disconnect();
    this._gain?.disconnect();
    this._context?.close().catch(() => {});
  }

  _configureAudio(audio) {
    audio.preload = 'auto';
    audio.playsInline = true;
    audio.preservesPitch = true;
    audio.mozPreservesPitch = true;
    audio.webkitPreservesPitch = true;
    this._applyRate(audio);
    audio.volume = 1;
    audio.muted = this._volume === 0;
  }
  _applyRate(audio) {
    // The media load algorithm restores playbackRate from defaultPlaybackRate.
    // Set both on each fresh decoder and reassert after native readiness.
    audio.defaultPlaybackRate = this._rate;
    audio.playbackRate = this._rate;
  }
  _bindMediaListeners() {
    this._listen('timeupdate', () => { this._checkLoop(); this._emit('timeupdate'); });
    this._listen('seeked', () => { this._loopSeeking = false; this._scheduleLoop(); this._emit('timeupdate'); });
    this._listen('ended', () => this._ended());
    this._listen('error', () => this._mediaError());
    this._listen('pause', () => {
      // OS controls and media interruptions also need to update the UI.
      if (this.audio.paused && this._intent && !this.audio.ended) {
        this._action++;
        this._intent = false;
        this._cancelSeekWait?.();
        this._stopTick();
        this._rampTo(0, 0);
        this._setState('paused');
      }
    });
  }
  _replaceAudio() {
    this._mediaGeneration++;
    if (this._outputMode === 'native') {
      this._cancelMediaWait?.(); this._cancelSeekWait?.();
      const audio = this.audio;
      audio.pause(); audio.removeAttribute('src'); audio.load();
      this._playedMedia.delete(audio);
      this._configureAudio(audio);
      this._nativeOutput?.refreshAudio();
      return audio;
    }
    const old = this.audio;
    const fresh = this._audioFactory();
    if (!fresh || fresh === old) throw new Error('Audio factory must return a fresh media element.');
    this._cancelMediaWait?.();
    this._cancelSeekWait?.();
    for (const [audio, type, callback] of this._listeners) audio.removeEventListener(type, callback);
    this._listeners = [];
    this._source?.disconnect();
    this._source = null;
    // A paused media element can retain decoder / pitch-preserver output.
    // Retire it completely instead of letting a later play drain that tail.
    old.muted = true;
    old.pause();
    old.removeAttribute('src');
    old.load();
    this.audio = fresh;
    this._configureAudio(fresh);
    this._bindMediaListeners();
    this._attachSource();
    return fresh;
  }
  _attachSource() {
    if (this._outputMode === 'native') return;
    if (!this._context || !this._gain || this._source) return;
    this._source = this._context.createMediaElementSource(this.audio);
    this._source.connect(this._gain);
  }
  _waitForMedia(audio, predicate, events) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const clean = () => {
        for (const event of events) audio.removeEventListener(event, ready);
        audio.removeEventListener('error', failed);
        this._clearTimeout(timer);
        if (this._cancelMediaWait === canceled) this._cancelMediaWait = null;
      };
      const ready = () => { if (predicate()) { clean(); resolve(); } };
      const failed = () => { clean(); reject(this._audioError()); };
      const canceled = () => { clean(); reject(new DOMException('Media preparation was superseded.', 'AbortError')); };
      for (const event of events) audio.addEventListener(event, ready);
      audio.addEventListener('error', failed);
      this._cancelMediaWait = canceled;
      timer = this._setTimeout(() => { clean(); reject(new Error('The selected audio position could not be prepared.')); }, 15000);
    });
  }
  _resetMediaAt(target) {
    const loadId = this._loadId;
    const url = this._url;
    this._rampTo(0, 0);
    this._positionHint = target;
    this._prepareTarget = target;
    const audio = this._replaceAudio();
    const mediaGeneration = this._mediaGeneration;
    audio.src = url;
    const current = () => !this._disposed && this.audio === audio && this._loadId === loadId && this._mediaGeneration === mediaGeneration;
    const check = () => { if (!current()) throw new DOMException('Media preparation was superseded.', 'AbortError'); };
    const promise = (async () => {
      await this._waitForMedia(audio, () => audio.readyState >= 1 && Number.isFinite(audio.duration), ['loadedmetadata', 'durationchange']);
      check();
      this._duration = audio.duration;
      this._applyRate(audio);
      audio.currentTime = Math.max(0, Math.min(this._prepareTarget, audio.duration));
      if (audio.seeking) await this._waitForSeek();
      check();
      await this._waitForMedia(audio, () => audio.readyState >= 3 && !audio.seeking, ['canplay', 'canplaythrough', 'loadeddata', 'seeked']);
      check();
      this._applyRate(audio);
      this._positionHint = null;
      this._emit('timeupdate');
      return true;
    })();
    this._mediaReady = promise;
    const clean = () => { if (this._mediaReady === promise) this._mediaReady = null; };
    promise.then(clean, clean);
    audio.load();
    return promise;
  }
  _cancelQueuedPlay() { this._playWaitId++; this._queuedPlay = false; }
  _finishStop(request, completed) {
    if (this._stopRequest === request) this._stopRequest = null;
    if (!completed) this._cancelQueuedPlay();
    request.resolve(completed);
  }
  _cancelStop() {
    if (this._stopRequest) this._finishStop(this._stopRequest, false);
  }
  _listen(type, callback) {
    const audio = this.audio;
    const guarded = event => { if (this.audio === audio && !this._disposed) callback(event); };
    audio.addEventListener(type, guarded);
    this._listeners.push([audio, type, guarded]);
  }
  _setState(state) { this._state = state; this._emit('statechange'); }
  _emit(type) { if (!this._disposed) this.dispatchEvent(new CustomEvent(type, { detail: this.snapshot })); }
  _emitError(error) { if (!this._disposed) this.dispatchEvent(new CustomEvent('error', { detail: { ...this.snapshot, error, message: error.message } })); }
  _audioError() {
    const messages = { 1: 'Audio loading was aborted.', 2: 'The audio file could not be read.', 3: 'The audio file could not be decoded.', 4: 'This audio format is not supported by this browser.' };
    return new Error(messages[this.audio.error?.code] || 'The audio could not be played.');
  }
  _mediaError() {
    if (!this._url || this._disposed || (this._outputMode === 'native' && !this.audio.error)) return;
    this._cancelRateChange();
    this._cancelStop();
    this._cancelQueuedPlay();
    this._action++;
    this._intent = false;
    this._cancelSeekWait?.();
    this._cancelPause();
    this._stopTick();
    this._rampTo(0, 0);
    this._setState('error');
    this._emitError(this._audioError());
  }
  _ensureContext() {
    if (this._context) return;
    if (this._outputMode === 'native') {
      this._nativeOutput = this._nativeOutputFactory({ getAudio: () => this.audio, requestAnimationFrame: this._raf, cancelAnimationFrame: this._caf, setTimeout: this._setTimeout, clearTimeout: this._clearTimeout, ...(this._nativeNow ? { now: this._nativeNow } : {}) });
      this._context = this._nativeOutput.context;
      this._gain = this._nativeOutput.gain;
      this._gain.gain.value = 0;
      this._nativeOutput.refreshAudio();
      return;
    }
    this._context = this._contextFactory();
    this._gain = this._context.createGain();
    this._gain.gain.value = 0;
    this._outputStage = this._outputStageFactory(this._context, this._gain, this._context.destination, { muted: this._volume === 0 });
    if (this._outputGainDb > 0) this._queueOutputChange(this._outputGainDb);
    this._attachSource();
  }
  _rampTo(target, seconds) {
    this._clearTimeout(this._fadeTimer);
    if (!this._gain) return;
    if (target === 0 && seconds === 0) this._outputStage?.silence();
    else if (target > 0) this._outputStage?.open();
    const previousVisual = this.visualState;
    const now = this._context.currentTime;
    const ramp = this._ramp;
    let current = this._gain.gain.value;
    if (ramp) {
      const fraction = ramp.endAt > ramp.startAt ? Math.max(0, Math.min(1, (now - ramp.startAt) / (ramp.endAt - ramp.startAt))) : 1;
      current = ramp.from + (ramp.to - ramp.from) * fraction;
    }
    this._gain.gain.cancelScheduledValues(now);
    this._gain.gain.setValueAtTime(current, now);
    if (seconds > 0) this._gain.gain.linearRampToValueAtTime(target, now + seconds);
    else this._gain.gain.setValueAtTime(target, now);
    this._ramp = { from: seconds > 0 ? current : target, to: target, startAt: now, endAt: now + seconds };
    // Keep display-only envelope endpoints separate from the master volume.
    // This adds no audio automation, waits, callbacks or routing changes.
    const envelopeTarget = target > 0 && this._volume > 0 ? Math.max(0, Math.min(1, target / this._volume))
      : seconds === 0 || !this._intent || this._volume > 0 ? 0
      : this._state === 'starting' ? 1 : previousVisual.envelopeLevel;
    const fromEnvelope = seconds > 0 ? previousVisual.envelopeLevel : envelopeTarget;
    const phase = envelopeTarget > fromEnvelope ? 'in' : envelopeTarget < fromEnvelope ? 'out' : 'idle';
    this._visualRamp = { from: fromEnvelope, to: envelopeTarget, phase };

    if (seconds > 0) this._fadeTimer = this._setTimeout(() => this._emit('statechange'), seconds * 1000 + 10);
  }
  _cancelPause() {
    if (!this._pendingPause) return;
    this._clearTimeout(this._pendingPause.timer);
    this._pendingPause.resolve(false);
    this._pendingPause = null;
  }
  _waitForSeek() {
    const audio = this.audio;
    if (!audio.seeking) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const clean = () => {
        audio.removeEventListener('seeked', ready);
        audio.removeEventListener('error', failed);
        this._clearTimeout(timer);
        this._cancelSeekWait = null;
      };
      const ready = () => { if (audio.seeking) return; clean(); resolve(); };
      const failed = () => { clean(); reject(this._audioError()); };
      this._cancelSeekWait = () => { clean(); resolve(); };
      audio.addEventListener('seeked', ready);
      audio.addEventListener('error', failed);
      timer = this._setTimeout(() => {
        clean();
        reject(new Error('The selected audio position could not be loaded.'));
      }, 15000);
    });
  }
  _startTick() {
    this._stopTick();
    const tick = () => {
      this._frame = null;
      if (this._disposed || this.audio.paused) return;
      this._checkLoop();
      this._emit('timeupdate');
      this._frame = this._raf(tick);
    };
    this._frame = this._raf(tick);
    this._scheduleLoop();
  }
  _stopTick() { if (this._frame != null) this._caf(this._frame); this._frame = null; this._clearLoopTimer(); }
  _clearLoopTimer() { this._clearTimeout(this._loopTimer); this._loopTimer = null; }
  _scheduleLoop() {
    this._clearLoopTimer();
    if (!this._loop.enabled || this.audio.paused || this._disposed || this._stopRequest) return;
    const remaining = (this._loop.end - this.currentTime) / this._rate;
    this._loopTimer = this._setTimeout(() => { this._loopTimer = null; this._checkLoop(); this._scheduleLoop(); }, Math.max(12, remaining * 1000));
  }
  _checkLoop() {
    if (!this._loop.enabled || this.audio.paused || this._loopSeeking || this._stopRequest || this.currentTime < this._loop.end) return;
    this._loopSeeking = true;
    const { start, end } = this._loop;
    const overshoot = Math.max(0, this.currentTime - end);
    this.audio.currentTime = start + (overshoot % (end - start));
    this._emit('loop');
    this._scheduleLoop();
  }
  async _ended() {
    // A queued event from an earlier source must not stop newer playback.
    if (!this.audio.ended || this._disposed) return;
    this._cancelRateChange();
    if (this._stopRequest) {
      // Let the pending stop settle at its requested anchor even if the file
      // ends during the fade. Do not cancel that stop or restart a loop.
      this._rampTo(0, 0);
      this._stopTick();
      return;
    }
    this._loopSeeking = false;
    if (this._loop.enabled && this._intent) {
      this.audio.currentTime = this._loop.start;
      // A loop boundary is not a new manual start: retain the existing gain.
      await this.play({ fadeIn: false });
      this._emit('loop');
      return;
    }
    this._action++;
    this._intent = false;
    this._cancelPause();
    this._stopTick();
    this._rampTo(0, 0);
    this._setState('ended');
  }
}

export default AudioEngine;
