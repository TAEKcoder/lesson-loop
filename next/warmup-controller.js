import { nextWarmup } from './playback-plan.js';

/** One prepared successor, with a cancelable intent to advance. Never plays on preload. */
export class WarmupQueue {
  constructor(options) { this.options=options; this.generation=0; this.busy=false; this.cache=null; this._lookupRevision=0; }
  cancel() { this.generation++; this._busy(false); }
  invalidate(id) {
    // A lookup may still be reading a replaced Blob before a cache entry exists.
    this._lookupRevision++;
    if (!id || this.cache?.id===id) { this.cache?.controller.abort(); this.cache=null; }
  }
  _busy(value) { this.busy=value; this.options.onState?.(value); }
  _aborted() { return new DOMException('Preparing the next track was superseded.', 'AbortError'); }
  async _candidate(currentId,direction,current) {
    const library=this.options.library();
    const connected=new Set((library.warmupTracks||[]).filter(song=>song.hasAudio).map(song=>song.id));
    for (let remaining=connected.size;remaining>0;remaining--) {
      if (!current()) throw this._aborted();
      const song=nextWarmup(library,currentId,direction,{connectedIds:connected});
      if (!song) return null;
      const blob=await this.options.getAudio(song.id);
      if (!current()) throw this._aborted();
      if (blob) return { song,blob };
      connected.delete(song.id);this.options.onMissing?.(song);
    }
    return null;
  }
  async prepareNext(currentId,direction=1) {
    const revision=++this._lookupRevision,current=()=>revision===this._lookupRevision;
    const candidate=await this._candidate(currentId,direction,current);
    if (!current()) throw this._aborted();
    if (!candidate) { this.cache?.controller.abort();this.cache=null;return null; }
    const {song,blob}=candidate;
    if (this.cache?.id===song.id) return this.cache.promise;
    this.cache?.controller.abort();
    const controller=new AbortController(),entry={id:song.id,controller};
    entry.promise=Promise.resolve().then(()=>this.options.prepare(blob,{signal:controller.signal})).then(prepared=>{
      if (controller.signal.aborted) throw this._aborted();
      return {id:song.id,blob,prepared};
    });
    // Preloading is optional; callers may ignore a superseded or failed preparation.
    entry.promise.catch(()=>{if(this.cache===entry)this.cache=null;});this.cache=entry;
    return entry.promise;
  }
  async advance(currentId,{direction=1,autoplay=true,automatic=false}={}) {
    const ticket=++this.generation;this._busy(true);
    const current=()=>ticket===this.generation;
    try {
      const entry=await this.prepareNext(currentId,direction);
      if (!current()) return false;
      if (!entry) { await this.options.onComplete?.({automatic});return false; }
      if (!await this.options.load(entry)||!current()) return false;
      if (autoplay && !await this.options.play()) return false;
      return current();
    } catch(error) {
      if (current() && error?.name!=='AbortError') this.options.onError?.(error);
      return false;
    } finally { if (current()) this._busy(false); }
  }
}
