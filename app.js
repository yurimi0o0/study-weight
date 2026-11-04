import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, getDocs, getDoc, addDoc, setDoc, updateDoc, deleteDoc, query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getMessaging, getToken, deleteToken, onMessage } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

const APP_NAME = 'Study Density Log';
const DEFAULT_QUALITY = { S: 1.05, A: 1.0, B: 0.55, C: 0.3, D: 0.1 };
const DEFAULT_SUBJECTS = ['英語','数学','国語','社会','理科','情報','その他'];
const DEFAULT_LABELS = ['自習','学校','学校課題','塾','塾宿題','授業','単語帳','テスト勉強','受験勉強','その他'];
const DEFAULT_SCHEDULE_TASKS = [
  { id: 'st1', text: '過去問長文1題' },
  { id: 'st2', text: '基礎英文解釈の技術100を2題' },
  { id: 'st3', text: '文法ポラリス1節' },
  { id: 'st4', text: '単語100個' },
];
const NOTIFY_HOUR_KEY = 'sdl_notify_hour';

const firebaseConfig = {
  apiKey: 'AIzaSyC4gkAvxpB87UqVUItrLK098AY758f2hMQ', authDomain: 'study-weight.firebaseapp.com', projectId: 'study-weight', storageBucket: 'study-weight.firebasestorage.app', messagingSenderId: '850012109401', appId: '1:850012109401:web:6ba78214593f87c7054f48'
};
// Firebase Console > プロジェクトの設定 > Cloud Messaging > ウェブプッシュ証明書 で生成した鍵を貼り付ける
const FCM_VAPID_KEY = 'BI5D69jRhWmow6YoJh2QRpXk6XHiJLckmQsoQRrzVkvCWwOh3w7H1adDOjPneVUxeweGU-jhKgPxghVmh7wT5Ds';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
let messaging = null; // 未対応ブラウザでgetMessaging(app)が例外を投げるため遅延初期化
let swReg = null;      // Service Worker登録（getTokenに渡す）
let currentFcmToken = null;
const state = { uid: null, userName: '', userEmail: '', subjects: [], materials: [], labels: [], records: [], tests: [], quality: { ...DEFAULT_QUALITY }, taskMemo: '', weekGoal: 0, calendarMonth: null, selectedDate: null, schedule: { startDate: '', defaultTasks: [] }, schedulePeriods: [], scheduleDays: [] };

const $ = s => document.querySelector(s);
// toISOString()はUTCに変換するため、JST(UTC+9)では深夜0時〜9時台に日付が1日ずれる。カレンダー日付は必ずローカル値から組み立てる
const toDateStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parseDateStr = dateStr => { const [y,m,d]=dateStr.split('-').map(Number); return new Date(y,m-1,d); };
const todayStr = () => toDateStr(new Date());
const logicalNow = () => { const n=new Date(); if(n.getHours()<4) n.setDate(n.getDate()-1); return n; };
const logicalDateStr = () => toDateStr(logicalNow());
const nowTime = () => new Date().toTimeString().slice(0,5);
const mondayOf = (d = new Date()) => { const x=new Date(d); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); return toDateStr(x); };
const minFromTime = t => t ? (+t.slice(0,2))*60 + (+t.slice(3,5)) : null;
const calcMinutesByTime = (s,e)=> { if(!s||!e) return null; const diff=minFromTime(e)-minFromTime(s); return diff>=0 ? diff : diff+1440; };
const focusMinutes = r => Math.round((Number(r.minutes)||0) * (state.quality[r.quality] ?? 1));

function escapeHtml(value){
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}
const attr = escapeHtml;
function withTimeout(promise, ms=15000){
  let timer;
  const timeout=new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(()=>clearTimeout(timer));
}

