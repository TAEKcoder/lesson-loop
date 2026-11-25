import AudioEngine from './audio-engine.js?v=1.5.0';
import { prepareAudioForPlayback } from './audio-source.js';
import { effectivePlaybackRange, nextWarmup } from './playback-plan.js';
import { analyzeSilence } from './silence-analysis.js';
import { WarmupQueue } from './warmup-controller.js';
import { normalizeLibrary, allLibraryTracks, validateBackup } from './library-model.js';
import { readLibrary, saveLibrary, putAudio, getAudio, deleteAudio, restoreLibrary, parseTime, formatTime, inspectAudio, makePeaks } from './storage.js';
const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const uid = () => crypto.randomUUID();
const weekSet = (pairs) => pairs.map(([start,end]) => ({start,end}));
const seedLibrary = () => ({version:1,selectedTeacher:'solar',selectedTrack:'crash',selectedWeek:0,settings:{rate:1,volume:.8,fade:1,repeat:true},teachers:[
  {id:'solar',name:'쏠라',schedule:'화요일 오후 7:00',tracks:[{id:'crash',title:'CRASH',artist:'ALLDAY PROJECT',expectedFile:'쏠라-ALLDAY-PROJECT-CRASH.mp3',weeks:weekSet([[0,30],[30,44],[44,59],[59,74]])}]},
  {id:'juhee',name:'주희',schedule:'화요일 오후 8:00',tracks:[{id:'guitarist',title:'Guitarist',artist:'D.O.',expectedFile:'주희-DO-Guitarist.mp3',weeks:weekSet([[0,18],[13,35],[30,52],[47,61]])}]},
  {id:'blanc',name:'블랑누',schedule:'월요일 오후 8:00',tracks:[{id:'got7a',title:'A',artist:'GOT7',expectedFile:'블랑누-GOT7-A.mp3',weeks:weekSet([[84,103],[103,121],[121,140],[140,159]])}]}
]});
const requestedWarmup = () => ({id:'warmup-sunkiss',title:'SUN-KISS',artist:'TUIDE',expectedFile:'TUIDE-SUN-KISS.mp3'});
function prepareLibrary(value){
 normalizeLibrary(value);
 value.settings={volume:.8,fade:1,repeat:true,...value.settings,rate:1};
 if(!value.warmupInitialized){
  if(!value.warmupTracks.some(s=>s.id==='warmup-sunkiss'||s.expectedFile==='TUIDE-SUN-KISS.mp3'||s.fileName==='TUIDE-SUN-KISS.mp3'))value.warmupTracks.push(requestedWarmup());
  value.warmupInitialized=true;
 }
 value.selectedWarmupTrack=value.warmupTracks.find(s=>s.id===value.selectedWarmupTrack)?.id||value.warmupTracks[0]?.id||null;
 return value;
}
let library = prepareLibrary(seedLibrary());
let engine = new AudioEngine();
let activeTrackId = null, activeBlob = null, switching = 0, weekAction = 0, importMode = 'connect', sourceSwitching = false;
let saveChain = Promise.resolve(), saveRevision = 0, toastTimer, isImporting = false, restoring = false, persistenceOK = true;
let renderFrame = 0,lastVisualSignature='';
let warmupQueue, trimAnalysisAbort;
const peakJobs=new Map(), audioRevisions=new Map();let analysisGeneration=0;
function analyzeWaveform(song,blob){
 const revision=audioRevisions.get(song.id)||0,generation=analysisGeneration;
 if(song.peaks?.length||peakJobs.get(song.id)?.revision===revision)return;
 const job={revision};peakJobs.set(song.id,job);
 makePeaks(blob,700).then(peaks=>{if(peaks&&generation===analysisGeneration&&revision===(audioRevisions.get(song.id)||0)){song.peaks=peaks;persist();if(track()?.id===song.id)drawWaveform();}}).catch(()=>{}).finally(()=>{if(peakJobs.get(song.id)===job)peakJobs.delete(song.id);});
}
const teacher = () => library.teachers.find(t => t.id === library.selectedTeacher) || library.teachers[0];
const isWarmup = () => library.playbackMode==='warmup';
const lessonTrack = () => teacher()?.tracks.find(t => t.id === library.selectedTrack) || teacher()?.tracks[0];
const track = () => isWarmup() ? library.warmupTracks.find(t=>t.id===library.selectedWarmupTrack)||library.warmupTracks[0] : lessonTrack();
const sourceDuration = (song=track()) => activeTrackId===song?.id&&engine.duration ? engine.duration : song?.duration||0;
const plannedRange = () => effectivePlaybackRange(track(),isWarmup()?'warmup':'lesson',library.selectedWeek,sourceDuration());
const week = () => {const p=plannedRange();return p.valid?{start:p.start,end:p.end}:isWarmup()?{start:track()?.trim?.start||0,end:track()?.trim?.end??null}:track()?.weeks[library.selectedWeek]||{start:0,end:null};};
const repeatEnabled = () => isWarmup()?library.settings.warmupRepeat&&!library.settings.warmupAutoNext:library.settings.repeat;
const timeText = (s) => formatTime(s, Number(s) % 1 !== 0);
function toast(message,error=false){ clearTimeout(toastTimer); $('toast').textContent=message; $('toast').className=`toast show${error?' error':''}`; toastTimer=setTimeout(()=>$('toast').classList.remove('show'),error?6500:3800); }
function fail(error){console.error(error);toast(error?.message || '처리하지 못했습니다. 다시 시도해 주세요.',true);}
async function persist(){
  if(restoring)return;
  const revision=++saveRevision;
  $('save-state').innerHTML=`${icon('check')} 저장 중`; $('save-state').classList.add('unsaved');
  const snapshot=structuredClone(library);
  saveChain=saveChain.catch(()=>{}).then(()=>saveLibrary(snapshot));
  try{await saveChain;if(revision===saveRevision){$('save-state').innerHTML=`${icon('check')} 자동 저장됨`;$('save-state').classList.remove('unsaved');persistenceOK=true;}}
  catch(error){persistenceOK=false;$('save-state').textContent='저장 실패 · 백업 권장';fail(error);}
}
function renderSidebar(){
  $('teacher-count').textContent=String(library.teachers.length).padStart(2,'0');
  $('teacher-list').innerHTML=library.teachers.map(t=>`<button class="teacher-button ${t.id===library.selectedTeacher&&!isWarmup()?'active':''}" data-teacher="${esc(t.id)}" aria-pressed="${t.id===library.selectedTeacher&&!isWarmup()}"><span class="teacher-avatar">${esc(t.name.slice(0,1))}</span><span class="teacher-info"><strong>${esc(t.name)} 선생님</strong><small>${esc(t.schedule||'수업 시간 미설정')}</small></span>${t.id===library.selectedTeacher&&!isWarmup()?icon('chevron'):''}</button>`).join('');
}
function renderWarmups(){
 $('warmup-nav').classList.toggle('active',isWarmup());$('warmup-nav').setAttribute('aria-pressed',String(isWarmup()));
 $('warmup-count').textContent=`${library.warmupTracks.length}곡`;
 const next=isWarmup()?nextWarmup(library,track()?.id):null;
 $('warmup-list').innerHTML=library.warmupTracks.length?library.warmupTracks.map((s,i)=>{
  const duration=s.duration?effectivePlaybackRange(s,'warmup',0,s.duration):null;
  const trim=s.trim&&(s.trim.start>0||s.trim.end!==null);
  return `<div class="warmup-track-row ${isWarmup()&&s.id===track()?.id?'active':next?.id===s.id?'is-next':''}"><span class="warmup-row-index">${String(i+1).padStart(2,'0')}</span><button class="warmup-track-select" data-warmup="${esc(s.id)}"><span class="track-info"><strong>${esc(s.title)}${s.artist?` <span>· ${esc(s.artist)}</span>`:''}</strong><span class="warmup-track-meta"><span class="warmup-duration">${duration?.valid?timeText(duration.end-duration.start):'—'}</span>${trim?'<span class="warmup-trim-label">앞뒤 다듬음</span>':''}<span>${s.hasAudio?isWarmup()&&s.id===track()?.id?'선택됨':next?.id===s.id?'다음 곡':'재생 준비':'연결 필요'}</span></span></span></button><div class="warmup-row-actions"><button class="warmup-reorder-button" data-move-warmup="${esc(s.id)}" data-direction="-1" ${i===0?'disabled':''} aria-label="${esc(s.title)} 순서 위로">위로</button><button class="warmup-reorder-button" data-move-warmup="${esc(s.id)}" data-direction="1" ${i===library.warmupTracks.length-1?'disabled':''} aria-label="${esc(s.title)} 순서 아래로">아래로</button><button class="warmup-edit-button" data-trim-warmup="${esc(s.id)}" aria-label="${esc(s.title)} 앞뒤 자르기">다듬기</button><button class="icon-button" data-manage-warmup="${esc(s.id)}" aria-label="${esc(s.title)} 준비운동곡 관리">${icon('settings')}</button></div></div>`;
 }).join(''):`<button class="warmup-empty" id="warmup-empty-add">${icon('plus')}<span>준비운동곡을 추가하세요<small>여러 곡을 한 번에 넣고 순서대로 재생할 수 있어요</small></span></button>`;
 if($('warmup-empty-add'))$('warmup-empty-add').onclick=()=>chooseAudio('warmup');
}

