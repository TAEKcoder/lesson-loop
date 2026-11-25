/** Optional output trim. Zero dB is a physical bypass: no DSP, delay or peak change. */
export const OUTPUT_CEILING = 10 ** (-0.3 / 20);
export const OUTPUT_LOOKAHEAD_MS = 5;
const workletLoads = new WeakMap();

/** Shared by the real AudioWorklet and silent unit/offline tests. */
export class LinkedPeakLimiter {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.delay = Math.max(1, Math.round(sampleRate * (options.lookAheadMs ?? OUTPUT_LOOKAHEAD_MS) / 1000));
    this.ceiling = options.ceiling ?? OUTPUT_CEILING;
    this.release = Math.exp(-1 / (sampleRate * (options.releaseMs ?? 80) / 1000));
    this.capacity = this.delay + 2;
    this.peakValues = new Float64Array(this.capacity);
    this.peakFrames = new Float64Array(this.capacity);
    this.rings = [];
    this.reset();
  }
  reset() {
    for (const ring of this.rings) ring.fill(0);
    this.head = 0; this.tail = 0; this.frame = 0; this.write = 0; this.envelope = 1;
  }
  process(input, output, gainDb = 0, muted = false) {
    const frames = output[0]?.length || 0;
    const channels = output.length;
    if (muted) { this.reset(); for (const channel of output) channel.fill(0); return; }
    // Tests can invoke the bypass, but production routes zero dB around this node.
    if (!(gainDb > 0)) {
      this.reset();
      for (let channel = 0; channel < channels; channel++) {
        const source = input[channel];
        if (source) output[channel].set(source.subarray(0, frames)); else output[channel].fill(0);
      }
      return;
    }
    const gain = 10 ** (Math.min(6, Math.max(0, gainDb)) / 20);
    if (this.rings.length !== channels) {
      this.rings = Array.from({ length: channels }, () => new Float32Array(this.delay + 1));
      this.reset();
    }
    const ringSize = this.delay + 1;
    for (let offset = 0; offset < frames; offset++) {
      let peak = 0;
      for (let channel = 0; channel < channels; channel++) {
        const raw = input[channel]?.[offset] ?? 0;
        const sample = Number.isFinite(raw) ? raw * gain : 0;
        this.rings[channel][this.write] = sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      const oldest = this.frame - this.delay;
      while (this.head !== this.tail && this.peakFrames[this.head] < oldest) this.head = (this.head + 1) % this.capacity;
      while (this.head !== this.tail) {
        const last = (this.tail + this.capacity - 1) % this.capacity;
        if (this.peakValues[last] > peak) break;
        this.tail = last;
      }
      this.peakValues[this.tail] = peak; this.peakFrames[this.tail] = this.frame;
      this.tail = (this.tail + 1) % this.capacity;
      const maximum = this.peakValues[this.head];
      const target = maximum > this.ceiling ? this.ceiling / maximum : 1;
      this.envelope = target < this.envelope ? target : target + (this.envelope - target) * this.release;
      const read = (this.write + 1) % ringSize;
      for (let channel = 0; channel < channels; channel++) {
        const delayed = this.frame >= this.delay ? this.rings[channel][read] : 0;
        // A final numerical guard only; linked gain already bounds finite PCM.
        output[channel][offset] = Math.max(-this.ceiling, Math.min(this.ceiling, delayed * this.envelope));
      }
      this.write = read; this.frame++;
    }
  }
}

if (typeof registerProcessor === 'function') {
  class OutputPeakProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() { return [{ name: 'gainDb', defaultValue: 0, minValue: 0, maxValue: 6, automationRate: 'k-rate' }]; }
    constructor(options) {
      super();
      this.limiter = new LinkedPeakLimiter(sampleRate, options.processorOptions);
      this.muted = options.processorOptions?.muted === true;
      this.port.onmessage = ({ data }) => {
        if (data.type === 'reset') { this.limiter.reset(); this.port.postMessage({ type: 'reset-complete', id: data.id }); }
        if (data.type === 'mute') { this.muted = data.value === true; if (this.muted) this.limiter.reset(); }
      };
    }
    process(inputs, outputs, parameters) {
      this.limiter.process(inputs[0] || [], outputs[0] || [], parameters.gainDb[0], this.muted);
      return true;
    }
  }
  registerProcessor('lesson-output-peak-v1', OutputPeakProcessor);
}

