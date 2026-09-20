(function(){
"use strict";

/* ---------------------------------------------------------------- utils */
const $ = id => document.getElementById(id);
const clamp = (v,a,b) => v < a ? a : v > b ? b : v;
const pad = n => String(n).padStart(2,"0");
function mmss(t){ t = Math.max(0,t|0); return pad(t/60|0)+":"+pad(t%60); }
function mmsst(t){ t = Math.max(0,t); const m = t/60|0, s = t%60; return m+":"+(s<10?"0":"")+s.toFixed(1); }
function bytes(n){ if(!n) return "0 MB"; const mb = n/1048576; return mb < 1000 ? mb.toFixed(1)+" MB" : (mb/1024).toFixed(2)+" GB"; }
let toastT;
function toast(msg){ const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(()=>t.classList.remove("show"),3200); }
function once(el,ev){
  if(ev === "loadedmetadata" && el.readyState >= 1) return Promise.resolve();
  return new Promise(res=>el.addEventListener(ev,res,{once:true}));
}

/* ------------------------------------------------------------- settings */
const DEFAULTS = {
  mode:"screencam", camSize:18, camShape:"circle", camMirror:true, camBorder:true,
  camX:0.87, camY:0.82, micOn:true, sysOn:false,
  res:"1080", fps:"30", q:"med", fmt:"", cd:"3", camId:"", micId:""
};
let S = Object.assign({},DEFAULTS);
try{ const raw = localStorage.getItem("screenStudio"); if(raw) S = Object.assign(S,JSON.parse(raw)); }catch(e){}
function save(){ try{ localStorage.setItem("screenStudio",JSON.stringify(S)); }catch(e){} }

/* ------------------------------------------------------- media elements */
const screenVid = document.createElement("video");
const camVid = document.createElement("video");
[screenVid,camVid].forEach(v=>{ v.muted = true; v.playsInline = true; v.autoplay = true; });

const cv = $("cv"), cx = cv.getContext("2d",{alpha:false});

let screenStream = null, camStream = null, micStream = null;
let recorder = null, chunks = [], recStream = null;
let recording = false, paused = false, hadAudio = false;
let startedAt = 0, accum = 0, recBytes = 0;
let recordedBlob = null, recordedType = "", recordedDur = 0, recSize = {w:0,h:0};
let trimA = 0, trimB = 0, tlDur = 1;
let exporting = false, cancelExport = false;
let camHidden = false, micMuted = false;

/* --------------------------------------------- audio graph + frame tick */
let AC = null, micSrc = null, micGain = null, sysSrc = null, sysGain = null, mixDest = null, analyser = null, ticker = null;
function ac(){
  if(!AC){
    AC = new (window.AudioContext||window.webkitAudioContext)();
    // A silent script node gives us a timer that keeps running while the tab is
    // in the background, where requestAnimationFrame is throttled to a halt.
    try{
      ticker = AC.createScriptProcessor(512,1,1);
      const mute = AC.createGain(); mute.gain.value = 0;
      ticker.onaudioprocess = ()=>{ if(tickWanted) drawFrame(); };
      ticker.connect(mute); mute.connect(AC.destination);
    }catch(e){}
  }
  if(AC.state === "suspended") AC.resume();
  return AC;
}

/* --------------------------------------------------------- source setup */
async function pickScreen(){
  try{
    const fps = +S.fps;
    const st = await navigator.mediaDevices.getDisplayMedia({
      video:{ frameRate:{ideal:fps,max:fps}, width:{ideal:3840}, height:{ideal:2160} },
      audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false }
    });
    stopStream(screenStream,st);
    screenStream = st;
    screenVid.srcObject = st;
    await screenVid.play().catch(()=>{});
    const vt = st.getVideoTracks()[0];
    vt.addEventListener("ended", ()=>{
      if(recording) stopRecording();
      else { screenStream = null; screenVid.srcObject = null; refresh(); }
    });
    const lbl = vt.label || "Screen";
    $("sourceLabel").textContent = lbl.length > 26 ? lbl.slice(0,26)+"…" : lbl;
    if(S.sysOn && st.getAudioTracks().length === 0)
      toast("No computer sound in this share — re-pick and tick the audio box.");
    sizeCanvas(); refresh();
  }catch(e){
    if(e && e.name === "NotAllowedError") return;
    fail(e,"Couldn't start screen capture.");
  }
}

async function startCam(){
  try{
    const c = { width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30} };
    if(S.camId) c.deviceId = {exact:S.camId};
    const st = await navigator.mediaDevices.getUserMedia({video:c});
    stopStream(camStream,st); camStream = st;
    camVid.srcObject = st; await camVid.play().catch(()=>{});
    listDevices(); sizeCanvas(); refresh();
  }catch(e){ fail(e,"Couldn't open the camera."); segSet("modeSeg","mode",S.mode = "screen"); refresh(); }
}
function stopCam(){ if(camStream){ camStream.getTracks().forEach(t=>t.stop()); camStream = null; camVid.srcObject = null; } }

