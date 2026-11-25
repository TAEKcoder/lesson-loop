import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSilence, analyzeSilence } from './next/silence-analysis.js';

test('suggests head/tail removal with 50ms padding and leaves original samples untouched',()=>{
 const data=new Float32Array(3000);data.fill(.2,1000,2000);const copy=data.slice();
 const result=detectSilence(data,1000);
 assert.equal(result.start,.95);assert.equal(result.end,2.05);assert.equal(result.duration,3);
 assert.equal(result.headSilence,1);assert.equal(result.tailSilence,1);assert.equal(result.changed,true);
 assert.deepEqual(data,copy);
});

test('quiet sustained attacks and audio in either stereo channel are retained conservatively',()=>{
 const left=new Float32Array(3000),right=new Float32Array(3000);
 right.fill(.0001,500,1000);right.fill(.2,1000,2000);
 const result=detectSilence([left,right],1000);
 assert.equal(result.start,.45,'quiet material below the peak threshold still counts through low RMS');
 assert.equal(result.end,2.05);
});

test('full silence is reported as an error and already tight audio has no candidate trim',()=>{
 assert.throws(()=>detectSilence(new Float32Array(3000),1000),error=>error.code==='ALL_SILENCE');
 const active=new Float32Array(1000).fill(.1);
 assert.deepEqual(detectSilence(active,1000),{start:0,end:1,duration:1,headSilence:0,tailSilence:0,padding:.05,thresholdDb:-72,changed:false});
 const edge=new Float32Array(1000);edge.fill(.1,50,950);
 assert.equal(detectSilence(edge,1000).changed,false,'tiny leading/trailing gaps should stay untouched');
 assert.throws(()=>detectSilence([new Float32Array(2),new Float32Array(3)],1000),/채널 길이/);
});

test('async analysis uses only an offline decoder and never alters the source Blob',async()=>{
 const calls=[];
 class Offline {
  constructor(...args){calls.push(args);}
  async decodeAudioData(input){assert.equal(input.byteLength,8);const data=new Float32Array(2000);data.fill(.1,500,1500);return {numberOfChannels:1,sampleRate:1000,getChannelData:()=>data};}
 }
 const blob=new Blob(['original']);
 const result=await analyzeSilence(blob,{OfflineAudioContext:Offline});
 assert.deepEqual(calls,[[2,1,22050]]);assert.equal(result.start,.45);assert.equal(result.end,1.55);
 assert.equal(await blob.text(),'original');
 await assert.rejects(analyzeSilence(blob,{signal:{aborted:true},OfflineAudioContext:Offline}),{name:'AbortError'});
 await assert.rejects(analyzeSilence(blob,{maxBytes:2,OfflineAudioContext:Offline}),error=>error.code==='FILE_TOO_LARGE');
});
