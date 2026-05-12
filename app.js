import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, getDocs, getDoc, addDoc, setDoc, updateDoc, deleteDoc, query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const APP_NAME = 'Study Density Log';
const DEFAULT_QUALITY = { S: 1.05, A: 1.0, B: 0.55, C: 0.3, D: 0.1 };
const DEFAULT_SUBJECTS = ['英語','数学','国語','社会','理科','情報','その他'];
const DEFAULT_LABELS = ['自習','学校','学校課題','塾','塾宿題','授業','単語帳','テスト勉強','受験勉強','その他'];

const firebaseConfig = {
  apiKey: 'AIzaSyC4gkAvxpB87UqVUItrLK098AY758f2hMQ', authDomain: 'study-weight.firebaseapp.com', projectId: 'study-weight', storageBucket: 'study-weight.firebasestorage.app', messagingSenderId: '850012109401', appId: '1:850012109401:web:6ba78214593f87c7054f48'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const state = { uid: null, subjects: [], materials: [], labels: [], records: [], tests: [], quality: { ...DEFAULT_QUALITY }, weekGoal: 0, calendarMonth: null, selectedDate: null };

const $ = s => document.querySelector(s);
const todayStr = () => new Date().toISOString().slice(0,10);
const logicalNow = () => { const n=new Date(); if(n.getHours()<4) n.setDate(n.getDate()-1); return n; };
const logicalDateStr = () => logicalNow().toISOString().slice(0,10);
const nowTime = () => new Date().toTimeString().slice(0,5);
const mondayOf = (d = new Date()) => { const x=new Date(d); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); return x.toISOString().slice(0,10); };
const minFromTime = t => t ? (+t.slice(0,2))*60 + (+t.slice(3,5)) : null;
const calcMinutesByTime = (s,e)=> (s&&e) ? Math.max(0, minFromTime(e)-minFromTime(s)) : null;
const focusMinutes = r => Math.round((Number(r.minutes)||0) * (state.quality[r.quality] ?? 1));
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
  const settings=(await getDoc(doc(db,`users/${state.uid}/settings/main`))).data(); state.quality=settings?.quality || { ...DEFAULT_QUALITY };
}

function aggregate(){
  const t=logicalDateStr(), w=mondayOf(logicalNow()), m=t.slice(0,7); let out={today:0,todayF:0,week:0,weekF:0,month:0,monthF:0,total:0,totalF:0};
  state.records.forEach(r=>{const min=+r.minutes||0,f=focusMinutes(r); out.total+=min; out.totalF+=f; if(r.date===t){out.today+=min;out.todayF+=f;} if(r.date>=w){out.week+=min;out.weekF+=f;} if((r.date||'').startsWith(m)){out.month+=min;out.monthF+=f;}});
  return out;
}
const fmtH = m => `${Math.floor((m||0)/60)}時間${Math.round((m||0)%60)}分`;