async function startMic(){
  try{
    const c = { echoCancellation:true, noiseSuppression:true, autoGainControl:true };
    if(S.micId) c.deviceId = {exact:S.micId};
    const st = await navigator.mediaDevices.getUserMedia({audio:c});
    stopStream(micStream,st); micStream = st;
    const a = ac();
    if(micSrc){ try{ micSrc.disconnect(); }catch(e){} }
    micSrc = a.createMediaStreamSource(st);
    micGain = a.createGain(); micGain.gain.value = 1;
    analyser = a.createAnalyser(); analyser.fftSize = 512;
    micSrc.connect(micGain); micGain.connect(analyser);
    if(mixDest) micGain.connect(mixDest);
    listDevices(); meterLoop();
  }catch(e){ fail(e,"Couldn't open the microphone."); S.micOn = false; $("micOn").checked = false; refresh(); }
}
function stopMic(){
  if(micStream){ micStream.getTracks().forEach(t=>t.stop()); micStream = null; }
  if(micSrc){ try{ micSrc.disconnect(); }catch(e){} micSrc = null; }
  analyser = null; $("meterBar").style.width = "0%";
}
function stopStream(old,keep){ if(old && old !== keep) old.getTracks().forEach(t=>t.stop()); }
function fail(e,msg){
  console.error(e);
  const n = e && e.name;
  if(n === "NotAllowedError") toast(msg+" Permission was blocked.");
  else if(n === "NotFoundError") toast(msg+" No such device was found.");
  else if(n === "NotReadableError") toast(msg+" Another app is using it.");
  else toast(msg+" "+(e && e.message ? e.message : ""));
}

let meterRAF = 0;
function meterLoop(){
  cancelAnimationFrame(meterRAF);
  const buf = analyser ? new Uint8Array(analyser.fftSize) : null;
  const step = ()=>{
    if(!analyser) return;
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for(let i=0;i<buf.length;i++){ const d = Math.abs(buf[i]-128)/128; if(d > peak) peak = d; }
    const pct = micMuted ? 0 : clamp(Math.sqrt(peak)*118,0,100);
    $("meterBar").style.width = pct+"%";
    meterRAF = requestAnimationFrame(step);
  };
  step();
}

async function listDevices(){
  try{
    const d = await navigator.mediaDevices.enumerateDevices();
    fillSel($("camSelect"), d.filter(x=>x.kind === "videoinput"), S.camId, "Default camera");
    fillSel($("micSelect"), d.filter(x=>x.kind === "audioinput"), S.micId, "Default microphone");
  }catch(e){}
}
function fillSel(sel,list,cur,def){
  sel.innerHTML = "";
  const o = document.createElement("option"); o.value = ""; o.textContent = def; sel.appendChild(o);
  list.forEach((dev,i)=>{
    const op = document.createElement("option");
    op.value = dev.deviceId; op.textContent = dev.label || (def.split(" ")[1]+" "+(i+1));
    sel.appendChild(op);
  });
  sel.value = list.some(x=>x.deviceId === cur) ? cur : "";
}

/* ------------------------------------------------------- canvas drawing */
function sizeCanvas(){
  let w = 1280, h = 720;
  if(S.mode !== "cam" && screenStream){
    const st = screenStream.getVideoTracks()[0].getSettings();
    w = st.width || screenVid.videoWidth || 1280;
    h = st.height || screenVid.videoHeight || 720;
  }else if(S.mode === "cam" && camStream){
    w = camVid.videoWidth || 1280; h = camVid.videoHeight || 720;
  }
  if(S.res !== "source"){
    const target = +S.res;
    if(h > target){ w = Math.round(w*target/h); h = target; }
  }
  w = Math.max(2,w - (w%2)); h = Math.max(2,h - (h%2));
  if(cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; }
}