function normalizeDateInput(input){
  const m = String(input || '').trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if(!m) return null;
  const y = +m[1], mm = +m[2], dd = +m[3];
  const dt = new Date(y, mm - 1, dd);
  if (dt.getFullYear() !== y || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
  return `${String(y).padStart(4,'0')}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
}

function userCol(path){ return collection(db, `users/${state.uid}/${path}`); }
function userDoc(path,id){ return doc(db, `users/${state.uid}/${path}/${id}`); }

async function ensureSeedData(){
  await setDoc(doc(db, `users/${state.uid}`), { updatedAt:new Date().toISOString() }, {merge:true});
  if ((await getDocs(userCol('subjects'))).empty) for (const [i, name] of DEFAULT_SUBJECTS.entries()) await addDoc(userCol('subjects'), { name, color:'#26c6da', order:i, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
  if ((await getDocs(userCol('labels'))).empty) for (const name of DEFAULT_LABELS) await addDoc(userCol('labels'), { name, color:'#64b5f6', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
  const settingsRef = doc(db, `users/${state.uid}/settings/main`); if (!(await getDoc(settingsRef)).exists()) await setDoc(settingsRef, { quality: DEFAULT_QUALITY, appName: APP_NAME });
}
async function loadAll(){
  state.subjects=(await getDocs(query(userCol('subjects')))).docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.order??999)-(b.order??999)||a.name.localeCompare(b.name,'ja'));
  state.materials=(await getDocs(query(userCol('materials')))).docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.order??999)-(b.order??999)||a.name.localeCompare(b.name,'ja'));
  state.labels=(await getDocs(query(userCol('labels')))).docs.map(d=>({id:d.id,...d.data()}));
  state.records=(await getDocs(query(userCol('studyRecords'),orderBy('date','desc')))).docs.map(d=>({id:d.id,...d.data()}));
  state.tests=(await getDocs(query(userCol('tests'),orderBy('date','asc')))).docs.map(d=>({id:d.id,...d.data()}));
  const goals=(await getDocs(query(userCol('weeklyGoals'),orderBy('weekStartDate','desc')))).docs.map(d=>({id:d.id,...d.data()}));
  state.weekGoal=(goals.find(g=>g.weekStartDate===mondayOf(logicalNow()))?.targetMinutes)||0;
  const settings=(await getDoc(doc(db,`users/${state.uid}/settings/main`))).data(); state.quality=settings?.quality || { ...DEFAULT_QUALITY }; state.taskMemo=settings?.taskMemo || '';
  const scheduleSnap=await getDoc(doc(db,`users/${state.uid}/settings/schedule`)); state.schedule=scheduleSnap.exists()?{startDate:'',defaultTasks:[],...scheduleSnap.data()}:{startDate:'',defaultTasks:[]};
  state.schedulePeriods=(await getDocs(query(userCol('schedulePeriods')))).docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.order??999)-(b.order??999)||(a.startDate||'').localeCompare(b.startDate||''));
  state.scheduleDays=(await getDocs(userCol('scheduleDays'))).docs.map(d=>({id:d.id,...d.data()}));
}

function aggregate(){
  const t=logicalDateStr(), w=mondayOf(logicalNow()), m=t.slice(0,7); let out={today:0,todayF:0,week:0,weekF:0,month:0,monthF:0,total:0,totalF:0};
  state.records.forEach(r=>{const min=+r.minutes||0,f=focusMinutes(r); out.total+=min; out.totalF+=f; if(r.date===t){out.today+=min;out.todayF+=f;} if(r.date>=w){out.week+=min;out.weekF+=f;} if((r.date||'').startsWith(m)){out.month+=min;out.monthF+=f;}});
  return out;
}
const fmtH = m => { const t=Math.round(m||0); return `${Math.floor(t/60)}時間${t%60}分`; };
const fmtHHMM = m => { const t=Math.min(1439,Math.max(0,Math.round(m||0))); return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`; };
const fmtClock = m => { const t=((Math.round(m||0)%1440)+1440)%1440; return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`; };

const WEEKDAYS=['日','月','火','水','木','金','土'];
const ICON_CHEV=`<svg class='ico chev' viewBox='0 0 24 24' aria-hidden='true'><path d='m9 6 6 6-6 6'/></svg>`;
const ICON_BACK=`<svg class='ico' viewBox='0 0 24 24' aria-hidden='true'><path d='m15 6-6 6 6 6'/></svg>`;
const ICON_EDIT=`<svg class='ico' viewBox='0 0 24 24' aria-hidden='true'><path d='M4 20h4L19 9l-4-4L4 16v4Z'/><path d='m13.5 6.5 4 4'/></svg>`;
const ICON_TRASH=`<svg class='ico' viewBox='0 0 24 24' aria-hidden='true'><path d='M4 7h16'/><path d='M10 11v6M14 11v6'/><path d='M6 7l1 13h10l1-13'/><path d='M9 7V4h6v3'/></svg>`;
const ICON_UP=`<svg class='ico' viewBox='0 0 24 24' aria-hidden='true'><path d='m6 15 6-6 6 6'/></svg>`;
const ICON_DOWN=`<svg class='ico' viewBox='0 0 24 24' aria-hidden='true'><path d='m6 9 6 6 6-6'/></svg>`;
const SCREEN_TITLES={dashboard:'ホーム',list:'タイムライン',record:'記録を追加',goals:'目標',settings:'設定'};
const setTitle=t=>{ $('#appTitle').textContent=t; };
const fmtMD = dateStr => { const d=parseDateStr(dateStr); return `${d.getMonth()+1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`; };
const bigDuration = m => { const t=Math.round(m||0); const h=Math.floor(t/60), mm=t%60; return h?`${h}<span class='unit'>時間</span>${mm}<span class='unit'>分</span>`:`${mm}<span class='unit'>分</span>`; };
const fmtShort = m => { const t=Math.round(m||0); const h=Math.floor(t/60), mm=t%60; return h?`${h}時間${mm}分`:`${mm}分`; };
let selectedBarIndex=6;

async function renderDashboard(){
  const baseDate=logicalDateStr(); const a=aggregate(); const next=state.tests.filter(t=>t.date>=baseDate).sort((x,y)=>x.date.localeCompare(y.date))[0];
  const days=next?Math.ceil((parseDateStr(next.date)-parseDateStr(baseDate))/86400000):null;
  const latest7=[...Array(7)].map((_,i)=>addDays(baseDate,i-6));
  const bars=latest7.map(d=>state.records.filter(r=>r.date===d).reduce((s,r)=>s+(+r.minutes||0),0));
  const max=Math.max(1,...bars);
  const avg7=bars.reduce((s,v)=>s+v,0)/7;
  if(state.schedule?.startDate && baseDate>=state.schedule.startDate) await ensureScheduleDay(baseDate);
  const pct=state.weekGoal?Math.min(100,Math.round(a.week/state.weekGoal*100)):0;
  if(selectedBarIndex<0||selectedBarIndex>6) selectedBarIndex=6;
  $('#dashboard').innerHTML=`
  <section class='surface'>
    <div class='hero-meta'><span id='nowClock'>${formatNowDateTime()}</span><span>4:00で日付が変わります</span></div>
    <div class='hero-main'>
      <div><div class='hero-label'>今日</div><div class='hero-value'>${bigDuration(a.today)}</div><div class='hero-sub'>集中 ${fmtShort(a.todayF)}</div></div>
      ${streakHtml()}
    </div>
    ${streakBrokenHtml()}
    ${state.weekGoal?`<div class='meter-row'><span>今週 <b>${fmtShort(a.week)}</b> / 目標 ${fmtShort(state.weekGoal)}</span><b>${pct}%</b></div><div class='progress' role='progressbar' aria-valuemin='0' aria-valuemax='100' aria-valuenow='${pct}' aria-label='今週の目標の達成率'><div class='progress-fill' style='width:${pct}%'></div></div>`:''}
    ${next?`<div class='hero-row'><span>次のテスト　<b>${escapeHtml(next.name)}</b></span><span>あと <b>${days}</b> 日</span></div>`:''}
  </section>
  ${tasksCardHtml()}
  <section class='surface'>
    <div class='surface-head'><h2>直近7日</h2><span class='muted tabnum'>平均 ${fmtShort(avg7)}</span></div>
    <div class='chart-readout' id='barReadout' aria-live='polite'></div>
    <div class='bars' role='group' aria-label='直近7日の学習時間'>${bars.map((v,i)=>`<button type='button' class='bar-btn' data-i='${i}' aria-pressed='${i===selectedBarIndex}' aria-label='${fmtMD(latest7[i])} ${fmtShort(v)}'><span class='bar' style='height:${v?Math.max(3,v/max*100):0}%'></span></button>`).join('')}</div>
    <div class='bar-labels'>${latest7.map((d,i)=>`<span data-i='${i}' class='${i===selectedBarIndex?'is-selected':''}'>${i===6?'今日':WEEKDAYS[parseDateStr(d).getDay()]}</span>`).join('')}</div>
  </section>
  <section class='surface'>${[['今週',a.week,a.weekF],['今月',a.month,a.monthF],['累計',a.total,a.totalF]].map(v=>`<div class='total-row'><span class='name'>${v[0]}</span><span class='value'>${fmtShort(v[1])}</span><span class='muted'>集中 ${fmtShort(v[2])}</span></div>`).join('')}</section>
  ${taskMemoHtml()}
  <details class='fold'><summary>内訳（教科・教材・ラベル・質）</summary>
  ${renderBreakdownCard('教科別', state.subjects.map(s=>[s.name,state.records.filter(r=>r.subjectId===s.id).reduce((x,r)=>x+(+r.minutes||0),0)]))}
  ${renderMaterialTotalsCard()}
  ${renderBreakdownCard('ラベル別', state.labels.map(l=>[l.name,state.records.filter(r=>(r.labelIds||[]).includes(l.id)).reduce((x,r)=>x+(+r.minutes||0),0)]))}
  ${renderBreakdownCard('質別', ['S','A','B','C','D'].map(q=>[q,state.records.filter(r=>r.quality===q).reduce((x,r)=>x+(+r.minutes||0),0)]))}
  </details>`;
  const drawReadout=()=>{
    const i=selectedBarIndex, v=bars[i];
    $('#barReadout').innerHTML=`<b>${fmtShort(v)}</b><span class='muted'>${v}分　${fmtMD(latest7[i])}${i===6?' 今日':''}</span>`;
    document.querySelectorAll('#dashboard .bar-btn').forEach(b=>b.setAttribute('aria-pressed', String(+b.dataset.i===i)));
    document.querySelectorAll('#dashboard .bar-labels span').forEach(s=>s.classList.toggle('is-selected', +s.dataset.i===i));
  };
  document.querySelectorAll('#dashboard .bar-btn').forEach(b=>b.onclick=()=>{ selectedBarIndex=+b.dataset.i; drawReadout(); });
  drawReadout();
  bindScheduleChecks();
  bindTaskMemo();
  startDashboardClock();
}
function renderMaterialTotalsCard(){
  const map = new Map();
  state.records.forEach(r=>{
    const key = r.materialId || '__none__';
    const item = map.get(key) || { materialId:key, minutes:0, focus:0, count:0, pages:0, problems:0, subjectId:r.subjectId||'' };
    item.minutes += +r.minutes||0; item.focus += focusMinutes(r); item.count += 1; item.pages += +r.pages||0; item.problems += +r.problems||0;
    map.set(key,item);
  });
  const rows=[...map.values()].sort((a,b)=>b.minutes-a.minutes);
  return `<section class='surface'><div class='surface-head'><h2>教材別</h2></div>${rows.map(v=>{const m=state.materials.find(x=>x.id===v.materialId); const materialName=m?.name||'教材未選択'; const sid=m?.subjectId||v.subjectId; const sname=subjectName(sid); return `<div class='legend-row'><span>${escapeHtml(materialName)} <span class='muted'>${escapeHtml(sname)}</span><br><span class='muted'>${v.count}回　${v.pages}ページ　${v.problems}問</span></span><span>${fmtShort(v.minutes)}<br>集中 ${fmtShort(v.focus)}</span></div>`;}).join('')||'<div class="muted">記録はまだありません</div>'}</section>`;
}
function renderBreakdownCard(title,pairs){
  const rows=pairs.filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]); const total=rows.reduce((s,[,v])=>s+v,0)||1;
  return `<section class='surface'><div class='surface-head'><h2>${title}</h2></div>${rows.map(([k,v])=>`<div class='legend-row'><span>${escapeHtml(k)}</span><span>${fmtShort(v)}　${Math.round(v/total*100)}%</span></div>`).join('')||'<div class="muted">記録はまだありません</div>'}</section>`;
}

let swTimer=null, swSeconds=0;
function renderRecordForm(edit=null){
  const r=edit||{date:logicalDateStr(),startTime:'',endTime:nowTime(),minutes:'',subjectId:'',materialId:'',labelIds:[],quality:'A',pages:'',problems:'',memo:''};
  const selectedLabels = new Set(r.labelIds || []);
  const mins=+r.minutes||0;
  const timeUnknown = !!edit && !r.startTime && !r.endTime;
  setTitle(edit?'記録を編集':'記録を追加');
  $('#record').innerHTML=`
  <section class='surface'>
    <div class='field-group date-dur'>
      <div class='field'><label for='fDate'>日付</label><input id='fDate' type='date' value='${r.date}' /></div>
      <div class='field'><span class='field-label' id='durLabel'>学習時間</span><div class='duration' role='group' aria-labelledby='durLabel'><input id='fDurH' type='number' inputmode='numeric' min='0' max='99' step='1' value='${mins?Math.floor(mins/60):''}' placeholder='0' aria-label='時間'/><span>時間</span><input id='fDurM' type='number' inputmode='numeric' min='0' max='59' step='1' value='${mins?mins%60:''}' placeholder='0' aria-label='分'/><span>分</span></div></div>
    </div>
    <div class='field-group'>
      <label class='switch-row' for='fTimeUnknown'><span>時刻がわからない</span><input id='fTimeUnknown' type='checkbox' role='switch' ${timeUnknown?'checked':''}/></label>
      <div class='row-2' id='timeRange' style='margin-top:8px' ${timeUnknown?'hidden':''}><div><label for='fStart'>開始</label><input id='fStart' type='time' value='${r.startTime||''}'/></div><div><label for='fEnd'>終了</label><input id='fEnd' type='time' value='${r.endTime||''}'/></div></div>
    </div>
    <div class='field-group'>
      <div class='field'><label for='fSubject'>教科</label><select id='fSubject'>${state.subjects.map(s=>`<option value='${s.id}' ${s.id===r.subjectId?'selected':''}>${escapeHtml(s.name)}</option>`).join('')}</select></div>
      <div class='field'><label for='fMaterial'>教材</label><select id='fMaterial'><option value=''>未選択</option></select></div>
      <div class='field'><span class='field-label' id='qLabel'>質</span><div class='segmented' role='radiogroup' aria-labelledby='qLabel'>${['S','A','B','C','D'].map(q=>`<label><input type='radio' name='fQuality' value='${q}' ${q===(r.quality||'A')?'checked':''}/>${q}</label>`).join('')}</div></div>
    </div>
    <div class='field-group'>
      <span class='field-label'>ラベル</span><div id='labelChips' class='tags'>${state.labels.map(l=>`<button type='button' class='chip ${selectedLabels.has(l.id)?'active':''}' aria-pressed='${selectedLabels.has(l.id)}' data-id='${l.id}'>${escapeHtml(l.name)}</button>`).join('')}</div>
    </div>
    <div class='field-group'>
      <div class='row-2'><div><label for='fPages'>ページ数</label><input id='fPages' type='number' inputmode='numeric' value='${r.pages||''}' /></div><div><label for='fProblems'>問題数</label><input id='fProblems' type='number' inputmode='numeric' value='${r.problems||''}' /></div></div>
      <div class='field'><label for='fMemo'>メモ</label><textarea id='fMemo'>${escapeHtml(r.memo||'')}</textarea></div>
    </div>
  </section>
  <section class='surface sw'>
    <div class='sw-head'><h3>ストップウォッチ</h3><span id='swDisplay' class='sw-display'>00:00:00</span></div>
    <div class='sw-actions'><button id='swToggle' type='button' class='btn small primary'>開始</button><button id='swReset' type='button' class='btn small'>リセット</button><button id='swSet' type='button' class='btn small'>学習時間に反映</button></div>
  </section>
  <div class='save-bar'>${edit?"<button id='cancelEdit' class='btn'>キャンセル</button>":''}<button id='saveRecord' class='btn primary'>${edit?'変更を保存':'記録を追加'}</button></div>`;
  // 教科に紐づく教材だけを選択肢に出す（教科未設定の旧教材は全教科で表示）
  const fillMaterials=(preferred='')=>{
    const sid=$('#fSubject').value;
    const opts=state.materials.filter(m=>!m.subjectId || m.subjectId===sid);
    $('#fMaterial').innerHTML=`<option value=''>未選択</option>`+opts.map(m=>`<option value='${m.id}'>${escapeHtml(m.name)}</option>`).join('');
    $('#fMaterial').value = opts.some(m=>m.id===preferred) ? preferred : '';
  };
  fillMaterials(r.materialId);
  $('#fSubject').onchange=()=>fillMaterials($('#fMaterial').value);
  document.querySelectorAll('#labelChips .chip').forEach(chip => chip.onclick=()=>{ chip.classList.toggle('active'); chip.setAttribute('aria-pressed', String(chip.classList.contains('active'))); });

  // ---- ストップウォッチ ----
  const drawSw=()=>{ const el=$('#swDisplay'); if(el) el.textContent=new Date(swSeconds*1000).toISOString().slice(11,19); };
  const setSwRunning=running=>{ const b=$('#swToggle'); b.textContent=running?'停止':(swSeconds?'再開':'開始'); b.classList.toggle('primary', !running); };
  $('#swToggle').onclick=()=>{
    if(swTimer){ clearInterval(swTimer); swTimer=null; setSwRunning(false); return; }
    swTimer=setInterval(()=>{ swSeconds++; drawSw(); },1000); setSwRunning(true);
  };
  $('#swReset').onclick=()=>{ clearInterval(swTimer); swTimer=null; swSeconds=0; drawSw(); setSwRunning(false); };
  $('#swSet').onclick=()=>{ const total=Math.max(1,Math.round(swSeconds/60)); setDuration(total); touch('duration'); };
  drawSw(); setSwRunning(!!swTimer); // タブを移動してもストップウォッチは止めない

  // ---- 学習時間・開始・終了の連動 ----
  // 3項目を「最近さわった順」に並べ、値の入った上位2項目を固定して、残りの1項目だけを計算で埋める。
  // 保存時にも同じ規則で計算するので、最後に手で直した値が上書きされることはない。
  // 初期の並び: 終了を直すと学習時間が、学習時間を直すと終了が変わる（開始は固定）
  const getMinutes=()=>{ const h=Math.max(0,Math.floor(+$('#fDurH').value||0)); const m=Math.max(0,Math.floor(+$('#fDurM').value||0)); return h*60+m; };
  const setDuration=total=>{ const t=Math.max(0,Math.round(total||0)); $('#fDurH').value=Math.floor(t/60); $('#fDurM').value=t%60; };
  const hasValue=f=>f==='duration'?getMinutes()>0:!!$(f==='start'?'#fStart':'#fEnd').value;
  let anchors = edit ? ['start','end','duration'] : ['end','start','duration'];
  const derive=()=>{
    if($('#fTimeUnknown').checked) return;
    const fixed=anchors.filter(hasValue).slice(0,2);
    if(fixed.length<2) return;
    const target=['start','end','duration'].find(f=>!fixed.includes(f));
    const start=$('#fStart').value, end=$('#fEnd').value, dur=getMinutes();
    if(target==='duration') setDuration(calcMinutesByTime(start,end));
    if(target==='end') $('#fEnd').value=fmtClock(minFromTime(start)+dur);
    if(target==='start') $('#fStart').value=fmtClock(minFromTime(end)-dur);
  };
  const touch=f=>{ anchors=[f, ...anchors.filter(x=>x!==f)]; if(hasValue(f)) derive(); };
  ['input','change'].forEach(ev=>{
    $('#fStart').addEventListener(ev,()=>touch('start'));
    $('#fEnd').addEventListener(ev,()=>touch('end'));
    $('#fDurH').addEventListener(ev,()=>touch('duration'));
    $('#fDurM').addEventListener(ev,()=>touch('duration'));
  });
  $('#fDurM').addEventListener('change',()=>{ const m=+$('#fDurM').value||0; if(m>59) setDuration(getMinutes()); }); // 「90分」のような入力は 1時間30分 に繰り上げる
  $('#fTimeUnknown').onchange=()=>{ $('#timeRange').hidden=$('#fTimeUnknown').checked; if(!$('#fTimeUnknown').checked) derive(); };

  const saveHandler=async()=>{
    const unknown=$('#fTimeUnknown').checked;
    if(!unknown) derive();
    const normalizedDate=normalizeDateInput($('#fDate').value);
    if(!normalizedDate) return alert('日付が正しくありません。日付を選び直してください。');
    const totalMinutes=getMinutes();
    if(!totalMinutes) return alert('学習時間を入力してください。');
    const data={date:normalizedDate,startTime:unknown?'':$('#fStart').value,endTime:unknown?'':$('#fEnd').value,minutes:totalMinutes,subjectId:$('#fSubject').value,materialId:$('#fMaterial').value,labelIds:[...document.querySelectorAll('#labelChips .chip.active')].map(o=>o.dataset.id),quality:document.querySelector("input[name='fQuality']:checked")?.value||'A',pages:+($('#fPages').value||0),problems:+($('#fProblems').value||0),memo:$('#fMemo').value,updatedAt:new Date().toISOString()};
    const btn=$('#saveRecord'); btn.disabled=true; btn.textContent='保存中…';
    try{
      if(edit) await updateDoc(userDoc('studyRecords',edit.id),data); else await addDoc(userCol('studyRecords'),{...data,createdAt:new Date().toISOString()});
    }catch(err){
      console.error(err); btn.disabled=false; btn.textContent=edit?'変更を保存':'記録を追加';
      return alert('保存できませんでした。通信環境を確認して、もう一度お試しください。');
    }
    if(!edit){ clearInterval(swTimer); swTimer=null; swSeconds=0; }
    await refresh(); switchScreen('list');
  };
  $('#saveRecord').onclick=saveHandler;
  if(edit) $('#cancelEdit').onclick=()=>switchScreen('list');
}

function renderList(){
  $('#list').innerHTML=`<details class='fold'><summary>絞り込み</summary><section class='surface'><div class='row-2'><div><label for='fltDate'>日付</label><input id='fltDate' type='date'/></div><div><label for='fltSubject'>教科</label><select id='fltSubject'><option value=''>すべて</option>${state.subjects.map(s=>`<option value='${s.id}'>${escapeHtml(s.name)}</option>`).join('')}</select></div></div><div class='row-2' style='margin-top:12px'><div><label for='fltQuality'>質</label><select id='fltQuality'><option value=''>すべて</option>${['S','A','B','C','D'].map(q=>`<option>${q}</option>`).join('')}</select></div><div><label for='fltLabel'>ラベル</label><select id='fltLabel'><option value=''>すべて</option>${state.labels.map(l=>`<option value='${l.id}'>${escapeHtml(l.name)}</option>`).join('')}</select></div></div></section></details><div id='recordsWrap'></div>`;
  const draw=()=>{const d=$('#fltDate').value,s=$('#fltSubject').value,q=$('#fltQuality').value,l=$('#fltLabel').value;
    const rows=state.records.filter(r=>(!d||r.date===d)&&(!s||r.subjectId===s)&&(!q||r.quality===q)&&(!l||(r.labelIds||[]).includes(l))).sort((a,b)=>`${b.date} ${b.endTime||''}`.localeCompare(`${a.date} ${a.endTime||''}`));
    const today=logicalDateStr(), yest=addDays(today,-1);
    const dayLabel=d=>d===today?'今日':d===yest?'昨日':fmtMD(d);
    const post=r=>{ const sub=subjectName(r.subjectId), mat=materialName(r.materialId); const t=r.startTime||r.endTime||'';
      return `<article class='post'>
      <div class='avatar' aria-hidden='true'>${escapeHtml(sub.slice(0,1))}</div>
      <div class='post-body'>
        <div class='post-head'><b class='post-name'>${escapeHtml(sub)}</b>${mat?`<span class='post-sub'>${escapeHtml(mat)}</span>`:''}<time class='post-time' datetime='${r.date}'>${dayLabel(r.date)}${t?` ${t}`:''}</time></div>
        ${r.memo?`<p class='post-text'>${escapeHtml(r.memo)}</p>`:''}
        <div class='post-stats'><span class='post-big'>${fmtShort(r.minutes)}</span><span>${r.startTime||r.endTime?`${r.startTime||'?'}–${r.endTime||'?'}`:'時刻不明'}</span><span>集中 ${fmtShort(focusMinutes(r))}</span><span>質${escapeHtml(r.quality||'')}</span>${(r.labelIds||[]).map(id=>`<span class='tag'>${escapeHtml(labelName(id))}</span>`).join('')}</div>
        <div class='post-actions'><button class='post-act edit' data-id='${r.id}' aria-label='編集'>${ICON_EDIT}</button><button class='post-act danger del' data-id='${r.id}' aria-label='削除'>${ICON_TRASH}</button></div>
      </div>
    </article>`; };
    $('#recordsWrap').innerHTML=rows.length?`<div class='feed'>${rows.map(post).join('')}</div>`
      :`<section class='surface empty-state'>${state.records.length?'条件に合う記録はありません':'まだ記録がありません'}</section>`;
    document.querySelectorAll('#recordsWrap .edit').forEach(b=>b.onclick=()=>{switchScreen('record');renderRecordForm(state.records.find(x=>x.id===b.dataset.id));});
    document.querySelectorAll('#recordsWrap .del').forEach(b=>b.onclick=async()=>{if(confirm('この記録を削除しますか？')){await deleteDoc(userDoc('studyRecords',b.dataset.id)); await refresh();}});
  }; ['fltDate','fltSubject','fltQuality','fltLabel'].forEach(id=>$('#'+id).onchange=draw); draw();
}
const subjectName=id=>state.subjects.find(x=>x.id===id)?.name||'未設定';
const materialName=id=>state.materials.find(x=>x.id===id)?.name||'';
const labelName=id=>state.labels.find(x=>x.id===id)?.name||'不明';

function renderManageHtml(){ return `${settingsBackHtml('教科・教材・ラベル')}${managerBlock('教科','subjects',state.subjects,false)}${managerBlock('教材','materials',state.materials,false,true)}${managerBlock('ラベル','labels',state.labels,false)}`; }
function managerBlock(title,key,items,hasColor=false,hasSubject=false){ return `<section class='surface'><div class='surface-head'><h2>${title}</h2><span class='muted'>${items.length}件</span></div><div class='row'>${hasSubject?`<select id='new-${key}-subject' aria-label='所属する教科'>${state.subjects.map(s=>`<option value='${s.id}'>${escapeHtml(s.name)}</option>`).join('')}</select>`:''}<input id='new-${key}-name' placeholder='${title}名' aria-label='新しい${title}名'/><button class='btn add' data-key='${key}'>追加</button></div><div style='margin-top:8px'>${items.map((i,idx)=>`<div class='list-item' data-item-id='${i.id}'><span>${escapeHtml(i.name)}${hasSubject?`<span class='muted'>　${escapeHtml(subjectName(i.subjectId))}</span>`:''}</span><div class='item-actions'><button class='icon-btn move' data-key='${key}' data-id='${i.id}' data-dir='up' aria-label='上へ' ${idx===0?'disabled':''}>${ICON_UP}</button><button class='icon-btn move' data-key='${key}' data-id='${i.id}' data-dir='down' aria-label='下へ' ${idx===items.length-1?'disabled':''}>${ICON_DOWN}</button><button class='link-btn editm' data-key='${key}' data-id='${i.id}'>編集</button><button class='link-btn danger delm' data-key='${key}' data-id='${i.id}'>削除</button></div></div>`).join('')}</div></section>`; }
function bindManager(){ document.querySelectorAll('.add').forEach(b=>b.onclick=async()=>{const key=b.dataset.key; const name=$(`#new-${key}-name`).value.trim(); if(!name)return; const list = key==='subjects'?state.subjects:(key==='materials'?state.materials:state.labels); const base={name,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),order:list.length}; if(key==='materials') base.subjectId=$('#new-materials-subject').value; if(key!=='materials') base.color='#26c6da'; await addDoc(userCol(key),base); await refresh(); switchScreen('settings'); renderSettings('manage');});
  document.querySelectorAll('.delm').forEach(b=>b.onclick=async()=>{if(confirm('関連記録がある可能性があります。削除しますか？')){await deleteDoc(userDoc(b.dataset.key,b.dataset.id)); await refresh();}});
  document.querySelectorAll('.move').forEach(b=>b.onclick=async()=>{const key=b.dataset.key; const arr=key==='subjects'?state.subjects:(key==='materials'?state.materials:state.labels); const i=arr.findIndex(x=>x.id===b.dataset.id); const j=b.dataset.dir==='up'?i-1:i+1; if(i<0||j<0||j>=arr.length) return; const a=arr[i], c=arr[j]; await updateDoc(userDoc(key,a.id),{order:j,updatedAt:new Date().toISOString()}); await updateDoc(userDoc(key,c.id),{order:i,updatedAt:new Date().toISOString()}); await refresh(); renderSettings('manage');});
  // インライン編集（名前の変更。教材のみ所属教科も変更できる）
  document.querySelectorAll('.editm').forEach(b=>b.onclick=()=>{
    const key=b.dataset.key;
    const arr=key==='subjects'?state.subjects:(key==='materials'?state.materials:state.labels);
    const item=arr.find(x=>x.id===b.dataset.id); if(!item) return;
    const label=key==='subjects'?'教科':(key==='materials'?'教材':'ラベル');
    const rowEl=b.closest('.list-item');
    rowEl.innerHTML=`<div class='col' style='flex:1'>
      <input class='edit-name' value='${attr(item.name||'')}' placeholder='${label}名'/>
      ${key==='materials'?`<select class='edit-subject'>${state.subjects.map(s=>`<option value='${s.id}' ${s.id===item.subjectId?'selected':''}>${escapeHtml(s.name)}</option>`).join('')}</select>`:''}
      <div class='row'><button class='btn small primary save-edit'>保存</button><button class='btn small cancel-edit'>キャンセル</button></div>
    </div>`;
    rowEl.querySelector('.save-edit').onclick=async()=>{
      const name=rowEl.querySelector('.edit-name').value.trim(); if(!name) return alert(`${label}名を入力してください`);
      const patch={name,updatedAt:new Date().toISOString()};
      if(key==='materials') patch.subjectId=rowEl.querySelector('.edit-subject').value;
      await updateDoc(userDoc(key,item.id),patch);
      await refresh(); renderSettings('manage');
    };
    rowEl.querySelector('.cancel-edit').onclick=()=>renderSettings('manage');
  });
  bindSettingsBack();
}
function renderGoals(){ const a=aggregate(); const baseDate=logicalDateStr(); if(!state.calendarMonth) state.calendarMonth = baseDate.slice(0,7); const pct=state.weekGoal?Math.min(100,Math.round(a.week/state.weekGoal*100)):0;
const upcoming=state.tests.filter(t=>t.date>=baseDate);
const g=state.weekGoal||0;
$('#goals').innerHTML=`
<section class='surface'><div class='surface-head'><h2>今週</h2></div>
  ${state.weekGoal?`<div class='meter-row'><span><b>${fmtShort(a.week)}</b> / 目標 ${fmtShort(state.weekGoal)}</span><b>${pct}%</b></div><div class='progress' role='progressbar' aria-valuemin='0' aria-valuemax='100' aria-valuenow='${pct}' aria-label='今週の目標の達成率'><div class='progress-fill' style='width:${pct}%'></div></div>`:`<div class='meter-row'><span><b>${fmtShort(a.week)}</b></span><span>週目標は未設定です</span></div>`}
</section>
${upcoming.length?`<section class='surface'><div class='surface-head'><h2>テストまで</h2></div>${upcoming.map(t=>`<div class='legend-row'><span>${escapeHtml(t.name)}<br><span class='muted'>${fmtMD(t.date)}</span></span><span><b style='font-size:var(--fs-title);color:var(--ink)'>${Math.max(0,Math.ceil((parseDateStr(t.date)-parseDateStr(baseDate))/86400000))}</b> 日</span></div>`).join('')}</section>`:''}
${renderCalendarCard()}
<details class='fold'><summary>週目標・テスト・タスク・期間の設定</summary>
  <section class='surface'><h3 style='margin-bottom:12px'>今週の目標時間</h3><div class='duration'><input id='goalH' type='number' inputmode='numeric' min='0' step='1' value='${g?Math.floor(g/60):''}' placeholder='0' aria-label='時間'/><span>時間</span><input id='goalM' type='number' inputmode='numeric' min='0' max='59' step='1' value='${g?g%60:''}' placeholder='0' aria-label='分'/><span>分</span></div><button id='saveGoal' class='btn primary small' style='margin-top:12px'>保存</button></section>
  <section class='surface'><h3 style='margin-bottom:12px'>テスト</h3><div class='field'><label for='testName'>テスト名</label><input id='testName'/></div><div class='field'><label for='testDate'>日付</label><input id='testDate' type='date'/></div><div class='field'><label for='testMemo'>メモ</label><textarea id='testMemo'></textarea></div><button id='addTest' class='btn small' style='margin-top:12px'>追加</button><div style='margin-top:8px'>${state.tests.map(t=>`<div class='list-item'><span>${escapeHtml(t.name)} <span class='muted'>${t.date}</span></span><button class='link-btn danger deltest' data-id='${t.id}'>削除</button></div>`).join('')}</div></section>
  ${scheduleSettingsHtml()}
</details>`;
bindScheduleSettings();
$('#saveGoal').onclick=async()=>{const weekStartDate=mondayOf(logicalNow()); const targetMinutes=Math.max(0,Math.floor(+$('#goalH').value||0))*60+Math.max(0,Math.floor(+$('#goalM').value||0)); const g=(await getDocs(query(userCol('weeklyGoals')))).docs.map(d=>({id:d.id,...d.data()})).find(x=>x.weekStartDate===weekStartDate); if(g) await updateDoc(userDoc('weeklyGoals',g.id),{targetMinutes,updatedAt:new Date().toISOString()}); else await addDoc(userCol('weeklyGoals'),{weekStartDate,targetMinutes,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); await refresh();};
$('#addTest').onclick=async()=>{const name=$('#testName').value.trim(), date=$('#testDate').value; if(!name||!normalizeDateInput(date)) return alert('テスト名と日付を入力してください。'); await addDoc(userCol('tests'),{name,date,memo:$('#testMemo').value,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); await refresh();};
document.querySelectorAll('.deltest').forEach(b=>b.onclick=async()=>{await deleteDoc(userDoc('tests',b.dataset.id)); await refresh();});
$('#calPrev').onclick=()=>{const [y,m]=state.calendarMonth.split('-').map(Number); const d=new Date(y,m-2,1); state.calendarMonth=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; renderGoals();};
$('#calNext').onclick=()=>{const [y,m]=state.calendarMonth.split('-').map(Number); const d=new Date(y,m,1); state.calendarMonth=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; renderGoals();};
$('#calToday').onclick=()=>{state.calendarMonth=logicalDateStr().slice(0,7); state.selectedDate=null; renderGoals();};
document.querySelectorAll('.cal-cell[data-date]').forEach(c=>c.onclick=()=>{state.selectedDate=c.dataset.date; renderGoals();});
}
function renderCalendarCard(){
  const [y,m]=state.calendarMonth.split('-').map(Number); const first=new Date(y,m-1,1); const startDay=first.getDay(); const days=new Date(y,m,0).getDate();
  const dayMap={}; state.records.forEach(r=>{if(!r.date?.startsWith(state.calendarMonth)) return; dayMap[r.date]=(dayMap[r.date]||{minutes:0,focus:0,records:[]}); dayMap[r.date].minutes+=(+r.minutes||0); dayMap[r.date].focus+=focusMinutes(r); dayMap[r.date].records.push(r);});
  const studiedDays=Object.keys(dayMap).length; const monthMinutes=Object.values(dayMap).reduce((s,v)=>s+v.minutes,0); const monthFocus=Object.values(dayMap).reduce((s,v)=>s+v.focus,0);
  const cells=[]; for(let i=0;i<startDay;i++) cells.push(`<div class='cal-cell empty'></div>`); for(let d=1;d<=days;d++){const date=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`; const info=dayMap[date]; const min=info?.minutes||0; const lv=min>=120?4:min>=60?3:min>=30?2:min>=1?1:0; const marker=''; const inPeriod=!!findActivePeriod(date); cells.push(`<button type='button' aria-label='${m}月${d}日 ${fmtShort(min)}' class='cal-cell studied-${lv} ${date===logicalDateStr()?'today':''} ${info?'studied':''} ${inPeriod?'in-period':''} ${date===state.selectedDate?'selected':''}' data-date='${date}'><span>${d}</span><small>${marker}</small></button>`);}
  const [cy,cm]=state.calendarMonth.split('-').map(Number);
  return `<section class='surface'><div class='cal-nav'><button type='button' class='cal-nav-btn' id='calPrev' aria-label='前の月'>${ICON_BACK}</button><button type='button' class='cal-nav-label' id='calToday' aria-label='今月に戻る'>${cy}年${cm}月</button><button type='button' class='cal-nav-btn' id='calNext' aria-label='次の月'>${ICON_CHEV.replace("class='ico chev'","class='ico'")}</button></div><div class='cal-week'>${WEEKDAYS.map(v=>`<div>${v}</div>`).join('')}</div><div class='cal-grid'>${cells.join('')}</div><div class='cal-legend'><span>学習日数 <b>${studiedDays}日</b></span><span>合計 <b>${fmtShort(monthMinutes)}</b></span><span>集中 <b>${fmtShort(monthFocus)}</b></span>${state.schedulePeriods?.length?`<span><span class='in-period-dot'></span>期間中</span>`:''}</div><div id='calDayRecords'>${renderCalendarDayRecords(dayMap[state.selectedDate], state.selectedDate)}${renderCalendarDayTasks(state.selectedDate)}</div></section>`;
}

function renderCalendarDayRecords(dayInfo,date){
  if(!date) return '';
  if(!dayInfo) return `<h4>${fmtMD(date)}</h4><div class='muted'>学習記録はありません</div>`;
  return `<h4>${fmtMD(date)}</h4><div class='muted tabnum' style='margin-bottom:4px'>合計 ${fmtShort(dayInfo.minutes)}　集中 ${fmtShort(dayInfo.focus)}</div>${dayInfo.records.map(r=>`<div class='list-item'><span>${escapeHtml(subjectName(r.subjectId))} <span class='muted'>${escapeHtml(materialName(r.materialId)||'教材未選択')}</span>${r.memo?`<br><span class='muted'>${escapeHtml(r.memo)}</span>`:''}</span><span class='tabnum'>${r.minutes}分 <span class='muted'>質${escapeHtml(r.quality)}</span></span></div>`).join('')}`;
}
function renderCalendarDayTasks(date){
  if(!date || !state.schedule?.startDate || date<state.schedule.startDate) return '';
  const d=getScheduleDay(date);
  const tasks=d?d.tasks:effectiveTasksFor(date);
  if(!tasks.length) return '';
  const done=d?(d.done||{}):{};
  return `<h4 style='margin-top:16px'>タスク <span class='muted'>${tasks.filter(t=>done[t.id]).length}/${tasks.length}</span></h4>${tasks.map(t=>`<div class='legend-row'><span>${escapeHtml(t.text)}</span><span>${done[t.id]?'完了':'未完了'}</span></div>`).join('')}`;
}

// ---- スケジュール（通年ベース + 季節ごとの期間上書き） ----
function scheduleDayDoc(date){ return doc(db, `users/${state.uid}/scheduleDays/${date}`); }
function getScheduleDay(date){ return state.scheduleDays.find(d=>d.id===date); }
function addDays(dateStr,n){ const d=parseDateStr(dateStr); d.setDate(d.getDate()+n); return toDateStr(d); }
function findActivePeriod(date){ return (state.schedulePeriods||[]).find(p=>date>=p.startDate && date<=p.endDate); }
function effectiveTasksFor(date){ const p=findActivePeriod(date); const base=state.schedule.defaultTasks||[]; return p ? [...base, ...(p.tasks||[])] : base; }
const dailyMinutesFor = date => state.records.filter(r=>r.date===date).reduce((s,r)=>s+(+r.minutes||0),0);
function isDayComplete(d){
  if(!d || !d.tasks || d.tasks.length===0 || !d.tasks.every(t=>d.done?.[t.id])) return false;
  if(dailyMinutesFor(d.date)>=20) return true;
  return dailyMinutesFor(addDays(d.date,1))>=60; // 当日20分に満たなくても、翌日に1時間以上学習していれば繰り越し完了分として達成扱いにする
}
function tasksListEqual(a,b){ return a.length===b.length && a.every((t,i)=>b[i] && b[i].id===t.id && b[i].text===t.text); }
function computeCarryoverIds(date){
  const yesterday=addDays(date,-1);
  if(!state.schedule.startDate || yesterday<state.schedule.startDate) return [];
  const yd=getScheduleDay(yesterday);
  const tasks=yd?yd.tasks:effectiveTasksFor(yesterday);
  const done=yd?(yd.done||{}):{};
  return tasks.filter(t=>!done[t.id]).map(t=>t.id);
}
async function ensureScheduleDay(date){
  const existing=getScheduleDay(date);
  const isToday=date===logicalDateStr();
  if(existing){
    const eff=effectiveTasksFor(date);
    const patch={};
    if(isToday){
      // 今日の分は、タスク一覧の追加・削除・変更をその日のスナップショットにも常に反映する（過去日は履歴として固定のまま変更しない）
      if(!tasksListEqual(existing.tasks||[], eff)){
        const prevDone=existing.done||{};
        existing.tasks=eff.map(t=>({...t}));
        existing.done=Object.fromEntries(eff.filter(t=>prevDone[t.id]).map(t=>[t.id,true]));
        patch.tasks=existing.tasks; patch.done=existing.done;
      }
      // 繰り越し表示の対象は今日の間固定する（完了しても日が変わるまで一覧に残す）
      if(existing.carryoverIds===undefined){
        existing.carryoverIds=computeCarryoverIds(date);
        patch.carryoverIds=existing.carryoverIds;
      }
    } else if((existing.tasks||[]).length===0 && eff.length>0){
      // 空のままスナップショットされた過去日（期間作成直後など）は、タスクが後から登録されたら反映する
      existing.tasks=eff.map(t=>({...t}));
      patch.tasks=existing.tasks;
    }
    if(Object.keys(patch).length) await setDoc(scheduleDayDoc(date), {...patch, updatedAt:new Date().toISOString()}, {merge:true});
    return existing;
  }
  if(!state.schedule.startDate || date<state.schedule.startDate) return null;
  const data={ date, tasks: effectiveTasksFor(date), done:{}, carryoverIds: isToday?computeCarryoverIds(date):[], createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
  await setDoc(scheduleDayDoc(date), data);
  const entry={id:date,...data}; state.scheduleDays.push(entry); return entry;
}
async function toggleScheduleTask(date,taskId){
  const d=await ensureScheduleDay(date); if(!d) return;
  const done={...(d.done||{}), [taskId]: !d.done?.[taskId]};
  d.done=done; // ローカル状態を即時反映してからバックエンドに書き込む
  await setDoc(scheduleDayDoc(date), {...d,done,updatedAt:new Date().toISOString()}, {merge:true});
}
function scheduleCarryover(){
  const today=logicalDateStr(); const yesterday=addDays(today,-1);
  if(!state.schedule.startDate || yesterday<state.schedule.startDate) return [];
  const yd=getScheduleDay(yesterday);
  const tasks=yd?yd.tasks:effectiveTasksFor(yesterday);
  const done=yd?(yd.done||{}):{};
  const td=getScheduleDay(today);
  const ids=td?.carryoverIds ?? tasks.filter(t=>!done[t.id]).map(t=>t.id); // 今日の分がまだ無ければその場で計算
  return tasks.filter(t=>ids.includes(t.id)).map(t=>({...t,date:yesterday,done:!!done[t.id]}));
}
function computeScheduleStreak(){
  const {startDate}=state.schedule||{};
  if(!startDate) return { current:0, broken:null };
  const today=logicalDateStr();
  const dates=[]; for(let d=startDate; d<=today; d=addDays(d,1)) dates.push(d);
  const judged=dates.filter(dt=> dt<today || (dt===today && isDayComplete(getScheduleDay(today))));
  let running=0, lastBreakLen=0, brokenOn=null;
  judged.forEach(dt=>{
    if(isDayComplete(getScheduleDay(dt))) running++;
    else { if(running>0){ lastBreakLen=running; brokenOn=dt; } running=0; }
  });
  return { current:running, broken:(running===0 && lastBreakLen>0)?{length:lastBreakLen,date:brokenOn}:null };
}
function tasksCardHtml(){
  if(!state.schedule?.startDate) return '';
  const today=logicalDateStr();
  const carry=scheduleCarryover();
  const d=getScheduleDay(today);
  const tasks=d?d.tasks:effectiveTasksFor(today);
  const done=d?(d.done||{}):{};
  const doneCount=tasks.filter(t=>done[t.id]).length;
  const activePeriod=findActivePeriod(today);
  const emptyMsg=activePeriod
    ?`「${escapeHtml(activePeriod.name)}」期間のタスクはまだありません。目標タブの設定から追加できます。`
    :'タスクはまだありません。目標タブの設定から追加できます。';
  const carryRows=carry.map(t=>`<label class='list-item carry-item'><input type='checkbox' class='schCarryCheck' data-date='${t.date}' data-id='${t.id}' ${t.done?'checked':''}/><span>${escapeHtml(t.text)}</span><span class='tag'>${fmtMD(t.date).replace(/\(.\)$/,'')}の分</span></label>`).join('');
  const todayRows=tasks.map(t=>`<label class='list-item'><input type='checkbox' class='schTaskCheck' data-date='${today}' data-id='${t.id}' ${done[t.id]?'checked':''}/><span>${escapeHtml(t.text)}</span></label>`).join('');
  return `<section class='surface'>
    <div class='surface-head'><h2>今日のタスク</h2><span class='muted tabnum'>${tasks.length?`${doneCount}/${tasks.length}`:''}</span></div>
    ${activePeriod||carry.length?`<div class='muted' style='margin:-8px 0 4px'>${activePeriod?`${escapeHtml(activePeriod.name)}の期間中`:''}${activePeriod&&carry.length?'　':''}${carry.length?`前日からの繰り越し ${carry.length}件`:''}</div>`:''}
    ${carryRows}
    ${tasks.length===0?`<div class='muted' style='padding:8px 0'>${emptyMsg}</div>`:todayRows}
  </section>`;
}
function taskMemoHtml(){
  return `<section class='surface'><div class='surface-head'><h2 id='memoTitle'>メモ</h2><button id='saveTaskMemo' class='link-btn'>保存</button></div><textarea id='taskMemoInput' aria-labelledby='memoTitle'>${escapeHtml(state.taskMemo||'')}</textarea></section>`;
}
function bindTaskMemo(){
  $('#saveTaskMemo').onclick=async()=>{
    const taskMemo=$('#taskMemoInput').value;
    await setDoc(doc(db,`users/${state.uid}/settings/main`),{taskMemo},{merge:true});
    state.taskMemo=taskMemo;
    const b=$('#saveTaskMemo'); if(b){ b.textContent='保存しました'; setTimeout(()=>{ if($('#saveTaskMemo')) $('#saveTaskMemo').textContent='保存'; },1600); }
  };
}
function bindScheduleChecks(){
  document.querySelectorAll('.schTaskCheck,.schCarryCheck').forEach(cb=>cb.onchange=async()=>{
    try{
      await toggleScheduleTask(cb.dataset.date, cb.dataset.id);
    }catch(err){
      console.error(err);
      alert('保存に失敗しました。通信環境をご確認のうえ、もう一度お試しください。');
    }
    renderDashboard(); // 全データの再取得はせず、更新済みのローカル状態から即座に再描画
  });
}
function periodManagerHtml(p){
  return `<section class='surface'>
    <div class='surface-head'><h3>${escapeHtml(p.name)} <span class='muted'>${fmtMD(p.startDate)}〜${fmtMD(p.endDate)}</span></h3><button class='link-btn danger delPeriod' data-id='${p.id}'>期間を削除</button></div>
    <div class='row'><input id='pNewTask-${p.id}' placeholder='タスク名' aria-label='${attr(p.name)}のタスク名'/><button class='btn small addPeriodTask' data-id='${p.id}'>追加</button></div>
    <div style='margin-top:8px'>${(p.tasks||[]).map(t=>`<div class='list-item'><span>${escapeHtml(t.text)}</span><button class='link-btn danger delPeriodTask' data-pid='${p.id}' data-id='${t.id}'>削除</button></div>`).join('')||'<div class="muted">タスクはまだありません</div>'}</div>
  </section>`;
}
function scheduleSettingsHtml(){
  const {startDate=''}=state.schedule||{};
  const defaultTasks=state.schedule?.defaultTasks||[];
  const periods=state.schedulePeriods||[];
  return `
    <section class='surface'>
      <h3 id='schStartTitle' style='margin-bottom:12px'>タスクの記録開始日</h3>
      <input id='schStart' aria-labelledby='schStartTitle' type='date' value='${startDate}'/>
      ${startDate?'':'<p class="small" style="margin:8px 0 0">開始日を設定すると、ホームに今日のタスクが表示されます。</p>'}
      <button id='schSaveStart' class='btn primary small' style='margin-top:12px'>開始日を保存</button>
    </section>
    <section class='surface'>
      <h3 style='margin-bottom:12px'>毎日のタスク</h3>
      <div class='row'><input id='schNewTask' placeholder='例: 単語100個' aria-label='毎日のタスク名'/><button id='schAddTask' class='btn small'>追加</button></div>
      ${defaultTasks.length===0?`<button id='schUseTemplate' class='btn small' style='margin-top:8px'>例のタスクを入れる</button>`:''}
      <div style='margin-top:8px'>${defaultTasks.map(t=>`<div class='list-item'><span>${escapeHtml(t.text)}</span><button class='link-btn danger delSchTask' data-id='${t.id}'>削除</button></div>`).join('')||'<div class="muted">タスクはまだありません</div>'}</div>
    </section>
    <section class='surface'>
      <h3 style='margin-bottom:4px'>期間</h3>
      <p class='small' style='margin:0 0 12px'>期間中は、毎日のタスクにその期間だけのタスクが加わります。</p>
      <div class='field'><label for='pName'>期間名</label><input id='pName' placeholder='例: 夏休み'/></div>
      <div class='row-2' style='margin-top:16px'><div><label for='pStart'>開始日</label><input id='pStart' type='date'/></div><div><label for='pEnd'>終了日</label><input id='pEnd' type='date'/></div></div>
      <button id='addPeriod' class='btn small' style='margin-top:12px'>期間を追加</button>
    </section>
    ${periods.map(periodManagerHtml).join('')}`;
}
function bindScheduleSettings(){
  const periods=state.schedulePeriods||[];
  $('#schSaveStart').onclick=async()=>{
    const s=$('#schStart').value; if(!s) return alert('開始日を選択してください。');
    await setDoc(doc(db,`users/${state.uid}/settings/schedule`), {...state.schedule,startDate:s,updatedAt:new Date().toISOString()}, {merge:true});
    await refresh();
  };
  $('#schAddTask').onclick=async()=>{
    const text=$('#schNewTask').value.trim(); if(!text) return;
    const newTasks=[...(state.schedule.defaultTasks||[]), {id:'t'+Date.now()+Math.random().toString(36).slice(2,6), text}];
    await setDoc(doc(db,`users/${state.uid}/settings/schedule`), {...state.schedule,defaultTasks:newTasks,updatedAt:new Date().toISOString()}, {merge:true});
    await refresh();
  };
  if($('#schUseTemplate')) $('#schUseTemplate').onclick=async()=>{
    await setDoc(doc(db,`users/${state.uid}/settings/schedule`), {...state.schedule,defaultTasks:DEFAULT_SCHEDULE_TASKS.map(t=>({...t})),updatedAt:new Date().toISOString()}, {merge:true});
    await refresh();
  };
  document.querySelectorAll('.delSchTask').forEach(b=>b.onclick=async()=>{
    const newTasks=(state.schedule.defaultTasks||[]).filter(t=>t.id!==b.dataset.id);
    await setDoc(doc(db,`users/${state.uid}/settings/schedule`), {...state.schedule,defaultTasks:newTasks,updatedAt:new Date().toISOString()}, {merge:true});
    await refresh();
  });
  $('#addPeriod').onclick=async()=>{
    const name=$('#pName').value.trim(), s=$('#pStart').value, e=$('#pEnd').value;
    if(!name||!s||!e||s>e) return alert('期間名・開始日・終了日を正しく入力してください。');
    await addDoc(userCol('schedulePeriods'), { name, startDate:s, endDate:e, tasks:[], order:periods.length, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
    await refresh();
  };
  document.querySelectorAll('.delPeriod').forEach(b=>b.onclick=async()=>{
    if(!confirm('この期間を削除しますか？')) return;
    await deleteDoc(userDoc('schedulePeriods', b.dataset.id)); await refresh();
  });
  document.querySelectorAll('.addPeriodTask').forEach(b=>b.onclick=async()=>{
    const pid=b.dataset.id; const input=$(`#pNewTask-${pid}`); const text=input.value.trim(); if(!text) return;
    const p=periods.find(x=>x.id===pid); const newTasks=[...(p.tasks||[]), {id:'t'+Date.now()+Math.random().toString(36).slice(2,6), text}];
    await updateDoc(userDoc('schedulePeriods',pid), {tasks:newTasks,updatedAt:new Date().toISOString()});
    await refresh();
  });
  document.querySelectorAll('.delPeriodTask').forEach(b=>b.onclick=async()=>{
    const p=periods.find(x=>x.id===b.dataset.pid); const newTasks=(p.tasks||[]).filter(t=>t.id!==b.dataset.id);
    await updateDoc(userDoc('schedulePeriods',b.dataset.pid), {tasks:newTasks,updatedAt:new Date().toISOString()});
    await refresh();
  });
}
function formatNowDateTime(){
  const now=new Date();
  const weekday=['日','月','火','水','木','金','土'][now.getDay()];
  return `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日(${weekday}) ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
}
let clockInterval=null;
function startDashboardClock(){
  if(clockInterval) clearInterval(clockInterval);
  clockInterval=setInterval(()=>{
    const el=$('#nowClock');
    if(!el){ clearInterval(clockInterval); clockInterval=null; return; }
    el.textContent=formatNowDateTime();
  }, 15000);
}
function streakHtml(){
  if(!state.schedule?.startDate) return '';
  const s=computeScheduleStreak();
  return `<div class='hero-streak ${s.current>0?'':'zero'}'><div class='hero-label'>連続</div><div class='hero-streak-value'>${s.current}<span class='unit'>日</span></div></div>`;
}
function streakBrokenHtml(){
  if(!state.schedule?.startDate) return '';
  const s=computeScheduleStreak();
  return s.broken?`<div class='streak-broken'>${fmtMD(s.broken.date)}に ${s.broken.length}日の連続が途切れました</div>`:'';
}

// ---- 通知（アプリを開いた時に「今日のタスク」をローカル通知） ----
function notifyTimeStr(){
  const v=localStorage.getItem(NOTIFY_HOUR_KEY);
  if(!v) return '07:00';
  return /^\d{1,2}$/.test(v) ? `${v.padStart(2,'0')}:00` : v; // 旧「時のみ」設定からの移行
}
async function maybeNotifyToday(){
  if(!state.uid || !('Notification' in window) || Notification.permission!=='granted') return;
  if(!('serviceWorker' in navigator)) return;
  const today=logicalDateStr();
  const key=`sdl_last_notified_${state.uid}`;
  if(localStorage.getItem(key)===today) return;
  const nowMinutes = new Date().getHours()*60 + new Date().getMinutes();
  if(nowMinutes < minFromTime(notifyTimeStr())) return;
  let body='今日も学習を記録しましょう。';
  if(state.schedule?.startDate && today>=state.schedule.startDate){
    const d=getScheduleDay(today);
    const tasks=d?d.tasks:effectiveTasksFor(today);
    const done=d?(d.done||{}):{};
    const remaining=tasks.filter(t=>!done[t.id]);
    if(tasks.length) body=remaining.length?`未完了: ${remaining.map(t=>t.text).join(' / ')}`:'今日のタスクは完了済みです！';
  }
  try{
    const reg=await navigator.serviceWorker.ready;
    await reg.showNotification('今日のタスク', { body, tag:'sdl-daily' });
    localStorage.setItem(key, today);
  }catch(_){ /* 通知非対応環境では無視 */ }
}

// ---- プッシュ通知（FCM, アプリを閉じていても届く。VAPIDキー設定 + Cloud Functionsデプロイが必要） ----
function fcmTokenDocRef(token){ return userDoc('fcmTokens', token); }
function getMessagingSafe(){
  if (messaging) return messaging;
  try {
    messaging = getMessaging(app);
    onMessage(messaging, (payload) => {
      const title = payload?.notification?.title || '通知';
      const body = payload?.notification?.body || '';
      if (swReg) swReg.showNotification(title, { body, tag: 'sdl-push' });
      else if (Notification.permission === 'granted') new Notification(title, { body });
    });
  } catch (_) { messaging = null; }
  return messaging;
}
function refreshPushStatus(){
  const el = $('#pushStatus'); if (!el) return;
  if (!FCM_VAPID_KEY) { el.textContent = 'VAPIDキー未設定'; return; }
  if (!('Notification' in window) || Notification.permission !== 'granted') { el.textContent = '通知未許可'; return; }
  el.textContent = currentFcmToken ? '登録済み' : '未登録';
}
async function registerPush(){
  if (!FCM_VAPID_KEY) return alert('VAPIDキーが未設定です。Firebase Console > プロジェクトの設定 > Cloud Messaging でウェブプッシュ証明書を生成し、app.js の FCM_VAPID_KEY に設定してください。');
  if (!('Notification' in window)) return alert('この端末・ブラウザは通知に対応していません。');
  if (!swReg) return alert('Service Workerの準備ができていません。少し待ってから再度お試しください。');
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if ($('#notifyStatus')) $('#notifyStatus').textContent = perm;
  if (perm !== 'granted') return alert('通知が許可されませんでした。');
  const m = getMessagingSafe();
  if (!m) return alert('この端末・ブラウザはプッシュ通知(FCM)に対応していません。');
  try {
    const token = await getToken(m, { vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: swReg });
    if (!token) return alert('トークンの取得に失敗しました。');
    currentFcmToken = token;
    await setDoc(fcmTokenDocRef(token), { createdAt: new Date().toISOString(), userAgent: navigator.userAgent }, { merge: true });
    refreshPushStatus();
    alert('プッシュ通知を登録しました');
  } catch (err) { console.error('FCM getToken failed:', err); alert(`登録に失敗しました: ${err.message || err}`); }
}
async function unregisterPush(){
  if (!currentFcmToken) return alert('登録済みのトークンがありません。');
  try { await deleteDoc(fcmTokenDocRef(currentFcmToken)); } catch (err) { console.error('token doc delete failed:', err); }
  const m = getMessagingSafe();
  try { if (m) await deleteToken(m); } catch (_) { /* ignore */ }
  currentFcmToken = null;
  refreshPushStatus();
  alert('登録を解除しました');
}
async function sendTestPush(){
  try {
    const fn = httpsCallable(functions, 'sendTestPush');
    const res = await fn();
    alert(`送信結果: 成功${res.data.successCount}件 / 失敗${res.data.failureCount}件`);
  } catch (err) { console.error('sendTestPush failed:', err); alert(`送信に失敗しました: ${err.message || err}`); }
}

function settingsBackHtml(title){ return `<button type='button' class='back-btn' id='backSettings'>${ICON_BACK}設定</button><h2 style='margin:0 4px 16px'>${title}</h2>`; }
function bindSettingsBack(){ const b=$('#backSettings'); if(b) b.onclick=()=>renderSettings('menu'); }
function notifyPermissionLabel(){
  if(!('Notification' in window)) return '非対応';
  return {granted:'許可済み',denied:'拒否',default:'未設定'}[Notification.permission]||Notification.permission;
}
function menuRow(id,label,value=''){ return `<button class='menu-row' id='${id}'><span>${label}</span>${value?`<span class='value'>${value}</span>`:''}${ICON_CHEV}</button>`; }
function renderSettings(mode=state.settingsMode||'menu'){
  state.settingsMode=mode;
  const el=$('#settings');
  if(mode==='manage'){ el.innerHTML=renderManageHtml(); bindManager(); return; }
  if(mode==='quality'){
    el.innerHTML=`${settingsBackHtml('質係数')}
    <section class='surface'><div class='quality-grid'>${['S','A','B','C','D'].map(k=>`<div class='list-item'><label for='q-${k}'>${k}</label><input id='q-${k}' type='number' inputmode='decimal' step='0.01' value='${state.quality[k]}'/></div>`).join('')}</div></section>
    <p class='small' style='margin:-8px 4px 16px'>集中時間 = 学習時間 × 係数</p>
    <button id='saveQ' class='btn primary block'>保存</button>`;
    bindSettingsBack();
    $('#saveQ').onclick=async()=>{const quality={}; ['S','A','B','C','D'].forEach(k=>quality[k]=+($(`#q-${k}`).value||1)); await setDoc(doc(db,`users/${state.uid}/settings/main`),{quality,appName:APP_NAME},{merge:true}); await refresh();};
    return;
  }
  if(mode==='backup'){
    el.innerHTML=`${settingsBackHtml('バックアップ')}
    <section class='surface stack'><h3>書き出し</h3><button id='exp' class='btn'>JSONを書き出す</button></section>
    <section class='surface stack'><h3>読み込み</h3><input id='impFile' type='file' accept='application/json' aria-label='読み込むJSONファイル'/><button id='imp' class='btn'>JSONを読み込む</button><p class='small' style='margin:0'>今のデータに追加されます。同じファイルを2回読み込むと記録が重複します。</p></section>
    <section class='surface stack'><h3>全データの削除</h3><p class='small' style='margin:0'>教科・教材・ラベル・学習記録・テスト・週目標をすべて削除します。元に戻せません。</p><button id='wipe' class='btn danger'>全データを削除</button></section>`;
    bindSettingsBack();
    return;
  }
  if(mode==='notify'){
    el.innerHTML=`${settingsBackHtml('通知')}
    <div class='group-title'>アプリを開いたとき</div>
    <section class='surface'>
      <div class='list-item'><span>許可状態</span><b id='notifyStatus' class='muted'></b></div>
      <div class='list-item'><label for='notifyHourInput' style='margin:0;color:var(--ink);font-size:var(--fs-body);font-weight:400'>通知する時刻</label><input id='notifyHourInput' type='time' value='${notifyTimeStr()}' style='width:auto'/></div>
      <div class='row' style='margin-top:8px'><button id='notifyEnable' class='btn primary small'>通知を許可</button><button id='notifySave' class='btn small'>時刻を保存</button></div>
    </section>
    <p class='small' style='margin:-8px 4px 16px'>設定した時刻を過ぎてからアプリを開くと、今日のタスクを通知します。アプリを閉じている間は届きません。</p>
    <div class='group-title'>プッシュ通知</div>
    <section class='surface'>
      <div class='list-item'><span>登録状態</span><b id='pushStatus' class='muted'></b></div>
      <div class='row' style='margin-top:8px'><button id='pushRegister' class='btn small'>登録</button><button id='pushTest' class='btn small'>テスト送信</button><button id='pushUnregister' class='btn danger small'>登録を解除</button></div>
    </section>
    <p class='small' style='margin:-8px 4px 16px'>アプリを閉じていても届く通知です。サーバー側の準備が必要です。</p>`;
    bindSettingsBack();
    $('#notifyStatus').textContent=notifyPermissionLabel();
    $('#notifyEnable').onclick=async()=>{ if(!('Notification' in window)) return alert('この端末・ブラウザは通知に対応していません。'); await Notification.requestPermission(); $('#notifyStatus').textContent=notifyPermissionLabel(); };
    $('#notifySave').onclick=()=>{ try{ localStorage.setItem(NOTIFY_HOUR_KEY, $('#notifyHourInput').value||'07:00'); alert('時刻を保存しました'); }catch(_){ alert('この端末では保存できませんでした。'); } };
    refreshPushStatus();
    $('#pushRegister').onclick=registerPush;
    $('#pushTest').onclick=sendTestPush;
    $('#pushUnregister').onclick=unregisterPush;
    return;
  }
  if(mode==='about'){
    el.innerHTML=`${settingsBackHtml('データの保存先')}
    <section class='surface'><p style='margin:0;font-size:var(--fs-cap);line-height:1.8'>このアプリは、ログインした利用者の学習記録をFirebase Cloud Firestoreに保存し、PCとiPhoneなど複数端末で同期します。学習記録、教材名、メモなどのデータは、ログインした本人のデータとして保存されます。Firestore Security Rulesにより、各ユーザーは自分のデータのみ読み書きできる設計にしてください。なお、端末やブラウザ上にもPWAのキャッシュや一時データが保存される場合があります。必要に応じてJSONエクスポート機能でバックアップしてください。</p></section>`;
    bindSettingsBack();
    return;
  }
  const q=state.quality||{};
  el.innerHTML=`
  <section class='surface menu'><div class='menu-row menu-static'><span>${escapeHtml(state.userName||state.userEmail||'不明')}</span>${state.userName&&state.userEmail?`<span class='muted'>${escapeHtml(state.userEmail)}</span>`:''}</div></section>
  <div class='group-title'>データ</div>
  <section class='surface menu'>${menuRow('openManage','教科・教材・ラベル',`${state.subjects.length}教科`)}${menuRow('openBackup','バックアップ')}</section>
  <div class='group-title'>記録</div>
  <section class='surface menu'>${menuRow('openQuality','質係数',['S','A','B','C','D'].map(k=>`${k} ${q[k]}`).join('  '))}</section>
  <div class='group-title'>通知</div>
  <section class='surface menu'>${menuRow('openNotify','通知',notifyPermissionLabel())}</section>
  <div class='group-title'>このアプリについて</div>
  <section class='surface menu'>${menuRow('openAbout','データの保存先')}</section>
  <section class='surface menu' style='margin-top:24px'><button id='settingsLogout' class='menu-row danger'>ログアウト</button></section>`;
  $('#openManage').onclick=()=>renderSettings('manage');
  $('#openBackup').onclick=()=>renderSettings('backup');
  $('#openQuality').onclick=()=>renderSettings('quality');
  $('#openNotify').onclick=()=>renderSettings('notify');
  $('#openAbout').onclick=()=>renderSettings('about');
  $('#settingsLogout').onclick=()=>signOut(auth);
  bindSettingsPanelActions();
}

let settingsPanelActionsBound = false;
function bindSettingsPanelActions(){
  if(settingsPanelActionsBound) return;
  settingsPanelActionsBound = true;
  document.addEventListener('click', async(e)=>{
    if(e.target?.id==='exp'){
      const data={subjects:state.subjects,materials:state.materials,labels:state.labels,studyRecords:state.records,tests:state.tests,settings:{quality:state.quality}};
      const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
      const a=document.createElement('a');
      a.href=URL.createObjectURL(blob);
      a.download=`study-density-backup-${todayStr()}.json`;
      a.click();
    }
    if(e.target?.id==='imp'){
      const f=$('#impFile').files[0]; if(!f) return;
      const j=JSON.parse(await f.text());
      // 教科・教材・ラベルはaddDocで新しいIDが割り振られるため、学習記録側の参照IDを新旧マッピングで付け替える
      const idMap={subjects:{},materials:{},labels:{}};
      for(const key of ['subjects','materials','labels']){
        for(const item of (j[key]||[])){
          const {id:oldId,...rest}=item;
          const ref=await addDoc(userCol(key),rest);
          if(oldId) idMap[key][oldId]=ref.id;
        }
      }
      for(const item of (j.studyRecords||[])){
        const {id:oldId,...rest}=item;
        if(rest.subjectId) rest.subjectId=idMap.subjects[rest.subjectId]||rest.subjectId;
        if(rest.materialId) rest.materialId=idMap.materials[rest.materialId]||rest.materialId;
        if(Array.isArray(rest.labelIds)) rest.labelIds=rest.labelIds.map(lid=>idMap.labels[lid]||lid);
        await addDoc(userCol('studyRecords'),rest);
      }
      for(const item of (j.tests||[])){
        const {id:oldId,...rest}=item;
        await addDoc(userCol('tests'),rest);
      }
      if(j.settings?.quality) await setDoc(doc(db,`users/${state.uid}/settings/main`),{quality:j.settings.quality},{merge:true});
      await refresh();
    }
    if(e.target?.id==='wipe'){
      if(!confirm('全削除します')) return;
      for(const key of ['subjects','materials','labels','studyRecords','tests','weeklyGoals']){
        const docs=(await getDocs(userCol(key))).docs;
        for(const d of docs) await deleteDoc(d.ref);
      }
      await refresh();
    }
  });
}

function switchScreen(id){ setTitle(SCREEN_TITLES[id]||APP_NAME); if(!$('#'+id).classList.contains('active')) window.scrollTo(0,0); document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===id)); document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.screen===id)); if(id==='record') renderRecordForm(); if(id==='list') renderList(); if(id==='goals') renderGoals(); if(id==='settings') renderSettings(); if(id==='dashboard') renderDashboard(); }
async function refresh(){
  await loadAll();
  const today=logicalDateStr();
  if(state.schedule?.startDate && today>=state.schedule.startDate) await ensureScheduleDay(today); // タスク編集直後でも、表示中の画面に関わらず今日の分を再同期する
  ['dashboard','record','list','goals','settings'].forEach(id=>{ if($('#'+id).classList.contains('active')) switchScreen(id); });
  maybeNotifyToday();
}

