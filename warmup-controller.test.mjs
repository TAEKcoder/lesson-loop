import test from 'node:test';
import assert from 'node:assert/strict';
import { WarmupQueue } from './next/warmup-controller.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(overrides={}){
 const library={warmupTracks:['a','b','c'].map(id=>({id,hasAudio:true})),settings:{warmupListRepeat:false}};
 const files=new Map(library.warmupTracks.map(song=>[song.id,new Blob([song.id])]));
 const calls={prepare:[],load:[],play:0,missing:[],errors:[],complete:[],states:[]};
 const options={library:()=>library,getAudio:async id=>files.get(id),prepare:async(blob,{signal})=>{calls.prepare.push({blob,signal});return {blob,mode:'native'};},load:async entry=>{calls.load.push(entry);return true;},play:async()=>{calls.play++;return true;},onMissing:song=>{calls.missing.push(song.id);song.hasAudio=false;},onError:error=>calls.errors.push(error),onComplete:info=>calls.complete.push(info),onState:value=>calls.states.push(value),...overrides};
 return {queue:new WarmupQueue(options),library,files,calls,options};
}

test('preloading alone never loads or plays, and a prepared successor is reused',async()=>{
 const {queue,calls}=harness();
 const first=await queue.prepareNext('a'),second=await queue.prepareNext('a');
 assert.equal(first.id,'b');assert.equal(second,first);assert.equal(calls.prepare.length,1);
 assert.equal(calls.load.length,0);assert.equal(calls.play,0);assert.equal(queue.busy,false);
 assert.equal(await queue.advance('a'),true);assert.equal(calls.prepare.length,1);assert.equal(calls.play,1);
});

test('stop while preparation is pending forbids later loading or autoplay',async()=>{
 const gate=deferred();const {queue,calls}=harness({prepare:()=>gate.promise});
 const pending=queue.advance('a');await flush();assert.equal(queue.busy,true);
 queue.cancel();assert.equal(queue.busy,false);gate.resolve({mode:'native'});
 assert.equal(await pending,false);assert.equal(calls.load.length,0);assert.equal(calls.play,0);
 assert.deepEqual(calls.errors,[]);assert.equal(queue.busy,false);
});

test('stop during loading prevents autoplay even when loading later succeeds',async()=>{
 const gate=deferred();let loading=0;
 const {queue,calls}=harness({load:()=>{loading++;return gate.promise;}});
 const pending=queue.advance('a');await flush();assert.equal(loading,1);
 queue.cancel();gate.resolve(true);
 assert.equal(await pending,false);assert.equal(calls.play,0);assert.equal(queue.busy,false);
});

test('a late old candidate lookup cannot abort the newer prepared successor or autoplay',async()=>{
 const oldLookup=deferred(),newPreparation=deferred();let freshSignal;
 const {queue,calls,files}=harness({getAudio:id=>id==='b'?oldLookup.promise:Promise.resolve(files.get(id)),prepare:(blob,{signal})=>{freshSignal=signal;return newPreparation.promise;}});
 const oldAdvance=queue.advance('a');await flush();
 const freshAdvance=queue.advance('b');await flush();assert.equal(queue.cache.id,'c');
 oldLookup.resolve(files.get('b'));await flush();
 assert.equal(queue.cache.id,'c');assert.equal(freshSignal.aborted,false);
 newPreparation.resolve({mode:'native'});
 assert.equal(await oldAdvance,false);assert.equal(await freshAdvance,true);
 assert.equal(calls.play,1);assert.deepEqual(calls.errors,[]);assert.equal(queue.busy,false);
});

test('consecutive advances while loading allow only the latest to start playback',async()=>{
 const first=deferred(),second=deferred();const loaded=[];
 const {queue,calls}=harness({load:entry=>{loaded.push(entry.id);return entry.id==='b'?first.promise:second.promise;}});
 const a=queue.advance('a');await flush();const b=queue.advance('b');await flush();
 assert.deepEqual(loaded,['b','c']);first.resolve(true);assert.equal(await a,false);assert.equal(calls.play,0);
 second.resolve(true);assert.equal(await b,true);assert.equal(calls.play,1);assert.equal(queue.busy,false);
});

test('missing audio is skipped in order and an entirely missing repeating list terminates finitely',async()=>{
 const {queue,calls,files}=harness();files.delete('b');
 assert.equal(await queue.advance('a'),true);assert.deepEqual(calls.missing,['b']);assert.equal(calls.load[0].id,'c');
 const all=harness();all.library.settings.warmupListRepeat=true;all.files.clear();
 assert.equal(await all.queue.advance('a',{automatic:true}),false);
 assert.equal(all.calls.missing.length,3);assert.equal(new Set(all.calls.missing).size,3);
 assert.deepEqual(all.calls.complete,[{automatic:true}]);assert.equal(all.calls.prepare.length,0);assert.equal(all.calls.play,0);assert.equal(all.queue.busy,false);
});

test('an aborted cached preparation is silent and does not clear its replacement',async()=>{
 let firstSignal;const gate=deferred();
 const {queue,calls}=harness({prepare:async(blob,{signal})=>{if(await blob.text()==='b'){firstSignal=signal;signal.addEventListener('abort',()=>gate.reject(new DOMException('Superseded','AbortError')),{once:true});return gate.promise;}return {blob,mode:'native'};}});
 const advance=queue.advance('a');await flush();
 const replacement=await queue.prepareNext('b');assert.equal(firstSignal.aborted,true);assert.equal(replacement.id,'c');
 assert.equal(await advance,false);assert.equal(queue.cache.id,'c');assert.deepEqual(calls.errors,[]);assert.equal(calls.play,0);
});

test('failed preparation is evicted so a later advance can retry, and failed loads never play',async()=>{
 let attempts=0;const {queue,calls}=harness({prepare:async()=>{if(++attempts===1)throw Error('temporary decode failure');return {mode:'native'};}});
 assert.equal(await queue.advance('a'),false);assert.equal(queue.cache,null);assert.equal(calls.errors.length,1);
 assert.equal(await queue.advance('a'),true);assert.equal(attempts,2);assert.equal(calls.play,1);
 const failed=harness({load:async()=>false});assert.equal(await failed.queue.advance('a'),false);assert.equal(failed.calls.play,0);assert.equal(failed.queue.busy,false);
 const thrown=harness({load:async()=>{throw Error('load failed');}});assert.equal(await thrown.queue.advance('a'),false);assert.equal(thrown.calls.play,0);assert.equal(thrown.calls.errors.length,1);
});

test('invalidating a pending source lookup discards it before preparation',async()=>{
 const gate=deferred();const {queue,calls}=harness({getAudio:()=>gate.promise});
 const lookup=queue.prepareNext('a');queue.invalidate('b');gate.resolve(new Blob(['old source']));
 await assert.rejects(lookup,{name:'AbortError'});assert.equal(queue.cache,null);assert.equal(calls.prepare.length,0);
});