let tickWanted = false, lastDraw = 0;
function drawFrame(force){
  const now = performance.now(), gap = 1000/(+S.fps) - 2;
  if(!force && now - lastDraw < gap) return;
  lastDraw = now;
  const W = cv.width, H = cv.height;
  cx.fillStyle = "#000"; cx.fillRect(0,0,W,H);

  if(S.mode === "cam"){
    if(camStream && camVid.readyState >= 2 && !camHidden) drawCover(camVid,0,0,W,H);
  }else{
    if(screenStream && screenVid.readyState >= 2){
      const vw = screenVid.videoWidth, vh = screenVid.videoHeight;
      if(vw && vh){
        const s = Math.min(W/vw,H/vh), dw = vw*s, dh = vh*s;
        cx.drawImage(screenVid,(W-dw)/2,(H-dh)/2,dw,dh);
      }
    }
    if(S.mode === "screencam" && camStream && camVid.readyState >= 2 && !camHidden) drawCam(W,H);
  }
}
function drawCover(v,dx,dy,dw,dh){
  const vw = v.videoWidth, vh = v.videoHeight; if(!vw||!vh) return;
  const s = Math.max(dw/vw,dh/vh), w = vw*s, h = vh*s;
  cx.drawImage(v,dx+(dw-w)/2,dy+(dh-h)/2,w,h);
}
function camRect(W,H){
  const w = W*(S.camSize/100);
  const ar = (camVid.videoWidth && camVid.videoHeight) ? camVid.videoHeight/camVid.videoWidth : 0.5625;
  const h = S.camShape === "circle" ? w : w*ar;
  return { w:w, h:h, x:clamp(S.camX*W,w/2,W-w/2) - w/2, y:clamp(S.camY*H,h/2,H-h/2) - h/2 };
}
function drawCam(W,H){
  const r = camRect(W,H), rad = S.camShape === "circle" ? r.w/2 : Math.max(8,r.w*0.09);
  cx.save();
  if(S.camBorder){ cx.shadowColor = "rgba(0,0,0,.45)"; cx.shadowBlur = Math.max(10,r.w*0.09); cx.shadowOffsetY = Math.max(4,r.w*0.03); }
  cx.beginPath();
  if(S.camShape === "circle") cx.arc(r.x+r.w/2,r.y+r.h/2,r.w/2,0,Math.PI*2);
  else if(cx.roundRect) cx.roundRect(r.x,r.y,r.w,r.h,rad);
  else cx.rect(r.x,r.y,r.w,r.h);
  cx.closePath();
  if(S.camBorder){ cx.fillStyle = "rgba(255,255,255,.9)"; cx.fill(); }
  cx.shadowColor = "transparent";
  cx.clip();
  cx.save();
  if(S.camMirror){ cx.translate(r.x*2+r.w,0); cx.scale(-1,1); }
  drawCover(camVid,r.x,r.y,r.w,r.h);
  cx.restore();
  cx.restore();
  if(S.camBorder){
    cx.save(); cx.beginPath();
    if(S.camShape === "circle") cx.arc(r.x+r.w/2,r.y+r.h/2,r.w/2,0,Math.PI*2);
    else if(cx.roundRect) cx.roundRect(r.x,r.y,r.w,r.h,rad);
    else cx.rect(r.x,r.y,r.w,r.h);
    cx.lineWidth = Math.max(2,r.w*0.018); cx.strokeStyle = "rgba(255,255,255,.92)"; cx.stroke(); cx.restore();
  }
}
function loop(){ if(tickWanted){ drawFrame(); requestAnimationFrame(loop); } }
function startPreview(){ if(tickWanted) return; tickWanted = true; ac(); requestAnimationFrame(loop); }
function stopPreview(){ tickWanted = false; }

/* ------------------------------------------------------- drag on canvas */
let dragging = false;
cv.addEventListener("pointerdown",e=>{
  if(S.mode !== "screencam" || !camStream || camHidden) return;
  const p = toCanvas(e), r = camRect(cv.width,cv.height);
  if(p.x >= r.x && p.x <= r.x+r.w && p.y >= r.y && p.y <= r.y+r.h){
    dragging = true; cv.setPointerCapture(e.pointerId); e.preventDefault();
  }
});
cv.addEventListener("pointermove",e=>{
  if(S.mode !== "screencam" || !camStream) return;
  if(!dragging){
    const p = toCanvas(e), r = camRect(cv.width,cv.height);
    cv.style.cursor = (p.x>=r.x&&p.x<=r.x+r.w&&p.y>=r.y&&p.y<=r.y+r.h) ? "grab" : "default";
    return;
  }
  const p = toCanvas(e);
  S.camX = clamp(p.x/cv.width,0,1); S.camY = clamp(p.y/cv.height,0,1);
  cv.style.cursor = "grabbing"; markPos(); drawFrame(true);
});
cv.addEventListener("pointerup",e=>{ if(dragging){ dragging = false; save(); cv.style.cursor = "grab"; } });
function toCanvas(e){
  const b = cv.getBoundingClientRect();
  return { x:(e.clientX-b.left)*(cv.width/b.width), y:(e.clientY-b.top)*(cv.height/b.height) };
}

/* ------------------------------------------------------------- recording */
function mimeList(){
  const cands = [
    ["video/mp4;codecs=avc1.42E01E,mp4a.40.2","MP4 (H.264)"],
    ["video/webm;codecs=vp9,opus","WebM (VP9)"],
    ["video/webm;codecs=vp8,opus","WebM (VP8)"],
    ["video/webm","WebM"]
  ];
  return cands.filter(c=>{ try{ return MediaRecorder.isTypeSupported(c[0]); }catch(e){ return false; } });
}
function bitrate(){
  const px = cv.width*cv.height, f = +S.fps;
  const mult = S.q === "high" ? 0.13 : S.q === "low" ? 0.045 : 0.08;
  return Math.round(clamp(px*f*mult,800000,26000000));
}
function buildStream(){
  const out = new MediaStream();
  cv.captureStream(+S.fps).getVideoTracks().forEach(t=>out.addTrack(t));
  const a = ac();
  mixDest = a.createMediaStreamDestination();
  let any = false;
  if(S.micOn && micGain){ micGain.connect(mixDest); any = true; }
  if(S.sysOn && screenStream && screenStream.getAudioTracks().length){
    try{
      sysSrc = a.createMediaStreamSource(new MediaStream([screenStream.getAudioTracks()[0]]));
      sysGain = a.createGain(); sysGain.gain.value = 1;
      sysSrc.connect(sysGain); sysGain.connect(mixDest); any = true;
    }catch(e){}
  }
  if(any) mixDest.stream.getAudioTracks().forEach(t=>out.addTrack(t));
  hadAudio = any;
  return out;
}