function render(){
  const t=teacher(), song=track();
  renderSidebar();
  $('breadcrumb-teacher').textContent=isWarmup()?'준비운동곡':`${t.name} 선생님`;
  $('class-heading').textContent=isWarmup()?'준비운동':`${t.name} 선생님 수업`;
  $('class-schedule').textContent=isWarmup()?'모든 수업에서 함께 사용하는 준비운동곡':t.schedule||'수업 시간을 등록해 주세요';
  $('edit-teacher').innerHTML=`${icon('settings')} ${isWarmup()?'곡 관리':'수업 관리'}`;
  $('edit-teacher').disabled=isWarmup()&&!song;
  $('back-to-class').classList.toggle('hidden',!isWarmup());
  $('weeks-section').classList.toggle('hidden',isWarmup());
  $('track-title').textContent=song?.title||(isWarmup()?'준비운동곡을 추가하세요':'새로운 수업을 준비하세요');
  $('track-artist').textContent=song?.artist||(isWarmup()?'원하는 순서로 이어서 재생하세요':'음원을 추가하고 주차별 구간을 설정해 보세요');
  $('track-label').textContent=isWarmup()?'WARMUP TRACK':'CLASS TRACK';
  const info=song?.audioInfo;
  $('quality-badge').textContent=info?.format||'원본 음원';
  $('file-meta').textContent=activeBlob&&activeTrackId===song?.id ? [info?.sampleRate?`${info.sampleRate/1000} kHz`:null,info?.bitDepth?`${info.bitDepth} bit`:null,`${(activeBlob.size/1048576).toFixed(1)} MB`,'원본 재생'].filter(Boolean).join(' · '):'음원을 연결해 주세요';
  $('connect-label').textContent=song?.hasAudio?'음원 변경':'음원 연결';
  $('connect-audio').setAttribute('aria-label',song?.hasAudio?'음원 변경':'음원 연결');
  $('song-count').textContent=`${t.tracks.length} TRACK${t.tracks.length===1?'':'S'}`;
  $('track-list').innerHTML=t.tracks.length?t.tracks.map(s=>`<button class="track-row ${!isWarmup()&&s.id===song?.id?'active':''}" data-track="${esc(s.id)}"><span class="track-icon">${icon('music')}</span><span class="track-info"><strong>${esc(s.title)} <span style="color:#8b9c82;font-weight:400">· ${esc(s.artist||'아티스트 미등록')}</span></strong><small>${esc(s.fileName||s.expectedFile||'음원을 연결해 주세요')}</small></span><span class="track-status">${s.hasAudio?icon('check'):icon('upload')}${s.hasAudio?'연결됨':'연결 필요'}</span>${icon('chevron')}</button>`).join(''):'<div class="track-empty">곡 추가를 눌러 첫 음원을 등록해 주세요.</div>';
  $('edit-weeks').disabled=!song||isWarmup();
  renderWarmups();
  renderWeeks(); renderControls(); drawWaveform();
}
function renderWeeks(){
 const song=lessonTrack(), selected=library.selectedWeek, w=week();
 if(isWarmup()){
  const p=plannedRange();
  $('active-week-tag').innerHTML=`WARM UP <span>${p.trimmed?'다듬은 구간':'준비운동곡'}</span>`;
  $('range-summary').textContent=p.valid?`${timeText(p.start)} – ${timeText(p.end)} · ${repeatEnabled()?'한 곡 반복':library.settings.warmupAutoNext?'다음 곡으로 이어 재생':'한 곡 재생'}`:'음원을 연결해 주세요';
  return;
 }
 $('week-grid').innerHTML=Array.from({length:4},(_,i)=>{const item=song?.weeks[i]||{start:0,end:null},validRange=sourceDuration(song)?effectivePlaybackRange(song,'lesson',i,sourceDuration(song)):null;return `<button class="week-card ${i===selected?'active':''}" data-week="${i}" aria-pressed="${i===selected}" ${song&&!sourceSwitching&&validRange?.valid!==false?'':'disabled'} title="${esc(validRange?.valid===false?validRange.warning:'주차 선택')}"><span class="week-card-top">WEEK 0${i+1}<span class="week-dot"></span></span><h3>${i+1}주차</h3><div class="week-times">${timeText(item.start)}<i>–</i>${item.end===null?'끝까지':timeText(item.end)}</div><div class="week-card-bottom"><span>${validRange?.valid===false?'다듬기 범위 밖':item.end===null?'종료 시간 미설정':`${Math.round((item.end-item.start)*100)/100}초 구간`}</span>${i===selected?icon('volume'):icon('play')}</div></button>`;}).join('');
 $('active-week-tag').innerHTML=`WEEK 0${selected+1} <span>${selected+1}주차 구간</span>`;
 $('range-summary').textContent=`${repeatEnabled()?'반복':'연습'} 구간 ${timeText(w.start)} – ${w.end===null?'곡 끝':timeText(w.end)}`;
}
function renderControls(){
 const ready=!!activeBlob&&activeTrackId===track()?.id&&engine.duration>0;
 const busy=['loading','positioning'].includes(engine.state)||sourceSwitching,stopping=engine.state==='stopping';
 const playing=engine.state==='playing'||engine.state==='starting'||engine.rateChanging||warmupQueue?.busy;
 document.querySelectorAll('[data-week]').forEach(b=>{const song=lessonTrack(),duration=sourceDuration(song),valid=!duration||effectivePlaybackRange(song,'lesson',Number(b.dataset.week),duration).valid;b.disabled=busy||!song||isWarmup()||!valid;});
 $('play').disabled=warmupQueue?.busy?false:!ready||busy||!plannedRange().valid;
 $('restart').disabled=!ready||busy||stopping||engine.rateChanging;
 $('play').innerHTML=`${icon(playing?'pause':'play')}<span>${playing?'정지':stopping?(engine.queuedPlay?'재생 대기 중':'시작점부터 재생'):'재생'}</span>`;
 $('play').title=playing?'볼륨을 서서히 줄이고 시작점으로 돌아가기 (Space)':stopping?'페이드 정지 완료 후 시작점부터 재생':`${timeText(engine.currentTime)}에서 볼륨을 서서히 올리며 재생 (Space)`;
 $('play').setAttribute('aria-label',playing?'페이드 정지':stopping?'정지 후 시작점부터 재생':'페이드 재생');
 $('player-card').classList.toggle('is-playing',engine.isPlaying);
 $('loop').classList.toggle('active',repeatEnabled());
 $('loop').setAttribute('aria-pressed',String(repeatEnabled()));
 $('loop-note').innerHTML=`${icon('loop')} ${repeatEnabled()?(isWarmup()?'한 곡 반복':'구간 반복'):isWarmup()&&library.settings.warmupAutoNext?'연속 재생':'반복 꺼짐'}`;
 $('fade-shortcut').textContent=`${library.settings.fade.toFixed(1)}초`;
 document.querySelectorAll('[data-rate]').forEach(b=>{const on=Number(b.dataset.rate)===library.settings.rate;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));b.disabled=stopping||busy;});
 $('volume').value=library.settings.volume*100;$('volume-label').textContent=`${Math.round(library.settings.volume*100)}%`;
 const modeBadge=$('output-mode-badge');if(modeBadge)modeBadge.classList.toggle('hidden',engine.outputMode!=='native');
 const boostBadge=$('output-gain-badge');if(boostBadge){boostBadge.textContent=`음량 +${library.settings.outputGainDb} dB`;boostBadge.classList.toggle('hidden',!library.settings.outputGainDb);}
 const stateNames={positioning:'시작점 준비 중','segment-ended':'재생 범위 완료',loading:'음원 불러오는 중',starting:'재생 준비 중',playing:'재생 중',pausing:'전환 준비 중',paused:'정지',stopping:engine.queuedPlay?'페이드 정지 후 처음부터 재생 대기':'볼륨을 줄인 뒤 시작점으로 이동 중',stopped:'정지 · 시작점에서 대기',ready:'재생 준비 완료',ended:'곡 재생 완료',error:'음원을 확인해 주세요',empty:'음원 연결 대기'};
 $('playback-state').textContent=stateNames[engine.state]||'재생 준비';
 if(!ready&&!busy)$('playback-state').textContent='음원 연결 대기';
 if(ready&&!plannedRange().valid)$('playback-state').textContent=plannedRange().warning;
 if(engine.rateChanging)$('playback-state').textContent='배속 전환 중 · 현재 위치에서 이어 재생';
 if(warmupQueue?.busy)$('playback-state').textContent='다음 준비운동곡 준비 중';
 $('seek').disabled=!ready||stopping||busy||engine.rateChanging||!!warmupQueue?.busy; $('seek').max=engine.duration||100;
 $('duration').textContent=ready?formatTime(engine.duration):'--:--';
 $('restart').title=isWarmup()?'곡 처음부터 재생 (R)':'선택한 주차 시작부터 재생 (R)';
 $('restart').setAttribute('aria-label',isWarmup()?'곡 처음부터 재생':'주차 시작부터 재생');
 $('loop').setAttribute('aria-label',isWarmup()?'한 곡 반복':'구간 반복');
 $('loop').title=isWarmup()?'한 곡 반복 · 연속 재생과 함께 켤 수 없어요':'구간 반복 (L)';
 if($('edit-play-range'))$('edit-play-range').disabled=!track();
 renderQueueControls();
 updateTime();
}
function renderQueueControls(){
 const controls=$('warmup-queue-controls');if(!controls)return;
 controls.classList.toggle('hidden',!isWarmup());
 const next=nextWarmup(library,track()?.id),previous=nextWarmup(library,track()?.id,-1);
 const caption=controls.querySelector('.queue-next-preview>span:first-child');if(caption)caption.textContent=next?'다음':'목록';
 $('warmup-next-label').textContent=next?next.title:library.warmupTracks.length?'마지막 곡입니다':'준비운동곡을 추가하세요';
 $('warmup-prev').disabled=!previous||sourceSwitching||!!warmupQueue?.busy;
 $('warmup-next').disabled=!next||sourceSwitching||!!warmupQueue?.busy;
 $('warmup-auto-next').setAttribute('aria-pressed',String(library.settings.warmupAutoNext));
 $('warmup-list-repeat').setAttribute('aria-pressed',String(library.settings.warmupListRepeat));
}
function updateTime(){
 const text=formatTime(engine.currentTime);if($('current-time').textContent!==text)$('current-time').textContent=text;
 if(engine.state==='stopped'||document.activeElement!==$('seek'))$('seek').value=engine.currentTime;
 renderFadeMonitor();
 if(!renderFrame)renderFrame=requestAnimationFrame(()=>{renderFrame=0;drawWaveform();});
}
function renderFadeMonitor(){
 const monitor=$('fade-monitor'), visual=engine.visualState;
 if(!monitor||!visual)return;
 const level=Math.max(0,Math.min(1,visual.envelopeLevel)), percent=Math.round(level*100);
 const signature=[level.toFixed(4),visual.progress.toFixed(4),visual.phase,visual.muted,engine.isPlaying].join('|');
 if(signature===lastVisualSignature)return;lastVisualSignature=signature;
 monitor.style.setProperty('--fade-level',level.toFixed(4));
 monitor.style.setProperty('--fade-progress',visual.progress.toFixed(4));
 monitor.dataset.phase=visual.phase;
 monitor.dataset.muted=String(visual.muted);
 const status=visual.phase==='in'?'페이드 인':visual.phase==='out'?'페이드 아웃':engine.isPlaying?'유지':'대기';
 if($('fade-status').textContent!==status)$('fade-status').textContent=status;
 $('fade-value').textContent=`${percent}%`;
 monitor.setAttribute('aria-valuenow',String(percent));
 monitor.setAttribute('aria-valuetext',`${percent}%${visual.muted?' · 음소거':''}`);
}
function applyLoop(){
 const p=plannedRange();
 if(!p.valid){engine.setLoop(0,0,false);engine.clearPlaybackRange();return false;}
 engine.setLoop(p.start,p.end,repeatEnabled());
 const full=effectivePlaybackRange(track(),'warmup',0,sourceDuration());
 if(full.valid)engine.setPlaybackRange(full.start,full.end,{enabled:true,fadeOutSeconds:library.settings.fade});
 if(p.warning)toast(p.warning);
 return true;
}
async function loadCurrent(options={}){
 if(!options.fromQueue){warmupQueue?.cancel();if(!isWarmup())warmupQueue?.invalidate();}
 const request=++switching;weekAction++;
 sourceSwitching=true;renderControls();
 try{
 await engine.pause();if(request!==switching)return;
 engine.clearPlaybackRange();
 if(options.resetRate!==false){library.settings.rate=1;engine.setRate(1);}
 const song=track();activeBlob=null;activeTrackId=null;
 if(!song){engine.dispose();engine=new AudioEngine();wireEngine();applySettings();render();return;}
 try{
  const entry=options.entry?.id===song.id?options.entry:null;
  const blob=entry?.blob||await getAudio(song.id);if(request!==switching)return;
  if(!blob){song.hasAudio=false;engine.dispose();engine=new AudioEngine();wireEngine();applySettings();render();return;}
  activeBlob=blob;activeTrackId=song.id;
  await engine.load(blob,entry?{prepared:entry.prepared}:{});if(request!==switching)return;
  song.duration=engine.duration;
  const p=plannedRange();if(!p.valid)throw new Error(p.warning);
  const positioned=await engine.preparePosition(p.start);if(request!==switching)return;
  if(!positioned){activeBlob=null;render();return;}
  song.hasAudio=true;analyzeWaveform(song,blob);applyLoop();render();
 }catch(error){if(error.name!=='AbortError')fail(error);if(request===switching){activeBlob=null;render();}}
 }finally{if(request===switching){sourceSwitching=false;renderControls();if(isWarmup())prefetchWarmup();}}
}
function prefetchWarmup(){
 if(!warmupQueue||!isWarmup()||!library.settings.warmupAutoNext||!track())return;
 warmupQueue.prepareNext(track().id).then(()=>{if(isWarmup()){renderWarmups();renderQueueControls();}}).catch(()=>{});
}
function stopPlayback(){
 warmupQueue?.cancel();
 if(sourceSwitching)return engine.pause();
 return engine.stop(week().start);
}
async function advanceWarmup(direction=1,automatic=false){
 if(!isWarmup()||!track()||sourceSwitching)return false;
 const autoplay=automatic||engine.isPlaying||engine.state==='starting'||engine.rateChanging;
 return warmupQueue.advance(track().id,{direction,automatic,autoplay});
}
function moveWarmup(id,direction){
 const index=library.warmupTracks.findIndex(song=>song.id===id),next=index+direction;
 if(index<0||next<0||next>=library.warmupTracks.length)return;
 warmupQueue.cancel();warmupQueue.invalidate();
 const [song]=library.warmupTracks.splice(index,1);library.warmupTracks.splice(next,0,song);
 renderWarmups();renderQueueControls();persist();prefetchWarmup();
}

