import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLibrary, allLibraryTracks, validateBackup } from './next/library-model.js';

const lesson = () => ({id:'song',title:'수업곡',weeks:Array.from({length:4},(_,i)=>({start:i*10,end:(i+1)*10}))});
const legacy = () => ({version:1,selectedTeacher:'teacher',selectedTrack:'song',selectedWeek:2,
 settings:{rate:.8,volume:0,fade:2,repeat:true},teachers:[{id:'teacher',name:'쏠라',schedule:'화요일',tracks:[lesson()]}]});
const backup = library => ({type:'lessonloop-backup',version:1,library,audio:[]});
const audio = id => ({id,data:'data:audio/mpeg;base64,YXVkaW8=',type:'audio/mpeg',name:'음원.mp3'});

test('legacy migration preserves lesson references, ranges and preferences while resetting original speed', () => {
 const library=legacy(),teachers=library.teachers,track=library.teachers[0].tracks[0],weeks=structuredClone(track.weeks);
 assert.equal(normalizeLibrary(library),library);
 assert.equal(library.teachers,teachers);
 assert.equal(library.teachers[0].tracks[0],track);
 assert.deepEqual(track.weeks,weeks);
 assert.equal(library.selectedTrack,'song');assert.equal(library.selectedWeek,2);
 assert.deepEqual(library.settings,{rate:1,volume:0,fade:2,repeat:true,warmupRepeat:false,warmupAutoNext:true,warmupListRepeat:false,outputGainDb:0});
 assert.deepEqual(track.trim,{start:0,end:null});
 assert.deepEqual(library.warmupTracks,[]);assert.equal(library.selectedWarmupTrack,null);assert.equal(library.playbackMode,'lesson');
});

test('warmup selection and repeat survive migration but reopening resets a saved slow speed', () => {
 const library=legacy();library.warmupTracks=[{id:'warm1',title:'준비운동 1'},{id:'warm2',title:'준비운동 2'}];
 library.playbackMode='warmup';library.selectedWarmupTrack='warm2';library.settings.warmupRepeat=true;
 normalizeLibrary(library);
 assert.equal(library.selectedWarmupTrack,'warm2');assert.equal(library.playbackMode,'warmup');
 assert.equal(library.settings.warmupRepeat,true);assert.equal(library.settings.rate,1);
 library.selectedWarmupTrack='missing';library.settings.rate=.8;
 normalizeLibrary(library);
 assert.equal(library.selectedWarmupTrack,'warm1');assert.equal(library.settings.rate,1);
});

test('warmup tracks without weekly ranges join backups and the flattened audio list', () => {
 const library=legacy(),warmup={id:'warm',title:'준비운동',artist:'Artist'};
 library.warmupTracks=[warmup];const value=backup(library);value.audio=[audio('song'),audio('warm')];
 assert.equal(validateBackup(value),value);
 assert.deepEqual(allLibraryTracks(library),[library.teachers[0].tracks[0],warmup]);
 assert.equal('weeks' in warmup,false);
 assert.equal(validateBackup(backup(legacy())).library.settings.rate,.8,'validation alone does not mutate backups');
});

test('backup audio must reference song IDs and cannot collide across lesson and warmup tracks', () => {
 const teacherAudio=backup(legacy());teacherAudio.audio=[audio('teacher')];
 assert.throws(()=>validateBackup(teacherAudio),/음원 데이터/);
 const collision=backup(legacy());collision.library.warmupTracks=[{id:'song',title:'준비운동'}];
 assert.throws(()=>validateBackup(collision),/준비운동곡/);
 const duplicateAudio=backup(legacy());duplicateAudio.audio=[audio('song'),audio('song')];
 assert.throws(()=>validateBackup(duplicateAudio),/음원 데이터/);
 const teacherCollision=backup(legacy());teacherCollision.library.warmupTracks=[{id:'teacher',title:'준비운동'}];
 assert.throws(()=>validateBackup(teacherCollision),/준비운동곡/);
});

test('malformed warmup records and lesson ranges fail validation before restoration', () => {
 for(const warmupTracks of [null,{},[{id:'warm',title:7}],[{id:' ',title:'준비운동'}]]) {
  const value=backup(legacy());value.library.warmupTracks=warmupTracks;
  assert.throws(()=>validateBackup(value),/준비운동곡/);
 }
 const invalidRange=backup(legacy());invalidRange.library.teachers[0].tracks[0].weeks[0].end=0;
 assert.throws(()=>validateBackup(invalidRange),/주차 구간/);
 assert.deepEqual(allLibraryTracks({warmupTracks:[{id:'warm'}]}),[{id:'warm'}]);
});


test('optional output correction preserves a chosen value, defaults off, and never unmutes the library',()=>{
 const library=legacy();library.settings.outputGainDb=2;normalizeLibrary(library);
 assert.equal(library.settings.outputGainDb,2);assert.equal(library.settings.volume,0);
 for(const value of [undefined,NaN,-1,8,'invalid']){library.settings.outputGainDb=value;normalizeLibrary(library);assert.equal(library.settings.outputGainDb,0);assert.equal(library.settings.volume,0);}
});

test('track trims migrate additively without shifting source-relative lesson times or saved warmup preferences',()=>{
 const library=legacy(),song=library.teachers[0].tracks[0],sourceWeeks=structuredClone(song.weeks);
 song.trim={start:2.5,end:38};library.warmupTracks=[{id:'warm',title:'Warmup'}];
 library.settings.warmupAutoNext=false;library.settings.warmupListRepeat=true;
 normalizeLibrary(library);
 assert.deepEqual(song.trim,{start:2.5,end:38});assert.deepEqual(song.weeks,sourceWeeks);
 assert.deepEqual(library.warmupTracks[0].trim,{start:0,end:null});
 assert.equal(library.settings.warmupAutoNext,false);assert.equal(library.settings.warmupListRepeat,true);
 assert.equal(validateBackup(backup(library)).library,library);
});

test('backup validation rejects malformed trim metadata without removing old backup compatibility',()=>{
 assert.doesNotThrow(()=>validateBackup(backup(legacy())));
 for(const trim of [null,[],{start:-1,end:null},{start:'1',end:2},{start:3,end:2},{start:0,end:Infinity},{start:1,end:1.01}]){
  const library=legacy();library.teachers[0].tracks[0].trim=trim;
  assert.throws(()=>validateBackup(backup(library)),/다듬기/);
 }
 const library=legacy();library.teachers[0].tracks[0].trim={start:-1,end:30};normalizeLibrary(library);
 assert.equal(library.teachers[0].tracks[0].trim.start,-1,'malformed persisted trims stay visible for a user correction');
 const precise=legacy();precise.teachers[0].tracks[0].trim={start:5,end:5.1};
 assert.doesNotThrow(()=>validateBackup(backup(precise)),'a decimal 100ms trim should survive floating-point rounding');
});
