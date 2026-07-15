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
const todayStr = () => new Date().toISOString().slice(0,10);
const logicalNow = () => { const n=new Date(); if(n.getHours()<4) n.setDate(n.getDate()-1); return n; };
const logicalDateStr = () => logicalNow().toISOString().slice(0,10);
const nowTime = () => new Date().toTimeString().slice(0,5);
const mondayOf = (d = new Date()) => { const x=new Date(d); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); return x.toISOString().slice(0,10); };
const minFromTime = t => t ? (+t.slice(0,2))*60 + (+t.slice(3,5)) : null;
const calcMinutesByTime = (s,e)=> (s&&e) ? Math.max(0, minFromTime(e)-minFromTime(s)) : null;
const focusMinutes = r => Math.round((Number(r.minutes)||0) * (state.quality[r.quality] ?? 1));

function escapeHtml(value){
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}
const attr = escapeHtml;

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
  state.weekGoal=(goals.find(g=>g.weekStartDate===mondayOf())?.targetMinutes)||0;
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
const fmtH = m => `${Math.floor((m||0)/60)}時間${Math.round((m||0)%60)}分`;
const fmtHHMM = m => { const t=Math.min(1439,Math.max(0,Math.round(m||0))); return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`; };
const fmtClock = m => { const t=((Math.round(m||0)%1440)+1440)%1440; return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`; };

async function renderDashboard(){
  const baseDate=logicalDateStr(); const a=aggregate(); const next=state.tests.filter(t=>t.date>=baseDate).sort((x,y)=>x.date.localeCompare(y.date))[0];
  const days=next?Math.ceil((new Date(next.date)-new Date(baseDate))/86400000):null;
  const latest7=[...Array(7)].map((_,i)=>{const d=new Date(); d.setDate(d.getDate()-(6-i)); return d.toISOString().slice(0,10);});
  const bars=latest7.map(d=>state.records.filter(r=>r.date===d).reduce((s,r)=>s+(+r.minutes||0),0));
  const max=Math.max(1,...bars);
  if(state.schedule?.startDate && baseDate>=state.schedule.startDate) await ensureScheduleDay(baseDate);
  const pct=state.weekGoal?Math.min(100,Math.round(a.week/state.weekGoal*100)):0;
  $('#dashboard').innerHTML=`${renderScheduleStreakCard()}
  ${tasksCardHtml()}
  ${taskMemoHtml()}
  <div class='card'><h3>学習時間</h3><div class='grid'>${[['今日',a.today,a.todayF],['今週',a.week,a.weekF],['今月',a.month,a.monthF],['累計',a.total,a.totalF]].map(v=>`<div class='metric'><div>${v[0]}</div><div class='value'>${fmtH(v[1])}</div><div class='small'>集中 ${fmtH(v[2])}</div></div>`).join('')}</div>
  ${state.weekGoal?`<div class='progress-wrap'><div class='legend-row'><span>今週目標 ${fmtH(state.weekGoal)}</span><span>${pct}%</span></div><div class='progress'><div class='progress-fill' style='width:${pct}%'></div></div></div>`:''}
  ${next?`<div class='small' style='margin-top:8px'>次のテスト: ${escapeHtml(next.name)}（あと${days}日）</div>`:''}</div>
  <div class='card'><h3>直近7日</h3><div class='bars'>${bars.map(v=>`<div class='bar' style='height:${Math.max(4,v/max*100)}%'></div>`).join('')}</div><div class='legend-row'><span>${latest7[0].slice(5)}</span><span>${latest7[6].slice(5)}</span></div></div>
  <details class='fold'><summary>詳しい内訳（教科・教材・ラベル・質）</summary>
  ${renderBreakdownCard('教科別', state.subjects.map(s=>[s.name,state.records.filter(r=>r.subjectId===s.id).reduce((x,r)=>x+(+r.minutes||0),0)]))}
  ${renderMaterialTotalsCard()}
  ${renderBreakdownCard('ラベル別', state.labels.map(l=>[l.name,state.records.filter(r=>(r.labelIds||[]).includes(l.id)).reduce((x,r)=>x+(+r.minutes||0),0)]))}
  ${renderBreakdownCard('質別', ['S','A','B','C','D'].map(q=>[q,state.records.filter(r=>r.quality===q).reduce((x,r)=>x+(+r.minutes||0),0)]))}
  </details>`;
  bindScheduleChecks();
  bindTaskMemo();
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
  return `<div class='card'><h3>教材別累計</h3>${rows.map(v=>{const m=state.materials.find(x=>x.id===v.materialId); const materialName=m?.name||'教材未選択'; const sid=m?.subjectId||v.subjectId; const sname=subjectName(sid); return `<div class='list-item'><div><b>${escapeHtml(materialName)}</b> / ${escapeHtml(sname)}</div><div class='small'>合計 ${fmtH(v.minutes)}・集中 ${fmtH(v.focus)}・${v.count}回</div><div class='small'>ページ ${v.pages} / 問題 ${v.problems}</div></div>`;}).join('')||'<div class=\"small\">データなし</div>'}</div>`;
}
function renderBreakdownCard(title,pairs){
  const rows=pairs.filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]); const total=rows.reduce((s,[,v])=>s+v,0)||1;
  return `<div class='card'><h3>${title}</h3>${rows.map(([k,v])=>`<div class='legend-row'><span>${escapeHtml(k)}</span><span>${fmtH(v)} (${Math.round(v/total*100)}%)</span></div>`).join('')||'<div class="small">データなし</div>'}</div>`;
}