function applySettings(){engine.setRate(library.settings.rate);engine.setVolume(library.settings.volume);engine.setFade(library.settings.fade);engine.setOutputGainDb(library.settings.outputGainDb);}
function wireEngine(){
 engine.on('timeupdate',updateTime);
 engine.on('outputgainchange',snapshot=>{
  const changed=library.settings.outputGainDb!==snapshot.outputGainDb;
  library.settings.outputGainDb=snapshot.outputGainDb;
  const select=$('output-gain-setting');if(select)select.value=String(snapshot.outputGainDb);
  renderControls();if(changed)persist();
 });
 engine.on('statechange',snapshot=>{
  renderControls();
  if(snapshot.state==='ended'&&activeBlob&&activeTrackId===track()?.id&&!sourceSwitching&&!warmupQueue?.busy)engine.stop(week().start);
 });
 engine.on('segmentend',()=>{
  if(sourceSwitching||restoring||!activeBlob||activeTrackId!==track()?.id||warmupQueue?.busy)return;
  if(isWarmup()&&library.settings.warmupAutoNext&&!repeatEnabled())advanceWarmup(1,true).catch(fail);
  else engine.stop(week().start);
 });
 engine.on('error',({error,message})=>toast(error?.name==='NotAllowedError'?'브라우저가 재생을 막았습니다. 재생 버튼을 다시 눌러 주세요.':message||'지원하지 않는 음원입니다. 다른 파일을 연결해 주세요.',true));
}
warmupQueue=new WarmupQueue({
 library:()=>library,getAudio,prepare:prepareAudioForPlayback,
 load:async entry=>{library.selectedWarmupTrack=entry.id;await loadCurrent({entry,resetRate:false,fromQueue:true});await persist();render();return activeTrackId===entry.id&&!!activeBlob&&engine.state!=='error';},
 play:()=>engine.play(),onState:()=>renderControls(),
 onMissing:song=>{song.hasAudio=false;persist();renderWarmups();},
 onComplete:async({automatic})=>{if(automatic){await engine.stop(week().start);toast('준비운동 재생목록을 모두 재생했습니다.');}else toast('이 방향에 연결된 준비운동곡이 없습니다.');},
 onError:fail,
});
wireEngine();
function drawWaveform(){
 const canvas=$('waveform'), rect=canvas.getBoundingClientRect();if(!rect.width)return;
 const dpr=window.devicePixelRatio||1,w=Math.round(rect.width*dpr),h=Math.round(rect.height*dpr);
 if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
 const c=canvas.getContext('2d');c.clearRect(0,0,w,h);
 const song=track(),dur=activeTrackId===song?.id?engine.duration:0,range=week();
 const xstart=dur?Math.min(w,range.start/dur*w):0,xend=dur?Math.min(w,(range.end??dur)/dur*w):w*.28;
 c.fillStyle=dur?'#cbf9940e':'#cbf99405';c.fillRect(xstart,0,xend-xstart,h);
 const peaks=song?.peaks;
 $('waveform-empty').classList.toggle('hidden',!!(activeBlob&&activeTrackId===song?.id));
 const bars=Math.max(50,Math.floor(rect.width/4.5)),barWidth=Math.max(1,dpr*2),mid=h*.51;
 for(let i=0;i<bars;i++){
  const x=i/bars*w,peak=peaks?.length?peaks[Math.floor(i/bars*peaks.length)]:.035;
  const height=Math.max(2*dpr,Math.min(.85,peak)*h*.88);
  c.fillStyle=dur&&x>=xstart&&x<=xend?(x<=engine.currentTime/dur*w?'#d8ffb0':'#91ab76'):'#4b5850';
  c.fillRect(x,mid-height/2,barWidth,height);
 }
 if(dur){
  c.strokeStyle='#bcdc97';c.lineWidth=dpr;c.setLineDash([3*dpr,3*dpr]);
  [xstart,xend].forEach(x=>{c.beginPath();c.moveTo(x,0);c.lineTo(x,h);c.stroke();});c.setLineDash([]);
  const x=Math.min(w,engine.currentTime/dur*w);c.strokeStyle='#e0f6cc';c.lineWidth=1.5*dpr;c.beginPath();c.moveTo(x,3*dpr);c.lineTo(x,h);c.stroke();
  c.fillStyle='#d4f9ae';c.beginPath();c.moveTo(x-4*dpr,0);c.lineTo(x+4*dpr,0);c.lineTo(x,5*dpr);c.fill();
 }
}
async function selectWeek(index){
 if(isWarmup()||!track()||sourceSwitching||engine.state==='loading'||engine.state==='positioning')return;
 const action=++weekAction;
 if(!await engine.pause()||action!==weekAction)return;
 library.selectedWeek=index;if(!activeBlob){await loadCurrent({resetRate:false});render();persist();return;}applyLoop();await engine.preparePosition(week().start);renderWeeks();renderControls();drawWaveform();persist();
}
async function selectTeacher(id){
 const sameTeacher=id===library.selectedTeacher;
 if(sameTeacher&&!isWarmup())return;
 library.playbackMode='lesson';library.selectedTeacher=id;
 if(!sameTeacher){library.selectedTrack=teacher()?.tracks[0]?.id||null;library.selectedWeek=0;}
 renderSidebar();await loadCurrent();render();persist();
}
async function selectTrack(id){
 if(id===lessonTrack()?.id&&!isWarmup()){if(!activeBlob)chooseAudio('connect');return;}
 library.playbackMode='lesson';library.selectedTrack=id;library.selectedWeek=0;await loadCurrent();render();persist();
}
async function selectWarmup(id){
 const next=library.warmupTracks.find(s=>s.id===id)||library.warmupTracks[0];
 if(isWarmup()&&next?.id===track()?.id){if(next&&!activeBlob)chooseAudio('warmup-connect');return;}
 library.playbackMode='warmup';library.selectedWarmupTrack=next?.id||null;
 await loadCurrent();render();await persist();
 if(next&&!activeBlob)chooseAudio('warmup-connect');
}
function chooseAudio(mode){importMode=mode;$('audio-input').value='';$('audio-input').click();}
async function connectFile(file,targetTeacher,targetTrack){
 warmupQueue.invalidate(targetTrack.id);
 if(!file.size)throw new Error(`${file.name}: 비어 있는 파일입니다.`);
 const info=await inspectAudio(file);
 // Check browser decoding before committing the file, leaving an existing track intact on error.
 const probe=new Audio();probe.preload='metadata';const url=URL.createObjectURL(file);
 let duration;
 try{duration=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{cleanup();reject(new Error(`${file.name}: 음원을 읽는 데 시간이 오래 걸립니다. 지원 형식을 확인해 주세요.`));},20000);const cleanup=()=>{clearTimeout(timeout);probe.onloadedmetadata=null;probe.onerror=null;};probe.onloadedmetadata=()=>{cleanup();Number.isFinite(probe.duration)&&probe.duration>0?resolve(probe.duration):reject(new Error(`${file.name}: 곡 길이를 확인할 수 없습니다.`));};probe.onerror=()=>{cleanup();reject(new Error(`${file.name}: 이 브라우저에서 지원하지 않는 음원입니다.`));};probe.src=url;});}finally{probe.removeAttribute('src');probe.load();URL.revokeObjectURL(url);}
 await putAudio(targetTrack.id,file);
 warmupQueue.invalidate(targetTrack.id);audioRevisions.set(targetTrack.id,(audioRevisions.get(targetTrack.id)||0)+1);delete targetTrack.peaks;
 targetTrack.fileName=file.name;targetTrack.audioInfo=info;targetTrack.hasAudio=true;targetTrack.duration=duration;
 await persist();
 // Waveform analysis is optional and never blocks original file playback.
 analyzeWaveform(targetTrack,file);
}
async function importAudio(files){
 if(isImporting||restoring){toast('현재 음원 작업이 끝난 뒤 다시 선택해 주세요.');return;}isImporting=true;
 warmupQueue.cancel();
 const inputFiles=[...files].filter(f=>/\.(mp3|wav|flac|m4a|aac|ogg|opus|aif|aiff|webm)$/i.test(f.name)||f.type.startsWith('audio/'));
 if(!inputFiles.length){toast('음원 파일을 선택해 주세요.',true);isImporting=false;return;}
 const mode=importMode, importingWarmup=mode==='warmup'||mode==='warmup-connect',targetTeacher=teacher(),currentSong=track();
 let count=0;const errors=[];let firstImported=null,firstLessonImported=null;
 try{
  await engine.pause();
  for(const file of inputFiles){
   const normalized=file.name.normalize('NFC').toLowerCase();
   const pool=importingWarmup?library.warmupTracks:mode==='bulk'?allLibraryTracks(library):targetTeacher.tracks;
   let targetTrack=inputFiles.length===1&&(mode==='connect'||mode==='warmup-connect')?currentSong:pool.find(s=>s.expectedFile?.normalize('NFC').toLowerCase()===normalized||s.fileName?.normalize('NFC').toLowerCase()===normalized);
   const targetList=importingWarmup?library.warmupTracks:targetTeacher.tracks;
   let newlyAdded=false;
   if(!targetTrack&&inputFiles.length===1&&currentSong&&(mode==='connect'||mode==='warmup-connect'))targetTrack=currentSong;
   if(!targetTrack){targetTrack={id:uid(),title:file.name.replace(/\.[^.]+$/,''),artist:''};if(!importingWarmup)targetTrack.weeks=weekSet([[0,null],[0,null],[0,null],[0,null]]);targetList.push(targetTrack);newlyAdded=true;}
   toast(`${file.name} 연결 중…`);
   try{await connectFile(file,targetTeacher,targetTrack);count++;firstImported??=targetTrack.id;if(targetTeacher.tracks.some(s=>s.id===targetTrack.id))firstLessonImported??=targetTrack.id;}
   catch(error){errors.push(error.message);if(newlyAdded)targetList.splice(targetList.indexOf(targetTrack),1);}
  }
  if(importingWarmup&&firstImported){library.playbackMode='warmup';library.selectedWarmupTrack=firstImported;}
  else if(!importingWarmup&&firstLessonImported&&(!library.selectedTrack||mode==='add')){library.playbackMode='lesson';library.selectedTeacher=targetTeacher.id;library.selectedTrack=firstLessonImported;library.selectedWeek=0;}
  await loadCurrent();await persist();render();
  if(errors.length)toast(`${count}곡 연결 완료. ${errors.join(' ')}`,true);else toast(importingWarmup?`준비운동곡 ${count}곡을 연결했습니다. 기본 1배속으로 재생해요.`:`${count}곡을 연결했습니다. 주차를 고르고 재생하세요.`);
  navigator.storage?.persist?.().catch(()=>{});
 }finally{isImporting=false;}
}
function showModal(title,html,eyebrow='LESSON LOOP'){trimAnalysisAbort?.abort();trimAnalysisAbort=null;$('modal-title').textContent=title;$('modal-eyebrow').textContent=eyebrow;$('modal-body').innerHTML=html;if(!$('modal').open)$('modal').showModal();}
function closeModal(){trimAnalysisAbort?.abort();trimAnalysisAbort=null;$('modal').close();}
function editWeeks(){
 const song=track();if(!song||isWarmup())return;
 showModal('주차별 구간 편집',`<p class="modal-note">${esc(song.title)} · 시작과 끝을 한 번에 입력해 두세요.<br>분:초 또는 분:초.소수점 형식으로 입력할 수 있어요. 주차 간 구간이 겹쳐도 괜찮아요.</p><form id="weeks-form"><div class="week-edit-header"><span>주차</span><span>시작 시간</span><span>종료 시간</span></div>${song.weeks.map((w,i)=>`<div class="week-edit-row"><label for="week-start-${i}">${i+1}주차</label><input type="text" id="week-start-${i}" name="start${i}" value="${timeText(w.start)}" aria-label="${i+1}주차 시작 시간" inputmode="decimal" autocomplete="off" required><input type="text" name="end${i}" value="${w.end===null?'':timeText(w.end)}" placeholder="곡 끝까지" aria-label="${i+1}주차 종료 시간" inputmode="decimal" autocomplete="off"></div>`).join('')}<p class="modal-note">종료 시간을 비워 두면 곡 끝까지 재생합니다.${song.duration?` 음원 길이: ${formatTime(song.duration)}`:''}</p><p class="form-error" id="weeks-error" role="alert"></p><div class="modal-actions"><button type="button" class="secondary-button" id="weeks-cancel">취소</button><button type="submit" class="primary-button">구간 저장</button></div></form>`,'4 WEEKS / REPEAT');
 $('weeks-cancel').onclick=closeModal;
 $('weeks-form').onsubmit=async e=>{
  e.preventDefault();const data=new FormData(e.target);const next=[];
  for(let i=0;i<4;i++){
   const start=parseTime(data.get(`start${i}`)),endRaw=data.get(`end${i}`).trim(),end=endRaw?parseTime(endRaw):null;
   if(start===null||(endRaw&&end===null)){$('weeks-error').textContent=`${i+1}주차 시간을 확인해 주세요. 예: 00:30 또는 01:24.50`;return;}
   if(end!==null&&end-start<.1){$('weeks-error').textContent=`${i+1}주차 종료는 시작보다 0.1초 이상 뒤여야 해요.`;return;}
   if(song.duration&&(start>=song.duration||(end!==null&&end>song.duration+.02))){$('weeks-error').textContent=`${i+1}주차 구간이 음원 길이 ${formatTime(song.duration)}를 벗어났어요.`;return;}
   next.push({start,end});
  }
  await engine.pause();song.weeks=next;applyLoop();engine.seek(week().start);await persist();render();closeModal();toast('4주차 구간을 저장했습니다.');
 };
}
async function editPlayRange(song=track()){
 if(!song)return;
 warmupQueue.cancel();await engine.pause();
 let duration=sourceDuration(song),draft={start:song.trim?.start||0,end:song.trim?.end??null};
 const active=track()?.id===song.id;
 showModal('앞뒤 무음 다듬기',`<div class="trim-editor"><p class="modal-note"><strong>${esc(song.title)}</strong> · 파형의 양 끝을 움직이거나 시간을 입력하세요.</p><div class="trim-original-note">원본 음원을 그대로 보관하고 지정한 범위만 재생합니다. 수업 주차 시간은 원본 시간 기준으로 유지됩니다.</div><div class="trim-waveform-wrap" id="trim-wave" style="--trim-start:0;--trim-end:1"><canvas id="trim-waveform" aria-hidden="true"></canvas><div class="trim-selected-region" aria-hidden="true"></div><button type="button" class="trim-handle is-start" data-trim-boundary="start" aria-label="재생 시작점 조절"></button><button type="button" class="trim-handle is-end" data-trim-boundary="end" aria-label="재생 종료점 조절"></button></div><div class="trim-summary" id="trim-summary"></div><form id="trim-form" data-track-id="${esc(song.id)}"><div class="trim-time-grid"><label for="trim-start">재생 시작<input id="trim-start" type="text" inputmode="decimal" value="${timeText(draft.start)}" required autocomplete="off"></label><label for="trim-end">재생 종료<input id="trim-end" type="text" inputmode="decimal" value="${draft.end===null?'':timeText(draft.end)}" placeholder="곡 끝까지" autocomplete="off"></label></div><div class="trim-point-actions"><button type="button" class="secondary-button" id="trim-start-current" ${active?'':'disabled'}>현재 위치를 시작으로</button><button type="button" class="secondary-button" id="trim-end-current" ${active?'':'disabled'}>현재 위치를 끝으로</button></div><div class="trim-tools"><button type="button" class="trim-detect-button" id="trim-detect">앞뒤 무음 찾기</button><button type="button" class="text-button" id="trim-reset">전체 범위로 되돌리기</button></div><p class="trim-detect-status" id="trim-detect-status" role="status">무음 찾기는 제안만 표시합니다. 확인한 뒤 저장해 주세요.</p><p class="form-error" id="trim-error" role="alert"></p><div class="modal-actions"><button type="button" class="secondary-button" id="trim-cancel">취소</button><button class="primary-button" id="trim-save" type="submit">재생 범위 저장</button></div></form></div>`,'PLAY RANGE');
 const startInput=$('trim-start'),endInput=$('trim-end'),wave=$('trim-wave');
 const values=()=>({start:parseTime(startInput.value),end:endInput.value.trim()?parseTime(endInput.value):null});
 const paint=()=>{
  if(!$('trim-form'))return;
  const value=values(),end=value.end??duration;
  if(value.start===null||(endInput.value.trim()&&value.end===null)){ $('trim-summary').textContent='분:초 형식으로 시간을 입력하세요.';return; }
  wave.style.setProperty('--trim-start',duration?Math.min(1,value.start/duration):0);
  wave.style.setProperty('--trim-end',duration?Math.min(1,end/duration):1);
  $('trim-summary').textContent=duration&&end>value.start?`${timeText(value.start)} – ${timeText(end)} · ${timeText(end-value.start)} 재생 · 앞 ${timeText(value.start)}, 뒤 ${timeText(Math.max(0,duration-end))} 제외`:duration?'종료 시간은 시작 시간보다 뒤여야 합니다.':'음원을 연결하면 파형과 길이를 확인할 수 있어요.';
  const canvas=$('trim-waveform'),rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  canvas.width=Math.max(1,Math.round(rect.width*dpr));canvas.height=Math.max(1,Math.round(rect.height*dpr));
  const c=canvas.getContext('2d'),bars=Math.max(50,Math.floor(rect.width/5)),w=canvas.width,h=canvas.height;
  c.clearRect(0,0,w,h);
  for(let i=0;i<bars;i++){const t=i/bars*(duration||1),peak=song.peaks?.[Math.floor(i/bars*song.peaks.length)]||.04,height=Math.max(3*dpr,peak*h*.85);c.fillStyle=t>=value.start&&t<=end?'#c3ec9a':'#4b5750';c.fillRect(i/bars*w,(h-height)/2,2*dpr,height);}
 };
 const assign=(start,end)=>{startInput.value=timeText(start);endInput.value=end===null?'':timeText(end);paint();};
 startInput.oninput=endInput.oninput=paint;
 $('trim-start-current').onclick=()=>assign(engine.currentTime,values().end);
 $('trim-end-current').onclick=()=>assign(values().start??0,engine.currentTime);
 $('trim-reset').onclick=()=>{assign(0,null);$('trim-detect-status').textContent='전체 범위를 표시했습니다. 저장하면 적용됩니다.';};
 $('trim-cancel').onclick=closeModal;
 let dragging=null;
 const place=(event,boundary)=>{
  if(!duration)return;const rect=wave.getBoundingClientRect(),time=Math.round(Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width))*duration*100)/100,value=values(),end=value.end??duration,start=value.start??0;
  if(boundary==='start')assign(Math.max(0,Math.min(time,end-.1)),value.end);else assign(start,Math.max(start+.1,Math.min(duration,time)));
 };
 wave.onpointerdown=event=>{if(!duration)return;const v=values(),rect=wave.getBoundingClientRect(),point=(event.clientX-rect.left)/rect.width*duration;dragging=event.target.closest('[data-trim-boundary]')?.dataset.trimBoundary||(Math.abs(point-(v.start||0))<=Math.abs(point-(v.end??duration))?'start':'end');event.preventDefault();wave.setPointerCapture(event.pointerId);place(event,dragging);};
 wave.onpointermove=event=>{if(dragging)place(event,dragging);};wave.onpointerup=wave.onpointercancel=()=>{dragging=null;};
 wave.querySelectorAll('[data-trim-boundary]').forEach(handle=>handle.onkeydown=event=>{if(!duration||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const v=values(),step=event.shiftKey?1:.1,isStart=handle.dataset.trimBoundary==='start',current=isStart?v.start??0:v.end??duration,time=event.key==='Home'?0:event.key==='End'?duration:current+(event.key==='ArrowRight'?step:-step);if(isStart)assign(Math.max(0,Math.min(time,(v.end??duration)-.1)),v.end);else assign(v.start??0,Math.min(duration,Math.max((v.start??0)+.1,time)));});
 $('trim-detect').onclick=async()=>{
  const button=$('trim-detect');button.disabled=true;$('trim-save').disabled=true;$('trim-detect-status').textContent='앞뒤 무음을 분석하고 있어요. 스피커로 재생하지 않습니다.';
  trimAnalysisAbort?.abort();const controller=new AbortController();trimAnalysisAbort=controller;
  try{const blob=await getAudio(song.id);if(!blob)throw new Error('먼저 이 곡의 음원을 연결해 주세요.');const result=await analyzeSilence(blob,{signal:controller.signal});if(controller.signal.aborted||$('trim-form')?.dataset.trackId!==song.id)return;duration=result.duration;assign(result.start,result.end>=duration-.01?null:result.end);$('trim-detect-status').textContent=result.changed?'앞뒤 무음 후보를 표시했습니다. 음악 시작과 끝을 확인한 뒤 저장해 주세요.':'제외할 만한 앞뒤 무음이 없어 전체 범위를 표시했습니다.';}
  catch(error){if(error.name!=='AbortError'&&$('trim-detect-status'))$('trim-detect-status').textContent=error.message;}
  finally{if(trimAnalysisAbort===controller)trimAnalysisAbort=null;if(button.isConnected){button.disabled=false;if($('trim-save'))$('trim-save').disabled=false;}}
 };
 $('trim-form').onsubmit=async event=>{
  event.preventDefault();const value=values(),end=value.end??duration;
  if(value.start===null||(endInput.value.trim()&&value.end===null)||value.start<0||(value.end!==null&&value.end-value.start<.1)||(duration&&(value.start>=duration||end>duration+.01||end-value.start<.1))){$('trim-error').textContent='시작·종료 시간을 확인해 주세요. 최소 0.1초 이상 남겨야 합니다.';return;}
  warmupQueue.cancel();warmupQueue.invalidate(song.id);await engine.pause();song.trim=value;
  if(active&&activeBlob){const p=plannedRange(),full=effectivePlaybackRange(song,'warmup',0,sourceDuration());applyLoop();if(full.valid)await engine.preparePosition(p.valid?p.start:full.start);}
  await persist();render();closeModal();prefetchWarmup();toast('앞뒤 재생 범위를 저장했습니다. 원본 음원은 그대로 보관합니다.');
 };
 requestAnimationFrame(paint);
}