async function startRecording(){
  if(recording || exporting) return;
  if(S.mode !== "cam" && !screenStream){ toast("Pick a screen, window or tab first."); return; }
  if(S.mode === "cam" && !camStream){ toast("Turn on the camera first."); return; }
  ac();
  const cd = +S.cd;
  if(cd > 0){
    const el = $("countdown"), num = el.firstElementChild;
    el.classList.remove("hidden");
    for(let i=cd;i>0;i--){ num.textContent = i; await new Promise(r=>setTimeout(r,1000)); }
    el.classList.add("hidden");
  }
  sizeCanvas(); drawFrame(true);
  recStream = buildStream();
  const mime = S.fmt || (mimeList()[0] && mimeList()[0][0]) || "";
  const opts = { videoBitsPerSecond:bitrate(), audioBitsPerSecond:128000 };
  if(mime) opts.mimeType = mime;
  try{ recorder = new MediaRecorder(recStream,opts); }
  catch(e){ try{ recorder = new MediaRecorder(recStream); }catch(e2){ fail(e2,"This browser can't record."); return; } }
  chunks = []; recBytes = 0; recordedType = recorder.mimeType || mime || "video/webm";
  recorder.ondataavailable = e=>{ if(e.data && e.data.size){ chunks.push(e.data); recBytes += e.data.size; } };
  recorder.onstop = finishRecording;
  recorder.start(1000);
  recording = true; paused = false; accum = 0; startedAt = performance.now();
  $("barSetup").classList.add("hidden"); $("barRec").classList.remove("hidden");
  $("badge").classList.remove("hidden"); $("badge").className = "badge live";
  $("dragHint").classList.add("hidden");
  $("railSetup").querySelectorAll(".sect").forEach(s=>s.classList.add("off"));
  tickTimer();
}
let timerT = 0;
function elapsed(){ return (accum + (paused ? 0 : performance.now()-startedAt))/1000; }
function tickTimer(){
  clearInterval(timerT);
  timerT = setInterval(()=>{
    if(!recording) return;
    $("recTime").textContent = mmss(elapsed());
    $("sizeInfo").textContent = bytes(recBytes);
  },250);
}
function pauseRecording(){
  if(!recording || !recorder) return;
  if(paused){
    recorder.resume(); paused = false; startedAt = performance.now();
    $("badge").className = "badge live";
    $("btnPause").lastElementChild.textContent = "Pause";
  }else{
    recorder.pause(); paused = true; accum += performance.now()-startedAt;
    $("badge").className = "badge paused";
    $("btnPause").lastElementChild.textContent = "Resume";
  }
}
function stopRecording(){
  if(!recording || !recorder) return;
  recordedDur = elapsed();
  recording = false; paused = false; clearInterval(timerT);
  try{ recorder.stop(); }catch(e){}
}
function finishRecording(){
  recSize = {w:cv.width,h:cv.height};
  recordedBlob = new Blob(chunks,{type:recordedType.split(";")[0]});
  chunks = [];
  if(sysSrc){ try{ sysSrc.disconnect(); }catch(e){} sysSrc = null; }
  if(micGain && mixDest){ try{ micGain.disconnect(mixDest); }catch(e){} }
  $("badge").classList.add("hidden");
  if(!recordedBlob.size){ toast("Nothing was captured — try again."); refresh(); return; }
  openEditor();
}