function renderRecordForm(edit=null){
  const r=edit||{date:logicalDateStr(),startTime:'',endTime:nowTime(),minutes:'',subjectId:'',materialId:'',labelIds:[],quality:'A',pages:'',problems:'',memo:''};
  const selectedLabels = new Set(r.labelIds || []);
  $('#record').innerHTML=`<div class='card'>
    <h3>${edit?'記録編集':'記録追加'}</h3>
    <div class='card'><h4>ストップウォッチ</h4><div id='swDisplay' class='value'>00:00:00</div><div class='sw-actions'><button id='swStart' type='button' class='btn small'>開始</button><button id='swStop' type='button' class='btn small'>停止</button><button id='swReset' type='button' class='btn small'>リセット</button><button id='swSet' type='button' class='btn small'>学習時間に反映</button></div></div>
    <button id='saveRecordTop' class='btn small primary'>記録を追加</button>
    <label>メモ</label><textarea id='fMemo'>${escapeHtml(r.memo||'')}</textarea>
    <div class='row-2'><div><label>日付</label><input id='fDate' type='date' value='${r.date}' /></div><div><label>学習時間</label><input id='fDuration' type='time' value='${fmtHHMM(+r.minutes||0)}' /></div></div>
    <div class='row-2'><div><label>開始</label><input id='fStart' type='time' value='${r.startTime||''}'/></div><div><label>終了</label><input id='fEnd' type='time' value='${r.endTime||''}'/></div></div>
    <label>質</label><select id='fQuality'>${['S','A','B','C','D'].map(q=>`<option ${q===r.quality?'selected':''}>${q}</option>`).join('')}</select>
    <label>教科</label><select id='fSubject'>${state.subjects.map(s=>`<option value='${s.id}' ${s.id===r.subjectId?'selected':''}>${escapeHtml(s.name)}</option>`).join('')}</select>
    <label>教材</label><select id='fMaterial'><option value=''>未選択</option></select>
    <label>ラベル(複数)</label><div id='labelChips' class='tags'>${state.labels.map(l=>`<button type='button' class='chip ${selectedLabels.has(l.id)?'active':''}' data-id='${l.id}'>${escapeHtml(l.name)}</button>`).join('')}</div>
    <div class='row'><div><label>ページ数</label><input id='fPages' type='number' value='${r.pages||''}' /></div><div><label>問題数</label><input id='fProblems' type='number' value='${r.problems||''}' /></div></div>
    <div class='row'><button id='saveRecord' class='btn primary'>保存</button>${edit?"<button id='cancelEdit' class='btn'>キャンセル</button>":''}</div>
  </div>`;
  let sw=0, timer=null;
  // 教科に紐づく教材だけを選択肢に出す（教科未設定の旧教材は全教科で表示）
  const fillMaterials=(preferred='')=>{
    const sid=$('#fSubject').value;
    const opts=state.materials.filter(m=>!m.subjectId || m.subjectId===sid);
    $('#fMaterial').innerHTML=`<option value=''>未選択</option>`+opts.map(m=>`<option value='${m.id}'>${escapeHtml(m.name)}</option>`).join('');
    $('#fMaterial').value = opts.some(m=>m.id===preferred) ? preferred : '';
  };
  fillMaterials(r.materialId);
  $('#fSubject').onchange=()=>fillMaterials($('#fMaterial').value);
  document.querySelectorAll('#labelChips .chip').forEach(chip => chip.onclick=()=>{chip.classList.toggle('active');});
  const drawSw=()=>{$('#swDisplay').textContent=new Date(sw*1000).toISOString().slice(11,19);};
  $('#swStart').onclick=()=>{if(timer) return; timer=setInterval(()=>{sw++;drawSw();},1000);};
  $('#swStop').onclick=()=>{clearInterval(timer); timer=null;};
  $('#swReset').onclick=()=>{clearInterval(timer); timer=null; sw=0; drawSw();};
  $('#swSet').onclick=()=>{const total=Math.max(1,Math.round(sw/60)); $('#fDuration').value=fmtHHMM(total); syncTimeFields('duration');};
  const getMinutes=()=>minFromTime($('#fDuration').value)||0;
  const setEndFromStart=()=>{const start=$('#fStart').value, mins=getMinutes(); if(!start||!mins) return false; $('#fEnd').value=fmtClock(minFromTime(start)+mins); return true;};
  const setStartFromEnd=()=>{const end=$('#fEnd').value, mins=getMinutes(); if(!end||!mins) return false; $('#fStart').value=fmtClock(minFromTime(end)-mins); return true;};
  const setDurationFromRange=()=>{const start=$('#fStart').value, end=$('#fEnd').value; if(!start||!end) return false; const mins=calcMinutesByTime(start,end); if(mins===null) return false; $('#fDuration').value=fmtHHMM(mins); return true;};
  const syncTimeFields=(source='duration')=>{
    const hasStart=!!$('#fStart').value, hasEnd=!!$('#fEnd').value, hasDuration=!!getMinutes();
    if(hasStart && hasDuration) return setEndFromStart();
    if(source==='end' && hasStart && hasEnd) return setDurationFromRange();
    if(hasEnd && hasDuration) return setStartFromEnd();
    return false;
  };
  $('#fStart').onchange=()=>syncTimeFields('start'); $('#fEnd').onchange=()=>syncTimeFields('end'); $('#fDuration').onchange=()=>syncTimeFields('duration');
  const saveHandler=async()=>{syncTimeFields('save'); const rawDate=$('#fDate').value; const normalizedDate=normalizeDateInput(rawDate); if(!normalizedDate) return alert('無効な日付です。YYYY-MM-DD または YYYY/MM/DD 形式で入力してください。'); const totalMinutes=getMinutes(); const data={date:normalizedDate,startTime:$('#fStart').value,endTime:$('#fEnd').value,minutes:totalMinutes,subjectId:$('#fSubject').value,materialId:$('#fMaterial').value,labelIds:[...document.querySelectorAll('#labelChips .chip.active')].map(o=>o.dataset.id),quality:$('#fQuality').value,pages:+($('#fPages').value||0),problems:+($('#fProblems').value||0),memo:$('#fMemo').value,updatedAt:new Date().toISOString()}; if(!data.minutes) return alert('学習時間は必須');
    if(edit) await updateDoc(userDoc('studyRecords',edit.id),data); else await addDoc(userCol('studyRecords'),{...data,createdAt:new Date().toISOString()});
    await refresh(); switchScreen('list');
  };
  $('#saveRecord').onclick=saveHandler;
  $('#saveRecordTop').onclick=saveHandler;
  if(edit) $('#cancelEdit').onclick=()=>renderRecordForm();
}