/** Owns exactly one route from master fade gain to the destination. */
export class OutputStage {
  constructor(context, input, destination, options = {}) {
    this.context = context; this.input = input; this.destination = destination; this.options = options;
    this.muted = options.muted === true; this.silenced = true; this.activeDb = 0; this.pending = new Map(); this.resetId = 0;
    input.connect(destination);
  }
  async prepare(db) {
    if (!(db > 0)) return;
    if (!this.node) {
      if (!this.context.audioWorklet?.addModule) throw new Error('추가 음량을 지원하지 않는 브라우저입니다. 원본 음량으로 재생합니다.');
      let loaded = workletLoads.get(this.context);
      if (!loaded) {
        loaded = this.context.audioWorklet.addModule(this.options.moduleUrl || new URL('./output-stage.js', import.meta.url).href);
        workletLoads.set(this.context, loaded);
      }
      await loaded;
      if (this.disposed) throw new DOMException('Output stage disposed.', 'AbortError');
      if (!this.node) {
        const factory = this.options.nodeFactory || ((context, name, options) => new AudioWorkletNode(context, name, options));
        this.node = factory(this.context, 'lesson-output-peak-v1', { numberOfInputs: 1, numberOfOutputs: 1, channelCountMode: 'max', processorOptions: { muted: this.muted, lookAheadMs: OUTPUT_LOOKAHEAD_MS, ceiling: OUTPUT_CEILING } });
        this.gate = this.context.createGain(); this.gate.gain.value = 0;
        this.node.connect(this.gate);
        this.node.port.onmessage = ({ data }) => {
          if (data.type !== 'reset-complete') return;
          const pending = this.pending.get(data.id); if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(data.id); pending.resolve();
        };
      }
    }
  }
  activate(db) {
    this.input.disconnect();
    this.gate?.disconnect();
    this.activeDb = db;
    this.silenced = true;
    if (!(db > 0)) { this.input.connect(this.destination); return; }
    if (!this.node) throw new Error('Output stage is not ready.');
    this.node.parameters.get('gainDb').setValueAtTime(db, this.context.currentTime);
    this.gate.gain.setValueAtTime(0, this.context.currentTime);
    this.input.connect(this.node); this.gate.connect(this.destination);
    this.node.port.postMessage({ type: 'mute', value: this.muted });
  }
  setMuted(value) {
    this.muted = value === true;
    this.node?.port.postMessage({ type: 'mute', value: this.muted });
    if (this.gate) this.gate.gain.setValueAtTime(this.muted || this.silenced ? 0 : 1, this.context.currentTime);
  }
  silence() {
    this.silenced = true;
    if (this.gate) this.gate.gain.setValueAtTime(0, this.context.currentTime);
    this.node?.port.postMessage({ type: 'reset' });
  }
  open() {
    this.silenced = false;
    if (this.gate) this.gate.gain.setValueAtTime(this.muted ? 0 : 1, this.context.currentTime);
  }
  flush() {
    if (!(this.activeDb > 0)) return Promise.resolve();
    if (this.context.state !== 'running') return Promise.reject(new Error('Audio context must be running before clearing output history.'));
    const id = ++this.resetId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('음량 처리 준비가 완료되지 않았습니다. 다시 재생해 주세요.')); }, 1500);
      this.pending.set(id, { resolve, reject, timer });
      this.node.port.postMessage({ type: 'reset', id });
    });
  }
  dispose() {
    this.disposed = true; this.input.disconnect(); this.gate?.disconnect(); this.node?.disconnect();
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new DOMException('Output stage disposed.', 'AbortError')); }
    this.pending.clear();
  }
}