/* ---------------------------------------------------------------- editor */
const pv = $("preview");
async function openEditor(){
  stopPreview();
  $("barRec").classList.add("hidden"); $("barSetup").classList.add("hidden");
  $("cv").classList.add("hidden"); $("empty").classList.add("hidden");
  $("editor").classList.remove("hidden"); pv.classList.remove("hidden");
  $("railSetup").classList.add("hidden"); $("railEdit").classList.remove("hidden");
  $("railSetup").querySelectorAll(".sect").forEach(s=>s.classList.remove("off"));
  pv.src = URL.createObjectURL(recordedBlob);
  pv.controls = false;
  await once(pv,"loadedmetadata");
  const d = await fixDuration(pv);
  tlDur = (isFinite(d) && d > 0.2) ? d : recordedDur;
  trimA = 0; trimB = tlDur;
  buildWave();
  drawTrim(); updateEditInfo();
  const n = new Date();
  $("fileName").value = "recording-"+n.getFullYear()+"-"+pad(n.getMonth()+1)+"-"+pad(n.getDate())+"-"+pad(n.getHours())+pad(n.getMinutes());
  $("kvRes").textContent = recSize.w+"×"+recSize.h;
  $("kvSize").textContent = bytes(recordedBlob.size);
  toast("Recording ready — drag the amber handles to trim.");
}
function fixDuration(v){
  return new Promise(res=>{
    if(isFinite(v.duration) && v.duration > 0) return res(v.duration);
    let done = false;
    const fin = ()=>{ if(done) return; done = true; v.removeEventListener("timeupdate",onT); try{ v.currentTime = 0; }catch(e){} res(v.duration); };
    const onT = ()=>{ if(v.currentTime > 0) fin(); };
    v.addEventListener("timeupdate",onT);
    try{ v.currentTime = 1e101; }catch(e){ fin(); }
    setTimeout(fin,1500);
  });
}
function buildWave(){
  const w = $("wave"); w.innerHTML = "";
  const n = 120;
  for(let i=0;i<n;i++){
    const s = document.createElement("span");
    const t = i/n;
    s.style.height = (18 + Math.abs(Math.sin(t*22))*26 + Math.abs(Math.cos(t*7))*14)+"%";
    w.appendChild(s);
  }
}
function pctOf(t){ return clamp(t/tlDur,0,1)*100; }
function drawTrim(){
  const a = pctOf(trimA), b = pctOf(trimB);
  $("sel").style.left = a+"%"; $("sel").style.width = (b-a)+"%";
  $("hL").style.left = "calc("+a+"% - 7px)"; $("hR").style.left = "calc("+b+"% - 7px)";
  $("dimL").style.left = "0"; $("dimL").style.width = a+"%";
  $("dimR").style.left = b+"%"; $("dimR").style.width = (100-b)+"%";
}
function updateEditInfo(){
  $("tcDur").textContent = mmsst(tlDur);
  $("kvFull").textContent = mmsst(tlDur);
  $("kvTrim").textContent = mmsst(trimB-trimA);
  $("clipInfo").textContent = "Clip "+mmsst(trimA)+" → "+mmsst(trimB);
  const cut = tlDur-(trimB-trimA);
  $("btnExport").lastChild.textContent = cut > 0.15 ? " Save trimmed video" : " Save video";
}
pv.addEventListener("timeupdate",()=>{
  $("ph").style.left = pctOf(pv.currentTime)+"%";
  $("tcCur").textContent = mmsst(pv.currentTime);
  if(!pv.paused && pv.currentTime >= trimB-0.03){ pv.pause(); pv.currentTime = trimA; setPlayIcon(); }
});
pv.addEventListener("play",setPlayIcon); pv.addEventListener("pause",setPlayIcon);
function setPlayIcon(){
  $("btnPlay").innerHTML = pv.paused
    ? '<svg viewBox="0 0 24 24"><path d="M8 5l12 7-12 7z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
}
function togglePlay(){
  if(pv.paused){ if(pv.currentTime < trimA || pv.currentTime >= trimB-0.05) pv.currentTime = trimA; pv.play(); }
  else pv.pause();
}
/* timeline interaction */
let tlDrag = null;
function tlTime(e){
  const b = $("tl").getBoundingClientRect();
  return clamp((e.clientX-b.left)/b.width,0,1)*tlDur;
}
$("hL").addEventListener("pointerdown",e=>{ tlDrag = "L"; e.target.setPointerCapture(e.pointerId); e.stopPropagation(); });
$("hR").addEventListener("pointerdown",e=>{ tlDrag = "R"; e.target.setPointerCapture(e.pointerId); e.stopPropagation(); });
$("tl").addEventListener("pointerdown",e=>{ if(tlDrag) return; tlDrag = "P"; $("tl").setPointerCapture(e.pointerId); seekTo(tlTime(e)); });
document.addEventListener("pointermove",e=>{
  if(!tlDrag) return;
  const t = tlTime(e);
  if(tlDrag === "L"){ trimA = clamp(t,0,trimB-0.1); seekTo(trimA); }
  else if(tlDrag === "R"){ trimB = clamp(t,trimA+0.1,tlDur); seekTo(trimB); }
  else seekTo(t);
  drawTrim(); updateEditInfo();
});
document.addEventListener("pointerup",()=>{ tlDrag = null; });
function seekTo(t){ if(!isFinite(t)) return; pv.currentTime = clamp(t,0,tlDur); $("ph").style.left = pctOf(t)+"%"; $("tcCur").textContent = mmsst(t); }