function renderDashboard(){
  const baseDate=logicalDateStr(); const a=aggregate(); const next=state.tests.filter(t=>t.date>=baseDate).sort((x,y)=>x.date.localeCompare(y.date))[0];
  const days=next?Math.ceil((new Date(next.date)-new Date(baseDate))/86400000):null;
  const latest7=[...Array(7)].map((_,i)=>{const d=new Date(); d.setDate(d.getDate()-(6-i)); return d.toISOString().slice(0,10);});
  const bars=latest7.map(d=>state.records.filter(r=>r.date===d).reduce((s,r)=>s+(+r.minutes||0),0));
  const max=Math.max(1,...bars);
  $('#dashboard').innerHTML=`<div class='card'><h3>学習推移</h3><div class='grid'>${[['今日',a.today,a.todayF],['今週',a.week,a.weekF],['今月',a.month,a.monthF],['累計',a.total,a.totalF]].map(v=>`<div class='metric'><div>${v[0]}</div><div class='value'>${fmtH(v[1])}</div><div class='small'>集中 ${fmtH(v[2])}</div></div>`).join('')}</div></div>
  <div class='card'><h3>目標とテスト</h3><div>今週目標: ${fmtH(state.weekGoal)} / 達成率 ${(state.weekGoal?Math.round(a.week/state.weekGoal*100):0)}%</div><div class='small'>次のテスト: ${next?`${next.name}（あと${days}日）`:'未登録'}</div></div>
  <div class='card'><h3>直近7日 学習推移（実時間）</h3><div class='bars'>${bars.map(v=>`<div class='bar' style='height:${Math.max(4,v/max*100)}%'></div>`).join('')}</div><div class='legend-row'><span>${latest7[0].slice(5)}</span><span>${latest7[6].slice(5)}</span></div></div>
  ${renderBreakdownCard('教科別', state.subjects.map(s=>[s.name,state.records.filter(r=>r.subjectId===s.id).reduce((x,r)=>x+(+r.minutes||0),0)]))}
  ${renderMaterialTotalsCard()}
  ${renderBreakdownCard('ラベル別', state.labels.map(l=>[l.name,state.records.filter(r=>(r.labelIds||[]).includes(l.id)).reduce((x,r)=>x+(+r.minutes||0),0)]))}
  ${renderBreakdownCard('質別', ['S','A','B','C','D'].map(q=>[q,state.records.filter(r=>r.quality===q).reduce((x,r)=>x+(+r.minutes||0),0)]))}`;
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
  return `<div class='card'><h3>教材別累計</h3>${rows.map(v=>{const m=state.materials.find(x=>x.id===v.materialId); const materialName=m?.name||'教材未選択'; const sid=m?.subjectId||v.subjectId; const sname=subjectName(sid); return `<div class='list-item'><div><b>${materialName}</b> / ${sname}</div><div class='small'>合計 ${fmtH(v.minutes)}・集中 ${fmtH(v.focus)}・${v.count}回</div><div class='small'>ページ ${v.pages} / 問題 ${v.problems}</div></div>`;}).join('')||'<div class=\"small\">データなし</div>'}</div>`;
}
function renderBreakdownCard(title,pairs){
  const rows=pairs.filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]); const total=rows.reduce((s,[,v])=>s+v,0)||1;
  return `<div class='card'><h3>${title}</h3>${rows.map(([k,v])=>`<div class='legend-row'><span>${k}</span><span>${fmtH(v)} (${Math.round(v/total*100)}%)</span></div>`).join('')||'<div class="small">データなし</div>'}</div>`;
}

