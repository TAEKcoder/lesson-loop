import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivePlaybackRange, nextWarmup } from './next/playback-plan.js';

const song = () => ({id:'song',trim:{start:2,end:88},weeks:[{start:0,end:20},{start:20,end:40},{start:40,end:60},{start:60,end:null}]});

test('trimmed playback uses absolute original timestamps and explicitly reports clipped lesson edges',()=>{
 const track=song(),originalWeeks=structuredClone(track.weeks);
 const first=effectivePlaybackRange(track,'lesson',0,100);
 assert.equal(first.valid,true);assert.equal(first.start,2);assert.equal(first.end,20);assert.equal(first.clipped,true);assert.match(first.warning,/원본/);
 assert.deepEqual(effectivePlaybackRange(track,'lesson',1,100),{valid:true,start:20,end:40,warning:'',reason:null,trimmed:true,clipped:false});
 const final=effectivePlaybackRange(track,'lesson',3,100);assert.equal(final.start,60);assert.equal(final.end,88);assert.equal(final.clipped,true);
 assert.deepEqual(track.weeks,originalWeeks);
 assert.deepEqual(effectivePlaybackRange(track,'warmup',0,100),{valid:true,start:2,end:88,warning:'',reason:null,trimmed:true,clipped:false});
});

test('untrimmed old tracks play original ranges, including an open-ended final week',()=>{
 const track=song();delete track.trim;
 const warmup=effectivePlaybackRange(track,'warmup',0,100);
 assert.equal(warmup.start,0);assert.equal(warmup.end,100);assert.equal(warmup.trimmed,false);
 const lesson=effectivePlaybackRange(track,'lesson',3,100);assert.equal(lesson.start,60);assert.equal(lesson.end,100);
});

test('invalid, out-of-source, and nonoverlapping ranges produce a warning and no playable bounds',()=>{
 for(const trim of [null,{start:-1,end:30},{start:30,end:20},{start:0,end:101},{start:100,end:null},{start:2,end:2.01},{start:99.905,end:100.005}]){
  const track=song();track.trim=trim;
  const result=effectivePlaybackRange(track,'lesson',0,100);
  assert.equal(result.valid,false);assert.equal(result.start,null);assert.equal(result.end,null);assert.ok(result.warning);
 }
 const track=song();track.trim={start:40,end:60};
 assert.equal(effectivePlaybackRange(track,'lesson',0,100).reason,'outside-trim');
 track.weeks[1]={start:20,end:200};assert.equal(effectivePlaybackRange(track,'lesson',1,100).reason,'invalid-week');
 assert.equal(effectivePlaybackRange(song(),'lesson',9,100).valid,false);
 assert.equal(effectivePlaybackRange(song(),'warmup',0,NaN).valid,false);
});

const playlist=()=>({warmupTracks:[{id:'a',hasAudio:true},{id:'missing'},{id:'b',hasAudio:true},{id:'c',hasAudio:true}],settings:{warmupAutoNext:true,warmupListRepeat:false}});

test('warmup traversal follows saved order, skips missing audio, and stops at either list end',()=>{
 const library=playlist();
 assert.equal(nextWarmup(library,'a').id,'b');
 assert.equal(nextWarmup(library,'c',-1).id,'b');
 assert.equal(nextWarmup(library,'c'),null);assert.equal(nextWarmup(library,'a',-1),null);
 assert.equal(nextWarmup(library,'unknown').id,'a');assert.equal(nextWarmup(library,'unknown','previous').id,'c');
 library.settings.warmupAutoNext=false;
 assert.equal(nextWarmup(library,'a').id,'b','manual navigation works when auto-next is off');
});

test('list repeat wraps, skips disconnected tracks, and intentionally repeats a sole connected track',()=>{
 const library=playlist();library.settings.warmupListRepeat=true;
 assert.equal(nextWarmup(library,'c').id,'a');assert.equal(nextWarmup(library,'a',-1).id,'c');
 assert.equal(nextWarmup(library,'a',1,{connectedIds:new Set(['a'])}).id,'a');
 assert.equal(nextWarmup(library,'a',1,{connectedIds:['missing','c']}).id,'missing','live audio ids override stale flags');
 assert.equal(nextWarmup({warmupTracks:[{id:'a',hasAudio:true}],settings:{warmupListRepeat:true}},'a').id,'a');
 assert.equal(nextWarmup({warmupTracks:[{id:'a',hasAudio:true}],settings:{warmupListRepeat:false}},'a'),null);
 assert.equal(nextWarmup({warmupTracks:[]},'a'),null);
 assert.equal(nextWarmup(library,'a',0),null);
});