/* ---------------------------------------------------------------- export */
function download(blob,name){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },4000);
}
function ext(){ return (recordedType.indexOf("mp4") > -1) ? ".mp4" : ".webm"; }
function safeName(){
  const v = ($("fileName").value || "recording").replace(/[\\/:*?"<>|]+/g,"-").trim();
  return v.replace(/\.(webm|mp4)$/i,"") + ext();
}
$("btnExportRaw").addEventListener("click",()=>{
  if(!recordedBlob) return;
  download(recordedBlob,safeName());
  toast("Saved to your downloads folder.");
});
$("btnExport").addEventListener("click",()=>{
  if(exporting){ cancelExport = true; return; }
  if(tlDur-(trimB-trimA) < 0.15){ download(recordedBlob,safeName()); toast("Saved to your downloads folder."); return; }
  exportTrim();
});
async function exportTrim(){
  if(!recordedBlob) return;
  exporting = true; cancelExport = false;
  pv.pause();
  const btn = $("btnExport");
  btn.classList.remove("primary"); btn.lastChild.textContent = " Cancel export";
  $("expProgWrap").classList.remove("hidden"); $("expNote").classList.remove("hidden");
  $("expNote").textContent = "Re-encoding in real time. Leave this tab open.";

  const v = document.createElement("video");
  v.src = URL.createObjectURL(recordedBlob); v.playsInline = true;
  let out = null;
  try{
    await once(v,"loadedmetadata"); await fixDuration(v);
    const c = document.createElement("canvas");
    c.width = recSize.w || v.videoWidth; c.height = recSize.h || v.videoHeight;
    const ctx2 = c.getContext("2d",{alpha:false});
    const stream = c.captureStream(+S.fps);
    const a = ac();
    let src = null, dest = null;
    if(hadAudio){
      try{
        src = a.createMediaElementSource(v);
        dest = a.createMediaStreamDestination();
        src.connect(dest);
        dest.stream.getAudioTracks().forEach(t=>stream.addTrack(t));
      }catch(e){ v.muted = true; }
    }else v.muted = true;

    const mime = recordedType && MediaRecorder.isTypeSupported(recordedType) ? recordedType : (mimeList()[0]||[""])[0];
    const rec = new MediaRecorder(stream, mime ? {mimeType:mime,videoBitsPerSecond:bitrate(),audioBitsPerSecond:128000} : {});
    const parts = [];
    rec.ondataavailable = e=>{ if(e.data && e.data.size) parts.push(e.data); };
    const done = new Promise(r=>rec.onstop = r);

    v.currentTime = trimA;
    await Promise.race([once(v,"seeked"),new Promise(r=>setTimeout(r,2000))]);
    rec.start(1000);
    await v.play();

    const span = trimB-trimA;
    await new Promise(resolve=>{
      let raf = 0;
      const step = ()=>{
        ctx2.drawImage(v,0,0,c.width,c.height);
        const p = clamp((v.currentTime-trimA)/span,0,1);
        $("expProg").style.width = (p*100).toFixed(1)+"%";
        if(cancelExport || v.ended || v.currentTime >= trimB-0.02){ cancelAnimationFrame(raf); resolve(); return; }
        raf = requestAnimationFrame(step);
      };
      step();
      // background-safe backup tick
      const iv = setInterval(()=>{ if(document.hidden && !v.paused && !v.ended) ctx2.drawImage(v,0,0,c.width,c.height); },1000/(+S.fps));
      const clean = setInterval(()=>{ if(cancelExport || v.ended || v.currentTime >= trimB-0.02){ clearInterval(iv); clearInterval(clean); } },200);
    });
    v.pause();
    try{ rec.stop(); }catch(e){}
    await done;
    if(src){ try{ src.disconnect(); }catch(e){} }
    if(!cancelExport && parts.length){
      out = new Blob(parts,{type:(mime||"video/webm").split(";")[0]});
      download(out,safeName());
      toast("Saved "+mmsst(span)+" to your downloads folder.");
    }else if(cancelExport) toast("Export cancelled.");
  }catch(e){ fail(e,"Export failed."); }
  finally{
    URL.revokeObjectURL(v.src);
    exporting = false; cancelExport = false;
    btn.classList.add("primary"); updateEditInfo();
    $("expProg").style.width = "0";
    $("expProgWrap").classList.add("hidden"); $("expNote").classList.add("hidden");
  }
}

/* ------------------------------------------------------------ new record */
function newRecording(){
  if(exporting){ toast("Wait for the export to finish."); return; }
  recordedBlob = null; chunks = [];
  pv.pause(); if(pv.src){ URL.revokeObjectURL(pv.src); pv.removeAttribute("src"); pv.load(); }
  $("editor").classList.add("hidden"); pv.classList.add("hidden");
  $("railEdit").classList.add("hidden"); $("railSetup").classList.remove("hidden");
  $("barSetup").classList.remove("hidden");
  $("btnPause").lastElementChild.textContent = "Pause";
  refresh();
}

/* -------------------------------------------------------------- UI state */
function segSet(id,key,val){
  $(id).querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset[key] === val)));
}
function markPos(){
  $("posGrid").querySelectorAll("button").forEach(b=>{
    const x = [0.13,0.5,0.87][+b.dataset.x], y = [0.14,0.5,0.86][+b.dataset.y];
    b.setAttribute("aria-pressed",String(Math.abs(x-S.camX) < 0.02 && Math.abs(y-S.camY) < 0.02));
  });
}
function refresh(){
  const needScreen = S.mode !== "cam";
  const hasSrc = needScreen ? !!screenStream : !!camStream;
  $("empty").classList.toggle("hidden",hasSrc);
  cv.classList.toggle("hidden",!hasSrc || !!recordedBlob);
  $("btnSource").classList.toggle("hidden",!needScreen);
  $("btnStart").disabled = !hasSrc;
  $("camSect").classList.toggle("off",S.mode === "screen");
  $("camLayoutFields").classList.toggle("hidden",S.mode === "cam");
  $("camTag").textContent = S.mode === "screen" ? "off" : (camStream ? "live" : "");
  $("micFields").classList.toggle("hidden",!S.micOn);
  $("btnMicQuick").classList.toggle("on",S.micOn);
  $("btnCamQuick").classList.toggle("on",S.mode !== "screen");
  $("btnMicLive").classList.toggle("on",!micMuted && S.micOn);
  $("btnCamLive").classList.toggle("on",!camHidden && S.mode !== "screen");
  $("dragHint").classList.toggle("hidden",!(hasSrc && S.mode === "screencam" && camStream && !recording));
  $("modeHint").textContent = S.mode === "cam"
    ? "Records just your camera — handy for a quick talking-head intro."
    : "You'll choose the exact screen, window or tab when you pick a source.";
  const bits = [];
  if(hasSrc){ bits.push(cv.width+"×"+cv.height); bits.push(S.fps+" fps"); if(S.micOn) bits.push("mic"); if(S.sysOn) bits.push("sound"); }
  $("readyInfo").textContent = bits.join("  ·  ");
  if(hasSrc) startPreview(); else stopPreview();
  if(needScreen && !screenStream) $("sourceLabel").textContent = "Choose source";
}

