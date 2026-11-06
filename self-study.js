import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, getDocs, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyC4gkAvxpB87UqVUItrLK098AY758f2hMQ', authDomain: 'study-weight.firebaseapp.com', projectId: 'study-weight', storageBucket: 'study-weight.firebasestorage.app', messagingSenderId: '850012109401', appId: '1:850012109401:web:6ba78214593f87c7054f48'
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
let uid = null;
let selfStudyDays = new Map();
let skippedCarryovers = new Set();
let renderQueued = false;

function injectStyles(){
  if(document.getElementById('selfStudyStyles')) return;
  const style=document.createElement('style');
  style.id='selfStudyStyles';
  style.textContent=`
    .cal-cell.self-study-done small { color: var(--self); font-weight: 700; }
    .cal-cell[class*='studied-']:not(.studied-0).self-study-done small { color: var(--cell-ink); }
    .cal-check-card { margin: 0 0 8px; }
    label.cal-check input[type="checkbox"]:checked { background: var(--self); border-color: var(--self); }
    label.cal-check input[type="checkbox"]:disabled { opacity: 0.6; cursor: wait; }
  `;
  document.head.appendChild(style);
}
function selectedDate(){ return document.querySelector('.cal-cell.selected[data-date]')?.dataset.date || ''; }
function isDone(date){ return !!selfStudyDays.get(date)?.done; }
function markCalendar(){
  document.querySelectorAll('.cal-cell[data-date]').forEach(cell=>{
    const done=isDone(cell.dataset.date);
    cell.classList.toggle('self-study-done', done);
    if(!cell.dataset.baseLabel) cell.dataset.baseLabel=cell.getAttribute('aria-label')||cell.dataset.date;
    cell.setAttribute('aria-label', done?`${cell.dataset.baseLabel} 自習室`:cell.dataset.baseLabel);
    const marker=cell.querySelector('small'); if(marker && marker.textContent!==(done?'自':'')) marker.textContent=done?'自':'';
  });
}
function injectCheck(){
  const wrap=document.querySelector('#calDayRecords');
  const date=selectedDate();
  if(!wrap || !date || wrap.querySelector('.cal-check-card')) return;
  const card=document.createElement('div'); card.className='cal-check-card';
  const label=document.createElement('label'); label.className='list-item cal-check';
  const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.checked=isDone(date); checkbox.dataset.date=date;
  const text=document.createElement('span'); text.textContent='自習室';
  label.append(checkbox,text); card.append(label); wrap.prepend(card);
  checkbox.onchange=async(e)=>{
    e.target.disabled=true;
    try{ await toggleSelfStudy(e.target.dataset.date); }
    catch(err){ console.error(err); alert('自習チェックの保存に失敗しました。通信環境をご確認ください。'); }
    scheduleRender();
  };
}
function render(){ injectStyles(); markCalendar(); injectCheck(); enhanceCarryovers(); }
function scheduleRender(){ if(renderQueued) return; renderQueued=true; requestAnimationFrame(()=>{ renderQueued=false; render(); }); }

function carryKey(date,id){ return `${date}:${id}`; }
async function loadSkippedCarryovers(){
  if(!uid) return;
  const snap=await getDocs(collection(db, `users/${uid}/scheduleDays`));
  skippedCarryovers=new Set();
  snap.docs.forEach(d=>{
    const skipped=d.data().skipped||{};
    Object.keys(skipped).filter(id=>skipped[id]).forEach(id=>skippedCarryovers.add(carryKey(d.id,id)));
  });
}
function enhanceCarryovers(){
  document.querySelectorAll('.schCarryCheck[data-date][data-id]').forEach(input=>{
    const date=input.dataset.date;
    const id=input.dataset.id;
    const item=input.closest('.carry-item');
    if(!item) return;
    if(skippedCarryovers.has(carryKey(date,id))){ item.remove(); return; }
    const title=item.closest('.card')?.querySelector('.carry-title');
    if(title) title.textContent=`繰り越し（${date} の分・未完了）`;
    if(item.querySelector('.skip-carry-external')) return;
    const button=document.createElement('button');
    button.type='button';
    button.className='link-btn danger skip-carry-external';
    button.textContent='外す';
    button.setAttribute('aria-label','この繰り越しを外す');
    button.onclick=async(event)=>{
      event.preventDefault(); event.stopPropagation();
      if(!confirm('この繰り越しはもうできない扱いにしますか？')) return;
      try{ await skipCarryover(date,id); item.remove(); }
      catch(err){ console.error(err); alert('繰り越しの除外に失敗しました。通信環境をご確認ください。'); }
    };
    item.append(button);
  });
}
async function skipCarryover(date,id){
  if(!uid || !date || !id) return;
  const ref=doc(db, `users/${uid}/scheduleDays/${date}`);
  // 外した1件だけを書き込む（行の他のチェックを読み込んだ値で書き戻さない）
  await setDoc(ref, {date, skipped:{[id]:true}, done:{[id]:false}, updatedAt:new Date().toISOString()}, {merge:true});
  skippedCarryovers.add(carryKey(date,id));
}

async function loadSelfStudyDays(){
  if(!uid) return;
  const snap=await getDocs(collection(db, `users/${uid}/selfStudyDays`));
  selfStudyDays=new Map(snap.docs.map(d=>[d.id,{id:d.id,...d.data()}]));
  scheduleRender();
}
async function toggleSelfStudy(date){
  if(!uid || !date) return;
  const next=!isDone(date);
  const data={date,done:next,updatedAt:new Date().toISOString()};
  if(!selfStudyDays.has(date)) data.createdAt=data.updatedAt;
  await setDoc(doc(db, `users/${uid}/selfStudyDays/${date}`), data, {merge:true});
  selfStudyDays.set(date,{id:date,...(selfStudyDays.get(date)||{}),...data});
}

onAuthStateChanged(auth, async(user)=>{ uid=user?.uid||null; selfStudyDays=new Map(); skippedCarryovers=new Set(); if(uid){ await Promise.all([loadSelfStudyDays(), loadSkippedCarryovers()]); } scheduleRender(); });
document.addEventListener('click', (event)=>{ if(event.target.closest('.cal-cell[data-date]')) setTimeout(scheduleRender, 0); });
new MutationObserver(scheduleRender).observe(document.body, {childList:true, subtree:true});
injectStyles();
