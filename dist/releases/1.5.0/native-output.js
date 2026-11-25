/** Desktop Safari compatibility output.
 * Applies the transport envelope to HTMLAudioElement.volume without attaching
 * the media element to an AudioContext or a MediaElementAudioSourceNode.
 * `now` is performance.now-compatible milliseconds; context time is seconds.
 */
export function shouldUseNativeOutput(userAgent = globalThis.navigator?.userAgent || '', environment = globalThis.navigator || {}) {
  const ua = String(userAgent);
  if (!/Macintosh|Mac OS X/i.test(ua) || !/AppleWebKit\//i.test(ua) || !/Version\//i.test(ua) || !/Safari\//i.test(ua)) return false;
  if (/iPhone|iPad|iPod|Android|Mobile|Chrome|Chromium|CriOS|Edg|OPR|Opera|Firefox|FxiOS|SamsungBrowser|DuckDuckGo|YaBrowser/i.test(ua)) return false;
  // iPadOS can request a Macintosh UA; it still does not expose desktop volume.
  if (Number(environment.maxTouchPoints) > 1 && /Mac/i.test(String(environment.platform || ''))) return false;
  return true;
}

export function createNativeOutput(options = {}) {
  if (typeof options.getAudio !== 'function') throw new TypeError('A current audio element getter is required.');
  const getAudio = options.getAudio;
  const nowMilliseconds = options.now || (() => globalThis.performance?.now?.() ?? Date.now());
  const raf = options.requestAnimationFrame || (callback => requestAnimationFrame(callback));
  const caf = options.cancelAnimationFrame || (id => cancelAnimationFrame(id));
  const setTimer = options.setTimeout || globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  const origin = Number(nowMilliseconds());
  let elapsed = 0, closedTime = 0, disposed = false;
  let frame = null, boundaryTimer = null, boundaryAt = null, lastAudio = null, serial = 0;
  let events = [{ type: 'set', time: 0, value: 0, order: serial++ }];

  const clock = () => {
    if (disposed) return closedTime;
    const next = (Number(nowMilliseconds()) - origin) / 1000;
    if (Number.isFinite(next)) elapsed = Math.max(elapsed, next, 0);
    return elapsed;
  };
  const gainValue = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError('Native volume must be finite.');
    return Math.max(0, Math.min(1, number));
  };
  const eventTime = value => {
    const time = Number(value);
    if (!Number.isFinite(time) || time < 0) throw new RangeError('Native automation time must be non-negative and finite.');
    return time;
  };
  const sortEvents = () => events.sort((a, b) => a.time - b.time || a.order - b.order);
  const valueAt = time => {
    let previous = events[0];
    for (let i = 1; i < events.length; i++) {
      const event = events[i];
      if (time < event.time) {
        if (event.type !== 'ramp' || time <= previous.time) return previous.value;
        const fraction = Math.max(0, Math.min(1, (time - previous.time) / (event.time - previous.time)));
        return previous.value + (event.value - previous.value) * fraction;
      }
      previous = event;
    }
    return previous.value;
  };
  const compact = time => {
    const value = valueAt(time);
    events = [{ type: 'set', time, value, order: serial++ }, ...events.filter(event => event.time > time)];
  };
  const applyVolume = value => {
    const audio = getAudio();
    if (audio !== lastAudio) {
      // A replaced element must never keep the old envelope's last output.
      if (lastAudio) lastAudio.volume = 0;
      lastAudio = audio || null;
    }
    if (audio) audio.volume = disposed ? 0 : gainValue(value);
  };
  const cancelBoundary = () => {
    if (boundaryTimer !== null) clearTimer(boundaryTimer);
    boundaryTimer = null; boundaryAt = null;
  };
  const cancelFrame = () => {
    if (frame !== null) caf(frame);
    frame = null;
  };
  const pendingBoundary = time => events.find(event => event.time > time)?.time ?? null;
  const synchronize = () => {
    if (disposed) return;
    const time = clock();
    applyVolume(valueAt(time));
    const next = pendingBoundary(time);
    if (next === null) { cancelFrame(); cancelBoundary(); return; }
    if (frame === null) frame = raf(() => { frame = null; synchronize(); });
    if (boundaryTimer === null || boundaryAt !== next) {
      cancelBoundary(); boundaryAt = next;
      boundaryTimer = setTimer(() => {
        boundaryTimer = null; boundaryAt = null; synchronize();
      }, Math.max(1, Math.ceil((next - time) * 1000)));
    }
  };

  const parameter = {
    get value() { return disposed ? 0 : valueAt(clock()); },
    set value(value) {
      if (disposed) return;
      events = [{ type: 'set', time: clock(), value: gainValue(value), order: serial++ }];
      synchronize();
    },
    cancelScheduledValues(time) {
      if (disposed) return parameter;
      const now = clock(), cut = Math.max(now, eventTime(time));
      compact(now);
      const removed = events.find(event => event.time >= cut && event.time > now);
      const held = valueAt(cut);
      events = events.filter(event => event.time < cut || event.time === now);
      if (cut <= now) events = [{ type: 'set', time: now, value: valueAt(now), order: serial++ }];
      else if (removed?.type === 'ramp') events.push({ type: 'ramp', time: cut, value: held, order: serial++ });
      sortEvents(); synchronize(); return parameter;
    },
    setValueAtTime(value, time) {
      if (disposed) return parameter;
      const now = clock(); compact(now);
      events.push({ type: 'set', time: Math.max(now, eventTime(time)), value: gainValue(value), order: serial++ });
      sortEvents(); synchronize(); return parameter;
    },
    linearRampToValueAtTime(value, time) {
      if (disposed) return parameter;
      const now = clock(); compact(now);
      events.push({ type: 'ramp', time: Math.max(now, eventTime(time)), value: gainValue(value), order: serial++ });
      sortEvents(); synchronize(); return parameter;
    },
  };
  const dispose = () => {
    if (disposed) return;
    closedTime = clock(); disposed = true;
    cancelFrame(); cancelBoundary();
    events = [{ type: 'set', time: closedTime, value: 0, order: serial++ }];
    applyVolume(0);
  };
  const context = {
    get currentTime() { return clock(); },
    get state() { return disposed ? 'closed' : 'running'; },
    resume() {
      return disposed ? Promise.reject(new DOMException('Native output has been closed.', 'InvalidStateError')) : Promise.resolve();
    },
    close() { dispose(); return Promise.resolve(); },
  };
  const gain = { gain: parameter, connect() {}, disconnect: dispose };
  const refreshAudio = () => {
    if (disposed) applyVolume(0);
    else synchronize();
  };
  synchronize();
  return { context, gain, refreshAudio, dispose };
}

export default createNativeOutput;