function renderRecordForm(edit=null){
  const r=edit||{date:logicalDateStr(),startTime:'',endTime:nowTime(),minutes:'',subjectId:'',materialId:'',labelIds:[],quality:'A',pages:'',problems:'',memo:''};
  const selectedLabels = new Set(r.labelIds || []);
  $('#record').innerHTML=`<div class='card'>
    <h3>${edit?'記録編集':'記録追加'}</h3>
    <div class='card'><h4>ストップウォッチ</h4><div id='swDisplay' class='value'>00:00:00</div><div class='row'><button id='swStart' type='button' class='btn small'>開始</button><button id='swStop' type='button' class='btn small'>停止</button><button id='swSet' type='button' class='btn small'>学習時間に反映</button></div></div>
    <button id='saveRecordTop' class='btn small primary'>記録を追加</button>
    <label>メモ</label><textarea id='fMemo'>${r.memo||''}</textarea>
    <label>日付</label><input id='fDate' type='date' value='${r.date}' />
    <div class='row'><div><label>開始</label><input id='fStart' type='time' value='${r.startTime||''}'/></div><div><label>終了</label><input id='fEnd' type='time' value='${r.endTime||''}'/></div></div>
    <label>学習時間（分）</label><input id='fMinutes' type='number' min='1' value='${r.minutes||''}' />
    <div class='row'>${[15,30,45,60,90].map(m=>`<button class='btn qmin' data-min='${m}' type='button'>${m}分</button>`).join('')}</div>
    <label>質</label><select id='fQuality'>${['S','A','B','C','D'].map(q=>`<option ${q===r.quality?'selected':''}>${q}</option>`).join('')}</select>
    <label>教科</label><select id='fSubject'>${state.subjects.map(s=>`<option value='${s.id}' ${s.id===r.subjectId?'selected':''}>${s.name}</option>`).join('')}</select>
    <label>教材</label><select id='fMaterial'><option value=''>未選択</option>${state.materials.map(m=>`<option value='${m.id}' ${m.id===r.materialId?'selected':''}>${m.name}</option>`).join('')}</select>
    <label>ラベル(複数)</label><div id='labelChips' class='tags'>${state.labels.map(l=>`<button type='button' class='chip ${selectedLabels.has(l.id)?'active':''}' data-id='${l.id}'>${l.name}</button>`).join('')}</div>
    <div class='row'><div><label>ページ数</label><input id='fPages' type='number' value='${r.pages||''}' /></div><div><label>問題数</label><input id='fProblems' type='number' value='${r.problems||''}' /></div></div>
    <div class='row'><button id='saveRecord' class='btn primary'>保存</button>${edit?"<button id='cancelEdit' class='btn'>キャンセル</button>":''}</div>
  </div>`;
  let sw=0, timer=null;
  document.querySelectorAll('#labelChips .chip').forEach(chip => chip.onclick=()=>{chip.classList.toggle('active');});
  const drawSw=()=>{$('#swDisplay').textContent=new Date(sw*1000).toISOString().slice(11,19);};
  $('#swStart').onclick=()=>{if(timer) return; timer=setInterval(()=>{sw++;drawSw();},1000);};
  $('#swStop').onclick=()=>{clearInterval(timer); timer=null;};
  $('#swSet').onclick=()=>{$('#fMinutes').value=Math.max(1,Math.round(sw/60)); autoStart();};
  document.querySelectorAll('.qmin').forEach(b=>b.onclick=()=>$('#fMinutes').value=b.dataset.min);
  const autoStart=()=>{const end=$('#fEnd').value, mins=+($('#fMinutes').value||0); if(!end||!mins) return; const e=minFromTime(end); const s=Math.max(0,e-mins); const hh=String(Math.floor(s/60)).padStart(2,'0'); const mm=String(s%60).padStart(2,'0'); $('#fStart').value=`${hh}:${mm}`;};
  $('#fEnd').onchange=autoStart; $('#fMinutes').onchange=autoStart;
  const saveHandler=async()=>{const rawDate=$('#fDate').value; const normalizedDate=normalizeDateInput(rawDate); if(!normalizedDate) return alert('無効な日付です。YYYY-MM-DD または YYYY/MM/DD 形式で入力してください。'); const data={date:normalizedDate,startTime:$('#fStart').value,endTime:$('#fEnd').value,minutes:+$('#fMinutes').value,subjectId:$('#fSubject').value,materialId:$('#fMaterial').value,labelIds:[...document.querySelectorAll('#labelChips .chip.active')].map(o=>o.dataset.id),quality:$('#fQuality').value,pages:+($('#fPages').value||0),problems:+($('#fProblems').value||0),memo:$('#fMemo').value,updatedAt:new Date().toISOString()}; if(!data.minutes) return alert('学習時間は必須');
    if(edit) await updateDoc(userDoc('studyRecords',edit.id),data); else await addDoc(userCol('studyRecords'),{...data,createdAt:new Date().toISOString()});
    await refresh(); switchScreen('list');
  };
  $('#saveRecord').onclick=saveHandler;
  $('#saveRecordTop').onclick=saveHandler;
  if(edit) $('#cancelEdit').onclick=()=>renderRecordForm();
}

function renderList(){
  $('#list').innerHTML=`<div class='card'><div class='row'><input id='fltDate' type='date'/><select id='fltSubject'><option value=''>教科全て</option>${state.subjects.map(s=>`<option value='${s.id}'>${s.name}</option>`)}</select></div><div class='row'><select id='fltQuality'><option value=''>質全て</option>${['S','A','B','C','D'].map(q=>`<option>${q}</option>`)}</select><select id='fltLabel'><option value=''>ラベル全て</option>${state.labels.map(l=>`<option value='${l.id}'>${l.name}</option>`)}</select></div></div><div id='recordsWrap'></div>`;
  const draw=()=>{const d=$('#fltDate').value,s=$('#fltSubject').value,q=$('#fltQuality').value,l=$('#fltLabel').value;
    const rows=state.records.filter(r=>(!d||r.date===d)&&(!s||r.subjectId===s)&&(!q||r.quality===q)&&(!l||(r.labelIds||[]).includes(l)));
    $('#recordsWrap').innerHTML=rows.map(r=>`<div class='list-item timeline-card'><b>${r.date}</b> ${r.startTime||'--:--'}-${r.endTime||'--:--'}<br>${subjectName(r.subjectId)} / ${materialName(r.materialId)||'教材未選択'}<br>${r.minutes}分（集中${focusMinutes(r)}分）質:${r.quality}<div class='tags'>${(r.labelIds||[]).map(id=>`<span class='tag'>${labelName(id)}</span>`).join('')}</div><div class='small'>${r.memo||''}</div><div class='row'><button class='btn edit' data-id='${r.id}'>編集</button><button class='btn danger del' data-id='${r.id}'>削除</button></div></div>`).join('')||'<div class="card">データなし</div>';
    document.querySelectorAll('.edit').forEach(b=>b.onclick=()=>{switchScreen('record');renderRecordForm(state.records.find(x=>x.id===b.dataset.id));});
    document.querySelectorAll('.del').forEach(b=>b.onclick=async()=>{if(confirm('削除しますか？')){await deleteDoc(userDoc('studyRecords',b.dataset.id)); await refresh();}});
  }; ['fltDate','fltSubject','fltQuality','fltLabel'].forEach(id=>$('#'+id).onchange=draw); draw();
}
const subjectName=id=>state.subjects.find(x=>x.id===id)?.name||'未設定';
const materialName=id=>state.materials.find(x=>x.id===id)?.name||'';
const labelName=id=>state.labels.find(x=>x.id===id)?.name||'不明';