function renderList(){
  $('#list').innerHTML=`<details class='fold'><summary>絞り込み</summary><div class='card'><div class='row'><input id='fltDate' type='date'/><select id='fltSubject'><option value=''>教科全て</option>${state.subjects.map(s=>`<option value='${s.id}'>${escapeHtml(s.name)}</option>`).join('')}</select></div><div class='row'><select id='fltQuality'><option value=''>質全て</option>${['S','A','B','C','D'].map(q=>`<option>${q}</option>`)}</select><select id='fltLabel'><option value=''>ラベル全て</option>${state.labels.map(l=>`<option value='${l.id}'>${escapeHtml(l.name)}</option>`).join('')}</select></div></div></details><div id='recordsWrap'></div>`;
  const draw=()=>{const d=$('#fltDate').value,s=$('#fltSubject').value,q=$('#fltQuality').value,l=$('#fltLabel').value;
    const rows=state.records.filter(r=>(!d||r.date===d)&&(!s||r.subjectId===s)&&(!q||r.quality===q)&&(!l||(r.labelIds||[]).includes(l))).sort((a,b)=>`${b.date} ${b.endTime||''}`.localeCompare(`${a.date} ${a.endTime||''}`));
    $('#recordsWrap').innerHTML=rows.map(r=>`<div class='tl-item'>
      <div class='tl-head'><span class='tl-title'>${escapeHtml(subjectName(r.subjectId))}${materialName(r.materialId)?` <span class='tl-material'>${escapeHtml(materialName(r.materialId))}</span>`:''}</span><span class='tl-time'>${r.date.slice(5).replace('-','/')} ${r.startTime||''}${r.startTime||r.endTime?'–':''}${r.endTime||''}</span></div>
      <div class='tl-meta'>${fmtH(r.minutes)}・集中${fmtH(focusMinutes(r))}・質${r.quality}${(r.labelIds||[]).map(id=>` <span class='tag'>${escapeHtml(labelName(id))}</span>`).join('')}</div>
      ${r.memo?`<div class='tl-memo'>${escapeHtml(r.memo)}</div>`:''}
      <div class='tl-actions'><button class='link-btn edit' data-id='${r.id}'>編集</button><button class='link-btn danger del' data-id='${r.id}'>削除</button></div>
    </div>`).join('')||'<div class="card small">まだ記録がありません</div>';
    document.querySelectorAll('.edit').forEach(b=>b.onclick=()=>{switchScreen('record');renderRecordForm(state.records.find(x=>x.id===b.dataset.id));});
    document.querySelectorAll('.del').forEach(b=>b.onclick=async()=>{if(confirm('削除しますか？')){await deleteDoc(userDoc('studyRecords',b.dataset.id)); await refresh();}});
  }; ['fltDate','fltSubject','fltQuality','fltLabel'].forEach(id=>$('#'+id).onchange=draw); draw();
}
const subjectName=id=>state.subjects.find(x=>x.id===id)?.name||'未設定';
const materialName=id=>state.materials.find(x=>x.id===id)?.name||'';
const labelName=id=>state.labels.find(x=>x.id===id)?.name||'不明';