/* ----------------------------------------------------------- UI bindings */
$("emptyPick").addEventListener("click",()=>{ S.mode === "cam" ? startCam() : pickScreen(); });
$("btnSource").addEventListener("click",pickScreen);
$("btnStart").addEventListener("click",startRecording);
$("btnStop").addEventListener("click",stopRecording);
$("btnPause").addEventListener("click",pauseRecording);
$("btnPlay").addEventListener("click",togglePlay);
$("btnNew").addEventListener("click",newRecording);
$("btnHelp").addEventListener("click",()=>$("dlgHelp").showModal());
$("btnSetIn").addEventListener("click",()=>{ trimA = clamp(pv.currentTime,0,trimB-0.1); drawTrim(); updateEditInfo(); });
$("btnSetOut").addEventListener("click",()=>{ trimB = clamp(pv.currentTime,trimA+0.1,tlDur); drawTrim(); updateEditInfo(); });
$("btnResetTrim").addEventListener("click",()=>{ trimA = 0; trimB = tlDur; drawTrim(); updateEditInfo(); });

$("modeSeg").addEventListener("click",e=>{
  const b = e.target.closest("button"); if(!b) return;
  S.mode = b.dataset.mode; save(); segSet("modeSeg","mode",S.mode);
  if(S.mode === "screen") stopCam(); else if(!camStream) startCam();
  sizeCanvas(); refresh();
});
$("camShape").addEventListener("click",e=>{
  const b = e.target.closest("button"); if(!b) return;
  S.camShape = b.dataset.shape; save(); segSet("camShape","shape",S.camShape); drawFrame(true);
});
$("posGrid").addEventListener("click",e=>{
  const b = e.target.closest("button"); if(!b) return;
  S.camX = [0.13,0.5,0.87][+b.dataset.x]; S.camY = [0.14,0.5,0.86][+b.dataset.y];
  save(); markPos(); drawFrame(true);
});
$("camSize").addEventListener("input",e=>{
  S.camSize = +e.target.value; $("camSizeVal").textContent = S.camSize+"%"; drawFrame(true);
});
$("camSize").addEventListener("change",save);
$("camMirror").addEventListener("change",e=>{ S.camMirror = e.target.checked; save(); drawFrame(true); });
$("camBorder").addEventListener("change",e=>{ S.camBorder = e.target.checked; save(); drawFrame(true); });
$("camSelect").addEventListener("change",e=>{ S.camId = e.target.value; save(); if(S.mode !== "screen") startCam(); });
$("micSelect").addEventListener("change",e=>{ S.micId = e.target.value; save(); if(S.micOn) startMic(); });
$("micOn").addEventListener("change",e=>{
  S.micOn = e.target.checked; save();
  if(S.micOn) startMic(); else stopMic();
  refresh();
});
$("sysOn").addEventListener("change",e=>{
  S.sysOn = e.target.checked; save(); refresh();
  if(S.sysOn && screenStream && !screenStream.getAudioTracks().length)
    toast("Re-pick the source and tick the audio box to capture computer sound.");
});
$("resSelect").addEventListener("change",e=>{ S.res = e.target.value; save(); sizeCanvas(); drawFrame(true); refresh(); });
$("fpsSelect").addEventListener("change",e=>{ S.fps = e.target.value; save(); refresh(); });
$("qSelect").addEventListener("change",e=>{ S.q = e.target.value; save(); });
$("fmtSelect").addEventListener("change",e=>{ S.fmt = e.target.value; save(); });
$("cdSelect").addEventListener("change",e=>{ S.cd = e.target.value; save(); });

