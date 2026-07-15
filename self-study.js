import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, getDocs, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

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
    .cal-cell.self-study-done { border-color: rgba(217, 179, 107, 0.8); box-shadow: inset 0 0 0 1.5px var(--gold), 0 0 10px rgba(217, 179, 107, 0.12); }
    .cal-cell.self-study-done small { color: var(--gold); font-weight: 800; opacity: 1; font-size: 0.72rem; }
    .cal-check-card { margin: 12px 0 10px; }
    label.cal-check { border-color: rgba(217, 179, 107, 0.45); background: rgba(217, 179, 107, 0.10); }
    label.cal-check input[type="checkbox"]:checked { background: var(--gold); border-color: var(--gold); }
    label.cal-check input[type="checkbox"]:disabled { opacity: 0.6; cursor: wait; }
    .skip-carry-external { margin-left: auto; flex: none; font-size: 1rem; }
    .carry-date-prefix { color: var(--danger); font-weight: 700; margin-right: 4px; }
    .app-header { padding-top: max(14px, calc(14px + env(safe-area-inset-top))); }
    .app-header h1 { line-height: 1.25; word-break: keep-all; overflow-wrap: anywhere; }
    .account-card { display: flex; align-items: center; gap: 12px; }
    .account-avatar { width: 36px; height: 36px; border-radius: 999px; background: var(--bg-elev2); object-fit: cover; flex: none; }
    .account-avatar.fallback { display: grid; place-items: center; color: var(--accent); font-weight: 800; border: 1px solid var(--line); }
    .account-name { font-weight: 700; }
    .account-email { color: var(--text-dim); font-size: 0.8rem; overflow-wrap: anywhere; }
    @media (max-width: 560px) {
      .row-2 { flex-direction: column; }
      input[type="date"], input[type="time"] { font-size: 1rem; }
      .card { overflow: hidden; }
    }
  `;
  document.head.appendChild(style);
}
function selectedDate(){ return document.querySelector('.cal-cell.selected[data-date]')?.dataset.date || ''; }
function isDone(date){ return !!selfStudyDays.get(date)?.done; }
function markCalendar(){
  document.querySelectorAll('.cal-cell[data-date]').forEach(cell=>{
    const done=isDone(cell.dataset.date);
    cell.classList.toggle('self-study-done', done);
    cell.title=done?`${cell.dataset.date} 自習`:cell.dataset.date;
    cell.setAttribute('aria-label', done?`${cell.dataset.date} 自習`:cell.dataset.date);
    if(done){ const marker=cell.querySelector('small'); if(marker) marker.textContent='📚'; }
  });
}
function injectCheck(){
  const wrap=document.querySelector('#calDayRecords');
  const date=selectedDate();
  if(!wrap || !date || wrap.querySelector('.cal-check-card')) return;
  const card=document.createElement('div'); card.className='cal-check-card';
  const label=document.createElement('label'); label.className='list-item cal-check';
  const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.checked=isDone(date); checkbox.dataset.date=date;
  const text=document.createElement('span'); text.textContent='自習';
  label.append(checkbox,text); card.append(label); wrap.prepend(card);
  checkbox.onchange=async(e)=>{
    e.target.disabled=true;
    try{ await toggleSelfStudy(e.target.dataset.date); }
    catch(err){ console.error(err); alert('自習チェックの保存に失敗しました。通信環境をご確認ください。'); }
    scheduleRender();
  };
}
function render(){ injectStyles(); markCalendar(); injectCheck(); enhanceCarryovers(); injectAccountCard(); }
function scheduleRender(){ if(renderQueued) return; renderQueued=true; requestAnimationFrame(()=>{ renderQueued=false; render(); }); }


function injectAccountCard(){
  const settings=document.querySelector('#settings.screen.active');
  if(!settings || settings.querySelector('.account-card')) return;
  const user=auth.currentUser;
  if(!user) return;
  const card=document.createElement('div');
  card.className='card account-card';
  if(user.photoURL){
    const img=document.createElement('img');
    img.className='account-avatar';
    img.src=user.photoURL;
    img.alt='アカウント画像';
    card.append(img);
  }else{
    const avatar=document.createElement('div');
    avatar.className='account-avatar fallback';
    avatar.textContent=(user.displayName||user.email||'?').slice(0,1).toUpperCase();
    card.append(avatar);
  }
  const body=document.createElement('div');
  const name=document.createElement('div');
  name.className='account-name';
  name.textContent=user.displayName || 'ログイン中';
  const email=document.createElement('div');
  email.className='account-email';
  email.textContent=user.email || user.uid;
  body.append(name,email);
  card.append(body);
  settings.prepend(card);
}

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
    const span=item.querySelector('span');
    if(span && !span.querySelector('.carry-date-prefix')){
      const prefix=document.createElement('b');
      prefix.className='carry-date-prefix';
      prefix.textContent=`${date}の分`;
      span.prepend(' ');
      span.prepend(prefix);
    }
    if(item.querySelector('.skip-carry-external')) return;
    const button=document.createElement('button');
    button.type='button';
    button.className='link-btn danger skip-carry-external';
    button.textContent='×';
    button.setAttribute('aria-label','この繰り越しを罰にする');
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
  const snap=await getDoc(ref);
  const data=snap.exists()?snap.data():{date};
  const skipped={...(data.skipped||{}), [id]: true};
  const done={...(data.done||{}), [id]: false};
  await setDoc(ref, {date, skipped, done, updatedAt:new Date().toISOString()}, {merge:true});
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

onAuthStateChanged(auth, async(user)=>{ uid=user?.uid||null; selfStudyDays=new Map(); skippedCarryovers=new Set(); if(uid){ await loadSelfStudyDays(); await loadSkippedCarryovers(); } scheduleRender(); });
document.addEventListener('click', (event)=>{ if(event.target.closest('.cal-cell[data-date]')) setTimeout(scheduleRender, 0); });
new MutationObserver(scheduleRender).observe(document.body, {childList:true, subtree:true});
injectStyles();