function renderManageHtml(){ return `<div class='card'><button class='btn' id='backSettings'>← 設定へ戻る</button>${managerBlock('教科','subjects',state.subjects,false)}${managerBlock('教材','materials',state.materials,false,true)}${managerBlock('ラベル','labels',state.labels,false)}</div>`; }
function managerBlock(title,key,items,hasColor=false,hasSubject=false){ return `<h3>${title}</h3><div class='row'>${hasSubject?`<select id='new-${key}-subject'>${state.subjects.map(s=>`<option value='${s.id}'>${escapeHtml(s.name)}</option>`).join('')}</select>`:''}<input id='new-${key}-name' placeholder='${title}名'/><button class='btn add' data-key='${key}'>追加</button></div>${items.map((i,idx)=>`<div class='list-item' data-item-id='${i.id}'><span>${i.color?`<span class='inline-dot' style='background:${i.color}'></span>`:''}${escapeHtml(i.name)}${hasSubject?`<span class='small'>　${escapeHtml(subjectName(i.subjectId))}</span>`:''}</span><div class='row'><button class='btn small move' data-key='${key}' data-id='${i.id}' data-dir='up' ${idx===0?'disabled':''}>↑</button><button class='btn small move' data-key='${key}' data-id='${i.id}' data-dir='down' ${idx===items.length-1?'disabled':''}>↓</button><button class='btn small editm' data-key='${key}' data-id='${i.id}'>編集</button><button class='btn small danger delm' data-key='${key}' data-id='${i.id}'>削除</button></div></div>`).join('')}`; }
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
  $('#backSettings').onclick=()=>renderSettings();
}
function renderGoals(){ const a=aggregate(); const baseDate=logicalDateStr(); if(!state.calendarMonth) state.calendarMonth = baseDate.slice(0,7); const pct=state.weekGoal?Math.min(100,Math.round(a.week/state.weekGoal*100)):0;
$('#goals').innerHTML=`
<div class='card'><h3>今週の進み具合</h3>
  ${state.weekGoal?`<div class='progress-wrap'><div class='legend-row'><span>${fmtH(a.week)} / 目標 ${fmtH(state.weekGoal)}</span><span>${pct}%</span></div><div class='progress'><div class='progress-fill' style='width:${pct}%'></div></div></div>`:`<div class='small'>週目標が未設定です。下の「設定」から登録できます。</div>`}
</div>
${renderCalendarCard()}
${state.tests.filter(t=>t.date>=baseDate).length?`<div class='card'><h3>テストまで</h3>${state.tests.filter(t=>t.date>=baseDate).map(t=>`<div class='legend-row'><span>${escapeHtml(t.name)}</span><span><b>あと${Math.max(0,Math.ceil((new Date(t.date)-new Date(baseDate))/86400000))}日</b>　<span class='small'>${t.date}</span></span></div>`).join('')}</div>`:''}
<details class='fold'><summary>設定（週目標・テスト・タスク・期間）</summary>
  <div class='card'><h4>今週の目標時間</h4><input id='goalDuration' type='time' value='${fmtHHMM(state.weekGoal||0)}'/><button id='saveGoal' class='btn primary small' style='margin-top:8px'>保存</button></div>
  <div class='card'><h4>テスト登録</h4><input id='testName' placeholder='テスト名'/><label>日付</label><input id='testDate' type='date'/><label>メモ</label><textarea id='testMemo' placeholder='メモ'></textarea><button id='addTest' class='btn small' style='margin-top:8px'>追加</button>${state.tests.map(t=>`<div class='list-item'><span>${escapeHtml(t.name)} <span class='small'>${t.date}</span></span><button class='link-btn danger deltest' data-id='${t.id}'>削除</button></div>`).join('')}</div>
  ${scheduleSettingsHtml()}
</details>`;
bindScheduleSettings();
$('#saveGoal').onclick=async()=>{const weekStartDate=mondayOf(); const targetMinutes=minFromTime($('#goalDuration').value)||0; const g=(await getDocs(query(userCol('weeklyGoals')))).docs.map(d=>({id:d.id,...d.data()})).find(x=>x.weekStartDate===weekStartDate); if(g) await updateDoc(userDoc('weeklyGoals',g.id),{targetMinutes,updatedAt:new Date().toISOString()}); else await addDoc(userCol('weeklyGoals'),{weekStartDate,targetMinutes,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); await refresh();};
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
  const cells=[]; for(let i=0;i<startDay;i++) cells.push(`<div class='cal-cell empty'></div>`); for(let d=1;d<=days;d++){const date=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`; const info=dayMap[date]; const min=info?.minutes||0; const lv=min>=120?4:min>=60?3:min>=30?2:min>=1?1:0; const marker=lv===1?'•':lv===2?'✓':''; const inPeriod=!!findActivePeriod(date); cells.push(`<button type='button' class='cal-cell studied-${lv} ${date===logicalDateStr()?'today':''} ${info?'studied':''} ${inPeriod?'in-period':''} ${date===state.selectedDate?'selected':''}' data-date='${date}'><span>${d}</span><small>${marker}</small></button>`);}
  return `<div class='card'><h3>カレンダー</h3><div class='cal-nav'><button type='button' class='cal-nav-btn' id='calPrev' aria-label='前月'>‹</button><button type='button' class='cal-nav-label' id='calToday'>${state.calendarMonth}</button><button type='button' class='cal-nav-btn' id='calNext' aria-label='次月'>›</button></div><div class='cal-week'>${['日','月','火','水','木','金','土'].map(v=>`<div>${v}</div>`).join('')}</div><div class='cal-grid'>${cells.join('')}</div><div class='small'>学習日数 ${studiedDays}日 / 合計 ${fmtH(monthMinutes)} / 集中 ${fmtH(monthFocus)}${state.schedulePeriods?.length?' ・ <span class="in-period-dot"></span> 期間中の日':''}</div><div id='calDayRecords'>${renderCalendarDayRecords(dayMap[state.selectedDate], state.selectedDate)}${renderCalendarDayTasks(state.selectedDate)}</div></div>`;
}

function renderCalendarDayRecords(dayInfo,date){
  if(!date) return `<div class='small'>日付をタップするとその日の記録とタスク達成状況を表示します。</div>`;
  if(!dayInfo) return `<h4>${date}</h4><div class='small'>この日の学習記録はありません。</div>`;
  return `<h4>${date}</h4><div class='small' style='margin-bottom:6px'>合計 ${fmtH(dayInfo.minutes)}・集中 ${fmtH(dayInfo.focus)}</div>${dayInfo.records.map(r=>`<div class='list-item'>${escapeHtml(subjectName(r.subjectId))} / ${escapeHtml(materialName(r.materialId)||'教材未選択')} / ${r.minutes}分 / 質${escapeHtml(r.quality)}<div class='small'>${escapeHtml(r.memo||'')}</div></div>`).join('')}`;
}
function renderCalendarDayTasks(date){
  if(!date || !state.schedule?.startDate || date<state.schedule.startDate) return '';
  const d=getScheduleDay(date);
  const tasks=d?d.tasks:effectiveTasksFor(date);
  if(!tasks.length) return '';
  const done=d?(d.done||{}):{};
  return `<h4 style='margin-top:12px'>${date} のタスク</h4>${tasks.map(t=>`<div class='legend-row'><span>${done[t.id]?'✓':'・'} ${escapeHtml(t.text)}</span></div>`).join('')}`;
}

// ---- スケジュール（通年ベース + 季節ごとの期間上書き） ----
function scheduleDayDoc(date){ return doc(db, `users/${state.uid}/scheduleDays/${date}`); }
function getScheduleDay(date){ return state.scheduleDays.find(d=>d.id===date); }
function addDays(dateStr,n){ const d=new Date(dateStr); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function findActivePeriod(date){ return (state.schedulePeriods||[]).find(p=>date>=p.startDate && date<=p.endDate); }
function effectiveTasksFor(date){ const p=findActivePeriod(date); const base=state.schedule.defaultTasks||[]; return p ? [...base, ...(p.tasks||[])] : base; }
const dailyMinutesFor = date => state.records.filter(r=>r.date===date).reduce((s,r)=>s+(+r.minutes||0),0);
function isDayComplete(d){ return !!(d && d.tasks && d.tasks.length>0 && d.tasks.every(t=>d.done?.[t.id]) && dailyMinutesFor(d.date)>=20); }
async function ensureScheduleDay(date){
  const existing=getScheduleDay(date);
  if(existing){
    // 空のままスナップショットされた日（期間作成直後など）は、タスクが後から登録されたら反映する
    const eff=effectiveTasksFor(date);
    if((existing.tasks||[]).length===0 && eff.length>0){
      existing.tasks=eff.map(t=>({...t}));
      await setDoc(scheduleDayDoc(date), {...existing, updatedAt:new Date().toISOString()}, {merge:true});
    }
    return existing;
  }
  if(!state.schedule.startDate || date<state.schedule.startDate) return null;
  const data={ date, tasks: effectiveTasksFor(date), done:{}, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
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
  return tasks.filter(t=>!done[t.id]).map(t=>({...t,date:yesterday}));
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
const pendingCarryoverFade = new Map(); // 繰り越し完了直後、フェード演出のため一時的に表示を維持するタスクのスナップショット
function tasksCardHtml(){
  if(!state.schedule?.startDate) return '';
  const today=logicalDateStr();
  const carryLive=scheduleCarryover();
  const carryExtra=[...pendingCarryoverFade.values()].filter(p=>!carryLive.some(c=>c.id===p.id));
  const carry=[...carryLive, ...carryExtra];
  const d=getScheduleDay(today);
  const tasks=d?d.tasks:effectiveTasksFor(today);
  const done=d?(d.done||{}):{};
  const doneCount=tasks.filter(t=>done[t.id]).length;
  const activePeriod=findActivePeriod(today);
  const emptyMsg=activePeriod
    ?`「${escapeHtml(activePeriod.name)}」期間のタスクが未登録です。目標タブ下部の設定から追加してください。`
    :'タスクが未登録です。目標タブ下部の設定から追加してください。';
  const carryNote=carryLive.length?`${carryLive[0].date}分の繰り越し${carryLive.length}件 ・ `:'';
  const carryRows=carry.map(t=>{
    const pending=pendingCarryoverFade.has(t.id);
    return `<label class='list-item carry-item${pending?' completing':''}'><input type='checkbox' class='schCarryCheck' data-date='${t.date}' data-id='${t.id}' ${pending?'checked disabled':''}/><span>${escapeHtml(t.text)}</span><span class='tag tag-carry'>繰り越し</span></label>`;
  }).join('');
  const todayRows=tasks.map(t=>`<label class='list-item'><input type='checkbox' class='schTaskCheck' data-date='${today}' data-id='${t.id}' ${done[t.id]?'checked':''}/><span>${escapeHtml(t.text)}</span></label>`).join('');
  return `<div class='card'>
    <h3>今日のタスク <span class='small'>${carryNote}${activePeriod?`${escapeHtml(activePeriod.name)}期間 ・ `:''}${tasks.length?`${doneCount}/${tasks.length} 完了`:''}</span></h3>
    ${carryRows}
    ${tasks.length===0?`<div class='small'>${emptyMsg}</div>`:todayRows}
  </div>`;
}
function taskMemoHtml(){
  return `<div class='card'><h4>タスクメモ</h4><textarea id='taskMemoInput' placeholder='自由にメモを書けます'>${escapeHtml(state.taskMemo||'')}</textarea><button id='saveTaskMemo' class='btn small' style='margin-top:8px'>保存</button></div>`;
}
function bindTaskMemo(){
  $('#saveTaskMemo').onclick=async()=>{
    const taskMemo=$('#taskMemoInput').value;
    await setDoc(doc(db,`users/${state.uid}/settings/main`),{taskMemo},{merge:true});
    state.taskMemo=taskMemo;
    alert('保存しました');
  };
}
function bindScheduleChecks(){
  document.querySelectorAll('.schTaskCheck,.schCarryCheck').forEach(cb=>cb.onchange=async()=>{
    const isCarryCheck=cb.classList.contains('schCarryCheck') && cb.checked;
    try{
      if(isCarryCheck){
        pendingCarryoverFade.set(cb.dataset.id, {date:cb.dataset.date, id:cb.dataset.id, text:cb.closest('label').querySelector('span').textContent});
        cb.closest('label').classList.add('completing');
      }
      await toggleScheduleTask(cb.dataset.date, cb.dataset.id);
    }catch(err){
      console.error(err);
      pendingCarryoverFade.delete(cb.dataset.id);
      alert('保存に失敗しました。通信環境をご確認のうえ、もう一度お試しください。');
    }
    if(isCarryCheck){
      setTimeout(()=>{ pendingCarryoverFade.delete(cb.dataset.id); renderDashboard(); }, 450); // 即消えると分かりづらいため一呼吸置く
    }else{
      renderDashboard(); // 全データの再取得はせず、更新済みのローカル状態から即座に再描画
    }
  });
}
function periodManagerHtml(p){
  return `<div class='card'>
    <div class='row'><b>${escapeHtml(p.name)}</b><button class='link-btn danger delPeriod' data-id='${p.id}'>期間を削除</button></div>
    <div class='small'>${p.startDate} 〜 ${p.endDate}</div>
    <div class='row'><input id='pNewTask-${p.id}' placeholder='タスク名'/><button class='btn small addPeriodTask' data-id='${p.id}'>追加</button></div>
    ${(p.tasks||[]).map(t=>`<div class='list-item'><span>${escapeHtml(t.text)}</span><button class='link-btn danger delPeriodTask' data-pid='${p.id}' data-id='${t.id}'>削除</button></div>`).join('')||'<div class="small">タスク未登録</div>'}
  </div>`;
}
function scheduleSettingsHtml(){
  const {startDate=''}=state.schedule||{};
  const defaultTasks=state.schedule?.defaultTasks||[];
  const periods=state.schedulePeriods||[];
  return `
    <div class='card'>
      <h4>タスクのトラッキング開始日</h4>
      <input id='schStart' type='date' value='${startDate}'/>
      <button id='schSaveStart' class='btn primary small' style='margin-top:8px'>開始日を保存</button>
      ${startDate?'':'<div class="small" style="margin-top:6px">開始日を設定するとホームに今日のタスクが表示されます。</div>'}
    </div>
    <div class='card'>
      <h4>毎日のデフォルトタスク</h4>
      <div class='row'><input id='schNewTask' placeholder='タスク名（例: 単語100個）'/><button id='schAddTask' class='btn small'>追加</button></div>
      ${defaultTasks.length===0?`<button id='schUseTemplate' class='btn small'>例テンプレートを使う</button>`:''}
      ${defaultTasks.map(t=>`<div class='list-item'><span>${escapeHtml(t.text)}</span><button class='link-btn danger delSchTask' data-id='${t.id}'>削除</button></div>`).join('')||'<div class="small">タスク未登録</div>'}
    </div>
    <div class='card'>
      <h4>期間（季節ごとの上書き）</h4>
      <div class='small'>期間中は通年のデフォルトタスクに加えて、その期間専用のタスクも追加されます（例: 夏休み・冬休み）。</div>
      <label>期間名</label><input id='pName' placeholder='例: 夏休み'/>
      <div class='row'><div><label>開始日</label><input id='pStart' type='date'/></div><div><label>終了日</label><input id='pEnd' type='date'/></div></div>
      <button id='addPeriod' class='btn small' style='margin-top:8px'>期間を追加</button>
    </div>
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
function renderScheduleStreakCard(){
  if(!state.schedule?.startDate) return '';
  const s=computeScheduleStreak();
  return `<div class='card'><h3>学習ストリーク</h3><div class='streak-big ${s.current>0?'':'streak-zero'}'>${s.current}<span class='unit'>日連続</span></div>${s.broken?`<div class='streak-broken'>${s.broken.date} に ${s.broken.length}日 のストリークが途切れました</div>`:''}</div>`;
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

function renderSettings(mode='menu'){ if(mode==='manage'){ $('#settings').innerHTML=renderManageHtml(); bindManager(); return; } $('#settings').innerHTML=`<div class='card small'>ログイン中: <b>${escapeHtml(state.userName||state.userEmail||'不明')}</b>${state.userName&&state.userEmail?`<br>${escapeHtml(state.userEmail)}`:''}</div><div class='card menu-card'><h3>設定メニュー</h3>
  <button class='menu-row' id='openManage'><span>教科・教材・ラベル管理</span><span class='chev'>›</span></button>
  <button class='menu-row' id='openBackup'><span>バックアップ</span><span class='chev'>›</span></button>
  <button class='menu-row' id='openQuality'><span>質係数</span><span class='chev'>›</span></button>
  <button class='menu-row' id='openNotify'><span>通知設定</span><span class='chev'>›</span></button>
  </div><div class='card' id='settingsPanel'></div><div class='card small'>このアプリは、ログインした利用者の学習記録をFirebase Cloud Firestoreに保存し、PCとiPhoneなど複数端末で同期します。学習記録、教材名、メモなどのデータは、ログインした本人のデータとして保存されます。Firestore Security Rulesにより、各ユーザーは自分のデータのみ読み書きできる設計にしてください。なお、端末やブラウザ上にもPWAのキャッシュや一時データが保存される場合があります。必要に応じてJSONエクスポート機能でバックアップしてください。</div><button id='settingsLogout' class='btn danger' style='width:100%'>ログアウト</button>`;
$('#settingsPanel').innerHTML = `<h3>質係数</h3>${['S','A','B','C','D'].map(k=>`<label>${k}</label><input id='q-${k}' type='number' step='0.01' value='${state.quality[k]}'/>`).join('')}<button id='saveQ' class='btn primary'>保存</button>`;
$('#openManage').onclick=()=>renderSettings('manage');
$('#openBackup').onclick=()=>$('#settingsPanel').innerHTML=`<h3>バックアップ</h3><button id='exp' class='btn'>JSONエクスポート</button><input id='impFile' type='file' accept='application/json'/><button id='imp' class='btn'>JSONインポート</button><button id='wipe' class='btn danger'>全データ削除</button>`;
$('#openQuality').onclick=()=>renderSettings();
$('#openNotify').onclick=()=>{
  $('#settingsPanel').innerHTML=`<h3>通知</h3><div class='small'>アプリを開いたときに「今日のタスク」を端末通知でお知らせします。ブラウザ/OSの仕様上、アプリを閉じている間の確実な自動通知はできません。</div><div>許可状態: <b id='notifyStatus'></b></div><label>通知する時刻</label><input id='notifyHourInput' type='time' value='${notifyTimeStr()}'/><div class='row'><button id='notifyEnable' class='btn primary small'>通知を許可する</button><button id='notifySave' class='btn small'>時刻を保存</button></div><div class='small' style='margin-top:12px'>アプリを閉じていても届くプッシュ通知（要デプロイ・テスト送信用）</div><div>プッシュ登録状態: <b id='pushStatus'></b></div><div class='row'><button id='pushRegister' class='btn small'>プッシュ通知を登録</button><button id='pushTest' class='btn small'>テスト通知を送信</button><button id='pushUnregister' class='btn danger small'>登録解除</button></div>`;
  $('#notifyStatus').textContent=('Notification' in window)?Notification.permission:'非対応';
  $('#notifyEnable').onclick=async()=>{ if(!('Notification' in window)) return alert('この端末・ブラウザは通知に対応していません。'); const p=await Notification.requestPermission(); $('#notifyStatus').textContent=p; };
  $('#notifySave').onclick=()=>{ localStorage.setItem(NOTIFY_HOUR_KEY, $('#notifyHourInput').value||'07:00'); alert('保存しました'); };
  refreshPushStatus();
  $('#pushRegister').onclick=registerPush;
  $('#pushTest').onclick=sendTestPush;
  $('#pushUnregister').onclick=unregisterPush;
};
$('#settingsLogout').onclick=()=>signOut(auth);
$('#saveQ').onclick=async()=>{const quality={}; ['S','A','B','C','D'].forEach(k=>quality[k]=+($(`#q-${k}`).value||1)); await setDoc(doc(db,`users/${state.uid}/settings/main`),{quality,appName:APP_NAME},{merge:true}); await refresh();};
bindSettingsPanelActions(); }

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
      for(const key of ['subjects','materials','labels','studyRecords','tests']) for(const item of (j[key]||[])) await addDoc(userCol(key==='studyRecords'?'studyRecords':key),item);
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

function switchScreen(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===id)); document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.screen===id)); if(id==='record') renderRecordForm(); if(id==='list') renderList(); if(id==='goals') renderGoals(); if(id==='settings') renderSettings(); if(id==='dashboard') renderDashboard(); }
async function refresh(){ await loadAll(); ['dashboard','record','list','goals','settings'].forEach(id=>{ if($('#'+id).classList.contains('active')) switchScreen(id); }); maybeNotifyToday(); }

$('#appTitle').textContent = APP_NAME;
$('#loginBtn').onclick=async()=>{
  try {
    const result = await signInWithPopup(auth,new GoogleAuthProvider());
    console.log('Login success:', result.user?.email);
  } catch (error) {
    console.error('Login failed:', error.code, error.message);
    alert(`ログイン失敗: ${error.code} / ${error.message}`);
  }
};
document.querySelectorAll('.bottom-nav button').forEach(b=>b.onclick=()=>switchScreen(b.dataset.screen));
onAuthStateChanged(auth, async user=>{
  console.log('Auth state:', user ? `logged in (${user.email || user.uid})` : 'null (logged out)');
  if(!user){ state.uid=null; state.userName=''; state.userEmail=''; $('#app').hidden=true; $('#bottomNav').hidden=true; $('#loginBtn').hidden=false; return; }
  state.uid=user.uid; state.userName=user.displayName||''; state.userEmail=user.email||''; $('#app').hidden=false; $('#bottomNav').hidden=false; $('#loginBtn').hidden=true;
  await ensureSeedData(); await refresh(); switchScreen('dashboard');
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