$("btnMicQuick").addEventListener("click",()=>{ $("micOn").checked = !S.micOn; $("micOn").dispatchEvent(new Event("change")); });
$("btnCamQuick").addEventListener("click",()=>{
  const next = S.mode === "screen" ? "screencam" : "screen";
  S.mode = next; save(); segSet("modeSeg","mode",next);
  if(next === "screen") stopCam(); else startCam();
  refresh();
});
$("btnMicLive").addEventListener("click",toggleMic);
$("btnCamLive").addEventListener("click",toggleCam);
function toggleMic(){
  if(!S.micOn) return;
  micMuted = !micMuted;
  if(micGain) micGain.gain.value = micMuted ? 0 : 1;
  refresh(); toast(micMuted ? "Microphone muted" : "Microphone live");
}
function toggleCam(){
  if(S.mode === "screen") return;
  camHidden = !camHidden; refresh(); drawFrame(true);
}

document.addEventListener("keydown",e=>{
  const t = e.target.tagName;
  if(t === "INPUT" || t === "SELECT" || t === "TEXTAREA" || $("dlgHelp").open) return;
  const k = e.key.toLowerCase();
  const inEditor = !$("editor").classList.contains("hidden");
  if(k === "r" && !inEditor){ e.preventDefault(); recording ? stopRecording() : startRecording(); }
  else if(k === " " ){ e.preventDefault(); inEditor ? togglePlay() : (recording && pauseRecording()); }
  else if(k === "m" && !inEditor){ e.preventDefault(); recording ? toggleMic() : $("btnMicQuick").click(); }
  else if(k === "c" && !inEditor){ e.preventDefault(); recording ? toggleCam() : $("btnCamQuick").click(); }
  else if(inEditor && k === "i"){ e.preventDefault(); $("btnSetIn").click(); }
  else if(inEditor && k === "o"){ e.preventDefault(); $("btnSetOut").click(); }
  else if(inEditor && (k === "arrowleft" || k === "arrowright")){
    e.preventDefault();
    seekTo(pv.currentTime + (k === "arrowleft" ? -1 : 1)*(e.shiftKey ? 5 : 1));
  }
  else if(inEditor && k === "home"){ e.preventDefault(); seekTo(trimA); }
});

window.addEventListener("beforeunload",e=>{
  if(recording || (recordedBlob && !exporting)){ e.preventDefault(); e.returnValue = ""; }
});
window.addEventListener("resize",()=>drawFrame(true));

/* ------------------------------------------------------------------ boot */
function boot(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){
    $("empty").innerHTML = '<h2>This browser can\'t capture the screen</h2><p>Open this file in Chrome, Edge, Firefox or Opera. Safari needs the file served over https rather than opened directly.</p>';
    $("btnStart").disabled = true;
    return;
  }
  // formats
  const fmts = mimeList(), fs = $("fmtSelect");
  fmts.forEach(f=>{ const o = document.createElement("option"); o.value = f[0]; o.textContent = f[1]; fs.appendChild(o); });
  if(!fmts.length){ const o = document.createElement("option"); o.value = ""; o.textContent = "Browser default"; fs.appendChild(o); }
  S.fmt = fmts.some(f=>f[0] === S.fmt) ? S.fmt : (fmts[0] ? fmts[0][0] : "");
  fs.value = S.fmt;

  // position grid
  const pg = $("posGrid");
  for(let y=0;y<3;y++) for(let x=0;x<3;x++){
    const b = document.createElement("button");
    b.dataset.x = x; b.dataset.y = y; b.type = "button";
    b.title = ["Top","Middle","Bottom"][y]+" "+["left","centre","right"][x];
    pg.appendChild(b);
  }
  // restore settings into controls
  segSet("modeSeg","mode",S.mode); segSet("camShape","shape",S.camShape); markPos();
  $("camSize").value = S.camSize; $("camSizeVal").textContent = S.camSize+"%";
  $("camMirror").checked = S.camMirror; $("camBorder").checked = S.camBorder;
  $("micOn").checked = S.micOn; $("sysOn").checked = S.sysOn;
  $("resSelect").value = S.res; $("fpsSelect").value = S.fps; $("qSelect").value = S.q; $("cdSelect").value = S.cd;
  sizeCanvas(); drawFrame(true); refresh();
  if(S.micOn) startMic();
  if(S.mode !== "screen") startCam();
  navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener("devicechange",listDevices);
  listDevices();
}
boot();
})();