$('#appTitle').textContent = APP_NAME;
let loginInFlight=false;
$('#loginBtn').onclick=async()=>{
  if(loginInFlight) return; // 連打でsignInWithPopupが二重発火しauth/cancelled-popup-requestになるのを防ぐ
  loginInFlight=true;
  $('#loginBtn').disabled=true;
  try {
    const result = await signInWithPopup(auth,new GoogleAuthProvider());
    console.log('Login success:', result.user?.email);
  } catch (error) {
    console.error('Login failed:', error.code, error.message);
    if(error.code!=='auth/cancelled-popup-request') alert(`ログイン失敗: ${error.code} / ${error.message}`);
  } finally {
    loginInFlight=false;
    $('#loginBtn').disabled=false;
  }
};
document.querySelectorAll('.bottom-nav button').forEach(b=>b.onclick=()=>{ if(b.dataset.screen==='settings') state.settingsMode='menu'; switchScreen(b.dataset.screen); });
bindSettingsPanelActions();
let lastAuthUid; // 直前に処理したuid。トークン更新等で同一ユーザーのまま再発火した際の二重refreshを防ぐ
onAuthStateChanged(auth, async user=>{
  console.log('Auth state:', user ? `logged in (${user.email || user.uid})` : 'null (logged out)');
  if(!user){ lastAuthUid=null; state.uid=null; state.userName=''; state.userEmail=''; $('#app').hidden=true; $('#bottomNav').hidden=true; $('#signedOut').hidden=false; $('#appTitle').textContent=APP_NAME; return; }
  state.userName=user.displayName||''; state.userEmail=user.email||'';
  if(lastAuthUid===user.uid) return; // 同一ユーザーの再発火時はプロフィール情報のみ更新し、再読み込みはしない
  lastAuthUid=user.uid;
  state.uid=user.uid; $('#app').hidden=false; $('#bottomNav').hidden=false; $('#signedOut').hidden=true;
  try {
    await withTimeout(ensureSeedData());
    await withTimeout(refresh());
    switchScreen('dashboard');
    sessionStorage.removeItem('sdl_auto_reload_attempted');
  } catch(err) {
    // iOSでバックグラウンドから復帰した直後など、Firestoreへの通信が固まったまま応答が返らないことがある。
    // 一度だけ自動リロードして復旧を試みる（無限リロードループ防止のためsessionStorageで1回のみに制限）
    console.error('初期読み込みがタイムアウトまたは失敗しました:', err);
    if(!sessionStorage.getItem('sdl_auto_reload_attempted')){
      sessionStorage.setItem('sdl_auto_reload_attempted', '1');
      location.reload();
    } else {
      console.error('再読み込み後も読み込みに失敗しました。通信環境をご確認ください。');
    }
  }
});
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible' && state.uid) maybeNotifyToday(); });
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/study-weight/service-worker.js')
    .then((reg) => {
      swReg = reg;
      console.log('Service worker registered');

      reg.update().catch(() => {});

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            const key = 'sw_reloaded_once';

            if (!sessionStorage.getItem(key)) {
              console.log('New service worker installed. Reloading...');
              sessionStorage.setItem(key, '1');
              location.reload();
            }
          }
        });
      });
    })
    .catch((err) => {
      console.error('Service worker registration failed:', err);
    });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const key = 'sw_controller_reloaded_once';

    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      location.reload();
    }
  });
}