function editWarmup(id){
 const song=library.warmupTracks.find(s=>s.id===id);if(!song)return;
 showModal('준비운동곡 관리',`<form id="warmup-form"><label class="form-field"><span>곡 제목</span><input name="title" type="text" maxlength="150" value="${esc(song.title)}" required></label><label class="form-field"><span>아티스트</span><input name="artist" type="text" maxlength="100" value="${esc(song.artist)}"></label><p class="modal-note">모든 선생님 수업에서 함께 사용할 수 있어요. 기본 재생 속도는 1배속입니다.</p><div class="modal-actions"><button type="button" class="danger-button" id="remove-warmup">곡 삭제</button><button type="button" class="secondary-button" id="warmup-cancel">취소</button><button type="submit" class="primary-button">저장</button></div></form>`,'WARMUP TRACK');
 $('warmup-cancel').onclick=closeModal;
 $('warmup-form').onsubmit=async e=>{e.preventDefault();const data=new FormData(e.target),title=data.get('title').trim();if(!title){toast('곡 제목을 입력해 주세요.',true);return;}song.title=title;song.artist=data.get('artist').trim();await persist();render();closeModal();toast('준비운동곡 정보를 저장했습니다.');};
 $('remove-warmup').onclick=()=>{
  showModal('준비운동곡을 삭제할까요?',`<p class="modal-note">${esc(song.title)}의 기기 저장본만 삭제됩니다. 원래 음원 파일은 그대로 유지됩니다.</p><div class="modal-actions"><button class="secondary-button" id="warmup-delete-cancel">취소</button><button class="primary-button" id="warmup-delete-confirm">곡 삭제</button></div>`);
  $('warmup-delete-cancel').onclick=()=>editWarmup(song.id);
  $('warmup-delete-confirm').onclick=async()=>{const active=isWarmup()&&track()?.id===song.id;if(active)await engine.pause();warmupQueue.cancel();warmupQueue.invalidate(song.id);await deleteAudio(song.id);library.warmupTracks=library.warmupTracks.filter(s=>s.id!==song.id);if(library.selectedWarmupTrack===song.id)library.selectedWarmupTrack=library.warmupTracks[0]?.id||null;if(active)await loadCurrent();await persist();render();closeModal();toast('준비운동곡을 삭제했습니다.');};
 };
}
function editTeacher(isNew=false){
 const t=teacher();
 showModal(isNew?'선생님 추가':'수업 관리',`<form id="teacher-form"><label class="form-field"><span>선생님 이름</span><input name="name" type="text" maxlength="30" value="${isNew?'':esc(t.name)}" placeholder="예: 쏠라" required></label><label class="form-field"><span>수업 일정</span><input name="schedule" type="text" maxlength="80" value="${isNew?'':esc(t.schedule)}" placeholder="예: 화요일 오후 7:00"></label>${!isNew&&track()?`<label class="form-field"><span>현재 곡 제목</span><input name="title" type="text" maxlength="150" value="${esc(track().title)}" required></label><label class="form-field"><span>아티스트</span><input name="artist" type="text" maxlength="100" value="${esc(track().artist)}"></label>`:''}${!isNew&&track()?'<button type="button" class="text-button" id="delete-song">현재 곡 삭제</button>':''}<div class="form-error" id="teacher-error" role="alert"></div><div class="modal-actions">${!isNew?'<button type="button" class="danger-button" id="delete-class">수업 삭제</button>':''}<button type="button" class="secondary-button" id="teacher-cancel">취소</button><button type="submit" class="primary-button">${isNew?'추가':'저장'}</button></div></form>`,'CLASS SETTINGS');
 $('teacher-cancel').onclick=closeModal;
 $('teacher-form').onsubmit=async e=>{e.preventDefault();const data=new FormData(e.target),name=data.get('name').trim();if(!name){$('teacher-error').textContent='선생님 이름을 입력해 주세요.';return;}
  if(isNew){library.playbackMode='lesson';const id=uid();library.teachers.push({id,name,schedule:data.get('schedule').trim(),tracks:[]});library.selectedTeacher=id;library.selectedTrack=null;library.selectedWeek=0;await loadCurrent();}
  else{t.name=name;t.schedule=data.get('schedule').trim();if(track()){const title=data.get('title').trim();if(!title){$('teacher-error').textContent='곡 제목을 입력해 주세요.';return;}track().title=title;track().artist=data.get('artist').trim();}}
  await persist();render();closeModal();toast(isNew?'새 수업을 추가했습니다. 곡을 연결해 주세요.':'수업 정보를 저장했습니다.');};
 if(!isNew){$('delete-class').onclick=()=>showDeleteClass(t);if($('delete-song'))$('delete-song').onclick=()=>showDeleteSong(t,track());}
}
function showDeleteSong(t,song){
 showModal('이 곡을 삭제할까요?',`<p class="modal-note">${esc(song.title)}의 기기 저장본과 4주차 구간이 삭제됩니다. 원래 음원 파일은 그대로 유지됩니다.</p><div class="modal-actions"><button class="secondary-button" id="song-delete-cancel">취소</button><button class="primary-button" id="song-delete-confirm">곡 삭제</button></div>`);
 $('song-delete-cancel').onclick=()=>editTeacher();
 $('song-delete-confirm').onclick=async()=>{await engine.pause();await deleteAudio(song.id);t.tracks=t.tracks.filter(s=>s.id!==song.id);library.selectedTrack=t.tracks[0]?.id||null;library.selectedWeek=0;await loadCurrent();await persist();render();closeModal();toast('곡을 삭제했습니다.');};
}
function showDeleteClass(t){
 showModal('이 수업을 삭제할까요?',`<p class="modal-note">${esc(t.name)} 선생님의 수업과 연결된 ${t.tracks.length}곡의 기기 저장본, 주차 설정이 삭제됩니다. 원래 음원 파일은 그대로 유지됩니다.</p><div class="modal-actions"><button class="secondary-button" id="delete-cancel">취소</button><button class="primary-button" id="confirm-delete">수업 삭제</button></div>`);
 $('delete-cancel').onclick=()=>editTeacher();
 $('confirm-delete').onclick=async()=>{await engine.pause();for(const s of t.tracks)await deleteAudio(s.id);library.teachers=library.teachers.filter(x=>x.id!==t.id);if(!library.teachers.length)library.teachers=[{id:uid(),name:'나의',schedule:'',tracks:[]}];library.selectedTeacher=library.teachers[0].id;library.selectedTrack=teacher().tracks[0]?.id||null;library.selectedWeek=0;await loadCurrent();await persist();render();closeModal();toast('수업을 삭제했습니다.');};
}
function showSettings(){
 const nativeOutput=engine.outputMode==='native';
 showModal('재생 설정 · 백업',`<div class="settings-section"><h3>부드러운 시작과 정지</h3><div class="setting-line"><label for="fade-setting">페이드 인·아웃 길이</label><select id="fade-setting">${[.3,.5,1,1.5,2,3,5].map(n=>`<option value="${n}" ${library.settings.fade===n?'selected':''}>${n.toFixed(1)}초</option>`).join('')}</select></div><p class="modal-note">재생은 시작점에서 볼륨만 서서히 커집니다. 정지는 볼륨이 서서히 작아진 뒤 선택한 주차의 시작점으로 돌아갑니다. 준비운동곡은 다듬은 시작점으로 돌아갑니다. 정지 중 재생을 누르면 시작점으로 이동한 뒤 다시 시작합니다.</p></div><div class="settings-section"><h3>음량 보정</h3><div class="setting-line"><label for="output-gain-setting">다른 플레이어와 음량 맞추기</label><select id="output-gain-setting">${[0,1,2,3].map(db=>`<option value="${db}" ${nativeOutput&&db>0?'disabled':''} ${library.settings.outputGainDb===db?'selected':''}>${db===0?'원음 (0 dB)':`+${db} dB`}</option>`).join('')}</select></div><p class="modal-note">${nativeOutput?'Safari 호환 재생은 브라우저 기본 출력을 사용합니다. 음량은 플레이어 볼륨으로 조절하고, 추가 증폭은 사용하지 않습니다.':'두 플레이어의 볼륨이 100%여도 크기가 다르게 들리면 조금씩 올려 맞추세요. 보정을 켜면 큰 소리의 피크를 제한합니다. 기본값은 원음이며, 음소거는 그대로 유지됩니다.'}</p></div><div class="settings-section"><h3>음원 일괄 연결</h3><p class="modal-note">수업 음원을 여러 개 선택하세요. 등록된 파일 이름과 같으면 해당 선생님 수업에 자동으로 연결됩니다.</p><button class="secondary-button" id="bulk-connect">${icon('upload')} 음원 여러 개 연결</button></div><div class="settings-section"><h3>내 수업 백업</h3><p class="modal-note">현재 브라우저에 저장됩니다. 기기를 바꾸거나 브라우저 데이터를 지우기 전에 백업해 주세요.</p><div class="button-row"><button class="secondary-button" id="export-settings">${icon('file')} 설정만 백업</button><button class="secondary-button" id="export-all">${icon('music')} 음원 포함 백업</button><button class="secondary-button" id="import-backup">${icon('upload')} 백업 불러오기</button></div><div id="backup-progress" class="backup-progress" role="status"></div></div><div class="note-box">음원은 원본 그대로 보관하고, 음질을 떨어뜨리는 압축 변환 없이 재생합니다. WAV·FLAC도 브라우저가 지원하면 연결할 수 있어요. 실제 출력 해상도는 브라우저·운영체제·오디오 장치 설정에 따르며, MP3를 고해상도로 변환하지는 않습니다.</div>`,'MAKE IT YOURS');
 $('fade-setting').onchange=e=>{library.settings.fade=Number(e.target.value);engine.setFade(library.settings.fade);applyLoop();persist();renderControls();};
 $('output-gain-setting').onchange=e=>{library.settings.outputGainDb=Number(e.target.value);engine.setOutputGainDb(library.settings.outputGainDb);renderControls();persist();};
 $('bulk-connect').onclick=()=>{closeModal();chooseAudio('bulk');};
 $('export-settings').onclick=()=>exportBackup(false);
 $('export-all').onclick=()=>exportBackup(true);
 $('import-backup').onclick=()=>{$('backup-input').value='';$('backup-input').click();};
}
function showHelp(){
 showModal('수업과 준비운동을 한곳에서',`<ol class="guide-list"><li><div><strong>선생님과 주차를 선택하세요</strong>음원을 한 번 연결하고 1~4주차 구간을 저장해 두면, 왼쪽 주차 버튼으로 시작점을 고를 수 있어요.</div></li><li><div><strong>준비운동곡을 순서대로 이어 재생하세요</strong>여러 파일을 한 번에 추가하고 ‘위로·아래로’로 순서를 정하세요. ‘다음 곡 자동재생’은 곡 끝에서 페이드로 다음 곡을 이어 줍니다. ‘목록 반복’은 마지막 곡 뒤 처음으로, ‘한 곡 반복’은 현재 곡만 반복합니다.</div></li><li><div><strong>앞뒤 무음을 다듬으세요</strong>‘앞뒤 자르기’에서 파형 양 끝을 움직이거나 시간을 입력하세요. ‘앞뒤 무음 찾기’는 후보를 제안합니다. 저장해야 적용되며 원본 음원과 주차 시간은 그대로 유지됩니다.</div></li><li><div><strong>재생과 정지는 직접 조작하세요</strong>정지하면 볼륨이 서서히 줄고 선택한 시작점으로 돌아갑니다. 기본 재생은 1배속이며 0.8배속에서도 음정을 유지합니다. 배속을 바꾸면 잠깐 페이드한 뒤 현재 위치에서 이어갑니다.</div></li></ol><div class="help-keys"><span><kbd>Space</kbd> 재생 / 정지</span><span><kbd>1</kbd>–<kbd>4</kbd> 주차 선택</span><span><kbd>R</kbd> 선택한 시작점에서 재생</span><span><kbd>L</kbd> 한 구간 / 한 곡 반복</span><span><kbd>S</kbd> 1배속 / 0.8배속</span><span><kbd>←</kbd><kbd>→</kbd> 5초 이동</span></div><p class="modal-note">음원과 설정은 현재 브라우저에 저장됩니다. 다른 기기로 옮길 때는 ‘설정 · 백업’에서 음원 포함 백업을 내려받으세요.</p>`,'QUICK GUIDE');
}