function renderManageHtml(){ return `<div class='card'><button class='btn' id='backSettings'>← 設定へ戻る</button>${managerBlock('教科','subjects',state.subjects,false)}${managerBlock('教材','materials',state.materials,false,true)}${managerBlock('ラベル','labels',state.labels,false)}</div>`; }
function managerBlock(title,key,items,hasColor=false,hasSubject=false){ return `<h3>${title}</h3><div class='row'>${hasSubject?`<select id='new-${key}-subject'>${state.subjects.map(s=>`<option value='${s.id}'>${s.name}</option>`)}</select>`:''}<input id='new-${key}-name' placeholder='${title}名'/><button class='btn add' data-key='${key}'>追加</button></div>${items.map((i,idx)=>`<div class='list-item'><span>${i.color?`<span class='inline-dot' style='background:${i.color}'></span>`:''}${i.name}</span><div class='row'><button class='btn move' data-key='${key}' data-id='${i.id}' data-dir='up' ${idx===0?'disabled':''}>↑</button><button class='btn move' data-key='${key}' data-id='${i.id}' data-dir='down' ${idx===items.length-1?'disabled':''}>↓</button><button class='btn danger delm' data-key='${key}' data-id='${i.id}'>削除</button></div></div>`).join('')}`; }
function bindManager(){ document.querySelectorAll('.add').forEach(b=>b.onclick=async()=>{const key=b.dataset.key; const name=$(`#new-${key}-name`).value.trim(); if(!name)return; const list = key==='subjects'?state.subjects:(key==='materials'?state.materials:state.labels); const base={name,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),order:list.length}; if(key==='materials') base.subjectId=$('#new-materials-subject').value; if(key!=='materials') base.color='#26c6da'; await addDoc(userCol(key),base); await refresh(); switchScreen('settings'); renderSettings('manage');});
  document.querySelectorAll('.delm').forEach(b=>b.onclick=async()=>{if(confirm('関連記録がある可能性があります。削除しますか？')){await deleteDoc(userDoc(b.dataset.key,b.dataset.id)); await refresh();}});
  document.querySelectorAll('.move').forEach(b=>b.onclick=async()=>{const key=b.dataset.key; const arr=key==='subjects'?state.subjects:(key==='materials'?state.materials:state.labels); const i=arr.findIndex(x=>x.id===b.dataset.id); const j=b.dataset.dir==='up'?i-1:i+1; if(i<0||j<0||j>=arr.length) return; const a=arr[i], c=arr[j]; await updateDoc(userDoc(key,a.id),{order:j,updatedAt:new Date().toISOString()}); await updateDoc(userDoc(key,c.id),{order:i,updatedAt:new Date().toISOString()}); await refresh(); renderSettings('manage');});
  $('#backSettings').onclick=()=>renderSettings();
}
function renderGoals(){ const a=aggregate(); const baseDate=logicalDateStr(); $('#goals').innerHTML=`<div class='card'><h3>今週の目標を設定 / 更新</h3><input id='goalInput' type='number' value='${state.weekGoal||0}'/><button id='saveGoal' class='btn primary'>保存</button><div class='small'>達成率: ${(state.weekGoal?Math.round(a.week/state.weekGoal*100):0)}%</div></div><div class='card'><div class='grid'>${[['今日',a.today,a.todayF],['今週',a.week,a.weekF],['今月',a.month,a.monthF],['累計',a.total,a.totalF]].map(v=>`<div class='metric'><div>${v[0]}</div><div class='value'>${fmtH(v[1])}</div><div class='small'>集中 ${fmtH(v[2])}</div></div>`).join('')}</div></div><div class='card'><h3>テスト登録</h3><input id='testName' placeholder='テスト名'/><input id='testDate' type='date'/><textarea id='testMemo' placeholder='メモ'></textarea><button id='addTest' class='btn'>追加</button>${state.tests.map(t=>`<div class='list-item'>${t.name} ${t.date} <span class='small'>あと${Math.max(0,Math.ceil((new Date(t.date)-new Date(baseDate))/86400000))}日</span> <button class='btn danger deltest' data-id='${t.id}'>削除</button></div>`).join('')}</div>`;
function renderGoals(){ const a=aggregate(); const baseDate=logicalDateStr(); if(!state.calendarMonth) state.calendarMonth = baseDate.slice(0,7); $('#goals').innerHTML=`<div class='card'><h3>今週の目標を設定 / 更新</h3><input id='goalInput' type='number' value='${state.weekGoal||0}'/><button id='saveGoal' class='btn primary'>保存</button><div class='small'>達成率: ${(state.weekGoal?Math.round(a.week/state.weekGoal*100):0)}%</div></div><div class='card'><div class='grid'>${[['今日',a.today,a.todayF],['今週',a.week,a.weekF],['今月',a.month,a.monthF],['累計',a.total,a.totalF]].map(v=>`<div class='metric'><div>${v[0]}</div><div class='value'>${fmtH(v[1])}</div><div class='small'>集中 ${fmtH(v[2])}</div></div>`).join('')}</div></div><div class='card'><h3>テスト登録</h3><input id='testName' placeholder='テスト名'/><input id='testDate' type='date'/><textarea id='testMemo' placeholder='メモ'></textarea><button id='addTest' class='btn'>追加</button>${state.tests.map(t=>`<div class='list-item'>${t.name} ${t.date} <span class='small'>あと${Math.max(0,Math.ceil((new Date(t.date)-new Date(baseDate))/86400000))}日</span> <button class='btn danger deltest' data-id='${t.id}'>削除</button></div>`).join('')}</div>${renderCalendarCard()}`;
$('#saveGoal').onclick=async()=>{const weekStartDate=mondayOf(); const g=(await getDocs(query(userCol('weeklyGoals')))).docs.map(d=>({id:d.id,...d.data()})).find(x=>x.weekStartDate===weekStartDate); if(g) await updateDoc(userDoc('weeklyGoals',g.id),{targetMinutes:+$('#goalInput').value,updatedAt:new Date().toISOString()}); else await addDoc(userCol('weeklyGoals'),{weekStartDate,targetMinutes:+$('#goalInput').value,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); await refresh();};
$('#addTest').onclick=async()=>{await addDoc(userCol('tests'),{name:$('#testName').value,date:$('#testDate').value,memo:$('#testMemo').value,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); await refresh();};
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
  const cells=[]; for(let i=0;i<startDay;i++) cells.push(`<div class='cal-cell empty'></div>`); for(let d=1;d<=days;d++){const date=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`; const info=dayMap[date]; const min=info?.minutes||0; const lv=min>=120?4:min>=60?3:min>=30?2:min>=1?1:0; const marker=lv===1?'•':lv===2?'✓':''; cells.push(`<button type='button' class='cal-cell studied-${lv} ${date===logicalDateStr()?'today':''} ${info?'studied':''}' data-date='${date}'><span>${d}</span><small>${marker}</small></button>`);}
  return `<div class='card'><h3>カレンダー</h3><div class='row'><button class='btn small' id='calPrev'>前月</button><div class='small'>${state.calendarMonth}</div><button class='btn small' id='calNext'>次月</button><button class='btn small' id='calToday'>今月</button></div><div class='cal-week'>${['日','月','火','水','木','金','土'].map(v=>`<div>${v}</div>`).join('')}</div><div class='cal-grid'>${cells.join('')}</div><div class='small'>学習日数 ${studiedDays}日 / 合計 ${fmtH(monthMinutes)} / 集中 ${fmtH(monthFocus)}</div><div id='calDayRecords'>${renderCalendarDayRecords(dayMap[state.selectedDate], state.selectedDate)}</div></div>`;
}
function renderCalendarDayRecords(dayInfo,date){ if(!dayInfo) return `<div class='small'>日付をタップするとその日の記録を表示します。</div>`; return `<h4>${date} の記録</h4>${dayInfo.records.map(r=>`<div class='list-item'>${subjectName(r.subjectId)} / ${materialName(r.materialId)||'教材未選択'} / ${r.minutes}分 / 質${r.quality}<div class='small'>${r.memo||''}</div></div>`).join('')}`; }
function renderSettings(mode='menu'){ if(mode==='manage'){ $('#settings').innerHTML=renderManageHtml(); bindManager(); return; } $('#settings').innerHTML=`<div class='card'><h3>設定メニュー</h3><div class='col'><button id='openManage' class='btn'>教科・教材・ラベル管理</button><button id='openBackup' class='btn'>バックアップ</button><button id='openQuality' class='btn'>質係数</button><button id='settingsLogout' class='btn danger'>ログアウト</button></div></div><div class='card' id='settingsPanel'></div><div class='card small'>このアプリは、ログインした利用者の学習記録をFirebase Cloud Firestoreに保存し、PCとiPhoneなど複数端末で同期します。学習記録、教材名、メモなどのデータは、ログインした本人のデータとして保存されます。Firestore Security Rulesにより、各ユーザーは自分のデータのみ読み書きできる設計にしてください。なお、端末やブラウザ上にもPWAのキャッシュや一時データが保存される場合があります。必要に応じてJSONエクスポート機能でバックアップしてください。</div>`;
$('#settingsPanel').innerHTML = `<h3>質係数</h3>${['S','A','B','C','D'].map(k=>`<label>${k}</label><input id='q-${k}' type='number' step='0.01' value='${state.quality[k]}'/>`).join('')}<button id='saveQ' class='btn primary'>保存</button>`;
$('#openManage').onclick=()=>renderSettings('manage');
$('#openBackup').onclick=()=>$('#settingsPanel').innerHTML=`<h3>バックアップ</h3><button id='exp' class='btn'>JSONエクスポート</button><input id='impFile' type='file' accept='application/json'/><button id='imp' class='btn'>JSONインポート</button><button id='wipe' class='btn danger'>全データ削除</button>`;
$('#openQuality').onclick=()=>renderSettings();
$('#settingsLogout').onclick=()=>signOut(auth);
$('#saveQ').onclick=async()=>{const quality={}; ['S','A','B','C','D'].forEach(k=>quality[k]=+($(`#q-${k}`).value||1)); await setDoc(doc(db,`users/${state.uid}/settings/main`),{quality,appName:APP_NAME},{merge:true}); await refresh();};
document.addEventListener('click', async(e)=>{ if(e.target?.id==='exp'){const data={subjects:state.subjects,materials:state.materials,labels:state.labels,studyRecords:state.records,tests:state.tests,settings:{quality:state.quality}}; const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`study-density-backup-${todayStr()}.json`; a.click();} if(e.target?.id==='imp'){const f=$('#impFile').files[0]; if(!f) return; const j=JSON.parse(await f.text()); for(const key of ['subjects','materials','labels','studyRecords','tests']) for(const item of (j[key]||[])) await addDoc(userCol(key==='studyRecords'?'studyRecords':key),item); if(j.settings?.quality) await setDoc(doc(db,`users/${state.uid}/settings/main`),{quality:j.settings.quality},{merge:true}); await refresh();} if(e.target?.id==='wipe'){if(!confirm('全削除します')) return; for(const key of ['subjects','materials','labels','studyRecords','tests','weeklyGoals']){const docs=(await getDocs(userCol(key))).docs; for(const d of docs) await deleteDoc(d.ref);} await refresh();}} , {once:true}); }

function switchScreen(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===id)); document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.screen===id)); if(id==='record') renderRecordForm(); if(id==='list') renderList(); if(id==='goals') renderGoals(); if(id==='settings') renderSettings(); if(id==='dashboard') renderDashboard(); }
async function refresh(){ await loadAll(); ['dashboard','record','list','goals','settings'].forEach(id=>{ if($('#'+id).classList.contains('active')) switchScreen(id); }); }

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
  if(!user){ state.uid=null; $('#app').hidden=true; $('#bottomNav').hidden=true; $('#loginBtn').hidden=false; return; }
  state.uid=user.uid; $('#app').hidden=false; $('#bottomNav').hidden=false; $('#loginBtn').hidden=true;
  await ensureSeedData(); await refresh(); switchScreen('dashboard');
});
if('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');