async function exportBackup(includeAudio){
 const progress=$('backup-progress');if(progress)progress.textContent='백업 파일 준비 중…';
 try{
  const result={type:'lessonloop-backup',version:1,createdAt:new Date().toISOString(),library:structuredClone(library),audio:[]};
  if(includeAudio){for(const s of allLibraryTracks(result.library)){const blob=await getAudio(s.id);if(blob){const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});result.audio.push({id:s.id,data,name:s.fileName||'audio',type:blob.type});}}}
  const blob=new Blob([JSON.stringify(result)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`LessonLoop-${new Date().toLocaleDateString('sv-SE')}${includeAudio?'-음원포함':''}.lessonloop`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);if(progress)progress.textContent='백업 파일을 내려받았습니다.';toast('백업 파일을 내려받았습니다.');
 }catch(error){fail(error);if(progress)progress.textContent='백업하지 못했습니다.';}
}
async function importBackup(file){
 if(isImporting||restoring){toast('현재 음원 작업이 끝난 뒤 백업을 불러와 주세요.');return;}
 try{
  const value=validateBackup(JSON.parse(await file.text()));
  showModal('백업을 불러올까요?',`<p class="modal-note">${value.library.teachers.length}개 수업과 ${(value.audio||[]).length}개 음원을 불러옵니다. 현재 수업 설정은 백업의 설정으로 바뀝니다. 기존 설정이 필요하면 먼저 백업해 주세요.</p><div class="modal-actions"><button class="secondary-button" id="restore-cancel">취소</button><button class="primary-button" id="restore-confirm">백업 불러오기</button></div>`);
  $('restore-cancel').onclick=showSettings;
  $('restore-confirm').onclick=async()=>{
   if(isImporting||restoring){toast('현재 음원 작업이 끝난 뒤 백업을 불러와 주세요.');return;}
   warmupQueue.cancel();warmupQueue.invalidate();analysisGeneration++;peakJobs.clear();restoring=true;$('restore-confirm').disabled=true;
   try{
    await engine.pause();
    // Validate all embedded payloads before mutating the current library.
    const blobs=(value.audio||[]).map(a=>{const raw=atob(a.data.split(',')[1]);return {id:a.id,blob:new Blob([Uint8Array.from(raw,c=>c.charCodeAt(0))],{type:a.type||'audio/mpeg'})};});
    const nextLibrary=prepareLibrary(value.library);
    nextLibrary.settings={rate:1,volume:Number.isFinite(Number(nextLibrary.settings?.volume))?Math.max(0,Math.min(1,Number(nextLibrary.settings?.volume))):.8,fade:[.3,.5,1,1.5,2,3,5].includes(nextLibrary.settings?.fade)?nextLibrary.settings.fade:1,repeat:nextLibrary.settings?.repeat!==false,warmupRepeat:nextLibrary.settings?.warmupRepeat===true,warmupAutoNext:nextLibrary.settings?.warmupAutoNext!==false,warmupListRepeat:nextLibrary.settings?.warmupListRepeat===true,outputGainDb:[0,1,2,3].includes(nextLibrary.settings?.outputGainDb)?nextLibrary.settings.outputGainDb:0};
    const nextTeacher=nextLibrary.teachers.find(t=>t.id===nextLibrary.selectedTeacher)||nextLibrary.teachers[0];
    nextLibrary.selectedTeacher=nextTeacher.id;nextLibrary.selectedTrack=(nextTeacher.tracks.find(s=>s.id===nextLibrary.selectedTrack)||nextTeacher.tracks[0])?.id||null;nextLibrary.selectedWeek=Math.max(0,Math.min(3,Math.trunc(nextLibrary.selectedWeek)||0));
    const incomingIds=new Set(blobs.map(a=>a.id));
    for(const s of allLibraryTracks(nextLibrary))s.hasAudio=incomingIds.has(s.id)||!!(await getAudio(s.id));
    restoring=true;await saveChain.catch(()=>{});await restoreLibrary(nextLibrary,blobs);warmupQueue.invalidate();library=nextLibrary;restoring=false;
    applySettings();await loadCurrent();render();closeModal();toast('수업과 구간을 불러왔습니다.');
   }catch(error){restoring=false;fail(error);if($('restore-confirm'))$('restore-confirm').disabled=false;}
  };
 }catch(error){fail(error instanceof SyntaxError?new Error('백업 파일을 읽을 수 없습니다.'):error);}
}
$('teacher-list').onclick=e=>{const b=e.target.closest('[data-teacher]');if(b)selectTeacher(b.dataset.teacher).catch(fail);};
$('track-list').onclick=e=>{const b=e.target.closest('[data-track]');if(b)selectTrack(b.dataset.track).catch(fail);};
$('week-grid').onclick=e=>{const b=e.target.closest('[data-week]');if(b)selectWeek(Number(b.dataset.week)).catch(fail);};
$('play').onclick=()=>{if(engine.state==='playing'||engine.state==='starting'||engine.rateChanging||warmupQueue.busy)stopPlayback();else engine.play();};
$('restart').onclick=()=>{warmupQueue.cancel();engine.restart(week().start);};
$('loop').onclick=()=>{warmupQueue.cancel();if(isWarmup()){library.settings.warmupRepeat=!repeatEnabled();if(library.settings.warmupRepeat){library.settings.warmupAutoNext=false;library.settings.warmupListRepeat=false;warmupQueue.invalidate();}}else library.settings.repeat=!library.settings.repeat;applyLoop();renderWeeks();renderWarmups();renderControls();persist();prefetchWarmup();};
$('volume').oninput=e=>{library.settings.volume=Number(e.target.value)/100;engine.setVolume(library.settings.volume);$('volume-label').textContent=`${e.target.value}%`;renderFadeMonitor();};
$('volume').onchange=()=>persist();
$('seek').oninput=e=>{if(engine.state==='stopping'||warmupQueue.busy)return;const p=effectivePlaybackRange(track(),'warmup',0,sourceDuration());if(p.valid)engine.seek(Math.max(p.start,Math.min(p.end-.001,Number(e.target.value))));updateTime();};
let rateChoice=0;
for(const b of document.querySelectorAll('[data-rate]'))b.onclick=async()=>{
 const choice=++rateChoice,source=switching,selectedEngine=engine;
 library.settings.rate=Number(b.dataset.rate);renderControls();
 try{await selectedEngine.changeRate(library.settings.rate);}
 catch(error){if(choice===rateChoice)fail(error);}
 if(choice!==rateChoice||source!==switching||engine!==selectedEngine)return;
 library.settings.rate=selectedEngine.playbackRate;renderControls();persist();
};
$('connect-audio').onclick=()=>chooseAudio(isWarmup()?(track()?'warmup-connect':'warmup'):(track()?'connect':'add'));
$('add-track').onclick=()=>chooseAudio('add');
$('add-warmup').onclick=()=>chooseAudio('warmup');
$('warmup-nav').onclick=()=>selectWarmup(library.selectedWarmupTrack).catch(fail);
$('back-to-class').onclick=()=>selectTeacher(library.selectedTeacher).catch(fail);
$('warmup-list').onclick=e=>{const move=e.target.closest('[data-move-warmup]'),trim=e.target.closest('[data-trim-warmup]'),manage=e.target.closest('[data-manage-warmup]'),b=e.target.closest('[data-warmup]');if(move)moveWarmup(move.dataset.moveWarmup,Number(move.dataset.direction));else if(trim)editPlayRange(library.warmupTracks.find(s=>s.id===trim.dataset.trimWarmup));else if(manage)editWarmup(manage.dataset.manageWarmup);else if(b)selectWarmup(b.dataset.warmup).catch(fail);};
$('warmup-prev').onclick=()=>advanceWarmup(-1).catch(fail);
$('warmup-next').onclick=()=>advanceWarmup(1).catch(fail);
$('warmup-auto-next').onclick=()=>{warmupQueue.cancel();warmupQueue.invalidate();library.settings.warmupAutoNext=!library.settings.warmupAutoNext;library.settings.warmupRepeat=false;if(!library.settings.warmupAutoNext)library.settings.warmupListRepeat=false;applyLoop();renderWeeks();renderWarmups();renderControls();persist();prefetchWarmup();};
$('warmup-list-repeat').onclick=()=>{warmupQueue.cancel();warmupQueue.invalidate();library.settings.warmupListRepeat=!library.settings.warmupListRepeat;if(library.settings.warmupListRepeat){library.settings.warmupAutoNext=true;library.settings.warmupRepeat=false;}applyLoop();renderWeeks();renderWarmups();renderControls();persist();prefetchWarmup();};
$('edit-play-range').onclick=()=>editPlayRange(track());
$('audio-input').onchange=e=>importAudio(e.target.files).catch(fail);
$('backup-input').onchange=e=>{if(e.target.files[0])importBackup(e.target.files[0]);};
$('edit-weeks').onclick=editWeeks;$('edit-teacher').onclick=()=>isWarmup()?editWarmup(track()?.id):editTeacher();$('add-teacher').onclick=()=>editTeacher(true);
$('open-settings').onclick=showSettings;$('mobile-settings').onclick=showSettings;$('fade-shortcut').onclick=showSettings;
$('open-help').onclick=showHelp;$('close-modal').onclick=closeModal;
$('modal').onclick=e=>{if(e.target===$('modal')){const r=$('modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}};
window.addEventListener('resize',drawWaveform);
window.addEventListener('keydown',e=>{
 if($('modal').open||e.ctrlKey||e.metaKey||e.altKey||/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)||document.activeElement?.isContentEditable)return;
 if(e.code==='Space'){if(document.activeElement?.tagName==='BUTTON')return;e.preventDefault();if(!e.repeat&&!$('play').disabled)$('play').click();}
 else if(/^[1-4]$/.test(e.key)){e.preventDefault();selectWeek(Number(e.key)-1);}
 else if(e.key.toLowerCase()==='r'){e.preventDefault();if(!$('restart').disabled)$('restart').click();}
 else if(e.key.toLowerCase()==='l'){$('loop').click();}
 else if(e.key.toLowerCase()==='s'){const rate=library.settings.rate===1?.8:1;document.querySelector(`[data-rate="${rate}"]`).click();}
 else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();if(engine.state==='stopping'||engine.rateChanging||sourceSwitching||warmupQueue.busy)return;const p=effectivePlaybackRange(track(),'warmup',0,sourceDuration());if(p.valid)engine.seek(Math.max(p.start,Math.min(p.end-.001,engine.currentTime+(e.key==='ArrowLeft'?-5:5))));}
});
let dragCount=0;
$('player-card').addEventListener('dragenter',e=>{e.preventDefault();dragCount++;$('player-card').classList.add('drop-target');});
$('player-card').addEventListener('dragover',e=>e.preventDefault());
$('player-card').addEventListener('dragleave',()=>{if(--dragCount<=0)$('player-card').classList.remove('drop-target');});
$('player-card').addEventListener('drop',e=>{e.preventDefault();dragCount=0;$('player-card').classList.remove('drop-target');importMode=isWarmup()?'warmup':'connect';importAudio(e.dataTransfer.files).catch(fail);});
window.addEventListener('beforeunload',()=>{warmupQueue.cancel();warmupQueue.invalidate();trimAnalysisAbort?.abort();engine.dispose();});
async function init(){
 try{const stored=await readLibrary();if(stored?.version===1&&stored.teachers?.length)library=stored;else await saveLibrary(library);}
 catch(error){persistenceOK=false;fail(error);}
 library=prepareLibrary(library);
 library.selectedTeacher=teacher().id;library.selectedTrack=lessonTrack()?.id||null;library.selectedWeek=Math.max(0,Math.min(3,library.selectedWeek||0));
 applySettings();render();await loadCurrent();
 if(!persistenceOK){$('save-state').textContent='저장소 연결 실패';$('save-state').classList.add('unsaved');}
}
init().catch(fail);

window.lessonLoopPrepareUpdate=async()=>{warmupQueue.cancel();if(!activeBlob||!engine.duration)return true;return engine.stop(week().start);};
