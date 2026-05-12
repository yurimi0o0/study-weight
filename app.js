import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, getDocs, getDoc, addDoc, setDoc, updateDoc, deleteDoc, query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const APP_NAME = 'Study Density Log';
const DEFAULT_QUALITY = { S: 1.05, A: 1.0, B: 0.55, C: 0.3, D: 0.1 };
const DEFAULT_SUBJECTS = ['英語','数学','国語','社会','理科','情報','その他'];
const DEFAULT_LABELS = ['自習','学校','学校課題','塾','塾宿題','授業','単語帳','テスト勉強','受験勉強','その他'];

const firebaseConfig = {
  apiKey: 'REPLACE_ME', authDomain: 'REPLACE_ME', projectId: 'REPLACE_ME', storageBucket: 'REPLACE_ME', messagingSenderId: 'REPLACE_ME', appId: 'REPLACE_ME'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const state = { uid: null, subjects: [], materials: [], labels: [], records: [], tests: [], quality: { ...DEFAULT_QUALITY }, weekGoal: 0 };

const $ = s => document.querySelector(s);
const todayStr = () => new Date().toISOString().slice(0,10);
const nowTime = () => new Date().toTimeString().slice(0,5);
const mondayOf = (d = new Date()) => { const x=new Date(d); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); return x.toISOString().slice(0,10); };
const minFromTime = t => t ? (+t.slice(0,2))*60 + (+t.slice(3,5)) : null;
const calcMinutesByTime = (s,e)=> (s&&e) ? Math.max(0, minFromTime(e)-minFromTime(s)) : null;
const focusMinutes = r => Math.round((Number(r.minutes)||0) * (state.quality[r.quality] ?? 1));

function userCol(path){ return collection(db, `users/${state.uid}/${path}`); }
function userDoc(path,id){ return doc(db, `users/${state.uid}/${path}/${id}`); }

async function ensureSeedData(){
  if ((await getDocs(userCol('subjects'))).empty) for (const name of DEFAULT_SUBJECTS) await addDoc(userCol('subjects'), { name, color:'#26c6da', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
  if ((await getDocs(userCol('labels'))).empty) for (const name of DEFAULT_LABELS) await addDoc(userCol('labels'), { name, color:'#64b5f6', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
  const settingsRef = doc(db, `users/${state.uid}/settings/main`); if (!(await getDoc(settingsRef)).exists()) await setDoc(settingsRef, { quality: DEFAULT_QUALITY, appName: APP_NAME });
}
async function loadAll(){
  state.subjects=(await getDocs(query(userCol('subjects')))).docs.map(d=>({id:d.id,...d.data()}));
  state.materials=(await getDocs(query(userCol('materials')))).docs.map(d=>({id:d.id,...d.data()}));
  state.labels=(await getDocs(query(userCol('labels')))).docs.map(d=>({id:d.id,...d.data()}));
  state.records=(await getDocs(query(userCol('studyRecords'),orderBy('date','desc')))).docs.map(d=>({id:d.id,...d.data()}));
  state.tests=(await getDocs(query(userCol('tests'),orderBy('date','asc')))).docs.map(d=>({id:d.id,...d.data()}));
  const goals=(await getDocs(query(userCol('weeklyGoals'),orderBy('weekStartDate','desc')))).docs.map(d=>({id:d.id,...d.data()}));
  state.weekGoal=(goals.find(g=>g.weekStartDate===mondayOf())?.targetMinutes)||0;
  const settings=(await getDoc(doc(db,`users/${state.uid}/settings/main`))).data(); state.quality=settings?.quality || { ...DEFAULT_QUALITY };
}

function aggregate(){
  const t=todayStr(), w=mondayOf(), m=t.slice(0,7); let out={today:0,todayF:0,week:0,weekF:0,month:0,monthF:0,total:0,totalF:0};
  state.records.forEach(r=>{const min=+r.minutes||0,f=focusMinutes(r); out.total+=min; out.totalF+=f; if(r.date===t){out.today+=min;out.todayF+=f;} if(r.date>=w){out.week+=min;out.weekF+=f;} if((r.date||'').startsWith(m)){out.month+=min;out.monthF+=f;}});
  return out;
}
const fmtH = m => `${(m/60).toFixed(1)}h`;

function renderDashboard(){
  const a=aggregate(); const next=state.tests.filter(t=>t.date>=todayStr()).sort((x,y)=>x.date.localeCompare(y.date))[0];
  const days=next?Math.ceil((new Date(next.date)-new Date(todayStr()))/86400000):null;
  const latest7=[...Array(7)].map((_,i)=>{const d=new Date(); d.setDate(d.getDate()-(6-i)); return d.toISOString().slice(0,10);});
  const bars=latest7.map(d=>state.records.filter(r=>r.date===d).reduce((s,r)=>s+(+r.minutes||0),0));
  const max=Math.max(1,...bars);
  $('#dashboard').innerHTML=`<div class='card'><div class='grid'>${[['今日',a.today,a.todayF],['今週',a.week,a.weekF],['今月',a.month,a.monthF],['累計',a.total,a.totalF]].map(v=>`<div class='metric'><div>${v[0]}</div><div class='value'>${fmtH(v[1])}</div><div class='small'>集中 ${fmtH(v[2])}</div></div>`).join('')}</div></div>
  <div class='card'><div>今週目標: ${fmtH(state.weekGoal)} / 達成率 ${(state.weekGoal?Math.round(a.week/state.weekGoal*100):0)}%</div><div class='small'>次のテスト: ${next?`${next.name}（あと${days}日）`:'未登録'}</div></div>
  <div class='card'><h3>直近7日 学習推移（実時間）</h3><div class='bars'>${bars.map(v=>`<div class='bar' style='height:${Math.max(4,v/max*100)}%'></div>`).join('')}</div><div class='legend-row'><span>${latest7[0].slice(5)}</span><span>${latest7[6].slice(5)}</span></div></div>
  ${renderBreakdownCard('教科別', state.subjects.map(s=>[s.name,state.records.filter(r=>r.subjectId===s.id).reduce((x,r)=>x+(+r.minutes||0),0)]))}
  ${renderBreakdownCard('ラベル別', state.labels.map(l=>[l.name,state.records.filter(r=>(r.labelIds||[]).includes(l.id)).reduce((x,r)=>x+(+r.minutes||0),0)]))}
  ${renderBreakdownCard('質別', ['S','A','B','C','D'].map(q=>[q,state.records.filter(r=>r.quality===q).reduce((x,r)=>x+(+r.minutes||0),0)]))}`;
}
function renderBreakdownCard(title,pairs){
  const rows=pairs.filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]); const total=rows.reduce((s,[,v])=>s+v,0)||1;
  return `<div class='card'><h3>${title}</h3>${rows.map(([k,v])=>`<div class='legend-row'><span>${k}</span><span>${fmtH(v)} (${Math.round(v/total*100)}%)</span></div>`).join('')||'<div class="small">データなし</div>'}</div>`;
}

function renderRecordForm(edit=null){
  const r=edit||{date:todayStr(),startTime:'',endTime:nowTime(),minutes:'',subjectId:'',materialId:'',labelIds:[],quality:'A',pages:'',problems:'',memo:''};
  $('#record').innerHTML=`<div class='card'>
    <h3>${edit?'記録編集':'記録追加'}</h3>
    <label>日付</label><input id='fDate' type='date' value='${r.date}' />
    <div class='row'><div><label>開始</label><input id='fStart' type='time' value='${r.startTime||''}'/></div><div><label>終了</label><input id='fEnd' type='time' value='${r.endTime||''}'/></div></div>
    <label>分数</label><input id='fMinutes' type='number' min='1' value='${r.minutes||''}' />
    <div class='row'>${[15,30,45,60,90].map(m=>`<button class='btn qmin' data-min='${m}' type='button'>${m}分</button>`).join('')}</div>
    <label>教科</label><select id='fSubject'>${state.subjects.map(s=>`<option value='${s.id}' ${s.id===r.subjectId?'selected':''}>${s.name}</option>`).join('')}</select>
    <label>教材</label><select id='fMaterial'><option value=''>未選択</option>${state.materials.map(m=>`<option value='${m.id}' ${m.id===r.materialId?'selected':''}>${m.name}</option>`).join('')}</select>
    <label>ラベル(複数)</label><select id='fLabels' multiple size='5'>${state.labels.map(l=>`<option value='${l.id}' ${(r.labelIds||[]).includes(l.id)?'selected':''}>${l.name}</option>`).join('')}</select>
    <label>質</label><select id='fQuality'>${['S','A','B','C','D'].map(q=>`<option ${q===r.quality?'selected':''}>${q}</option>`).join('')}</select>
    <div class='row'><div><label>ページ数</label><input id='fPages' type='number' value='${r.pages||''}' /></div><div><label>問題数</label><input id='fProblems' type='number' value='${r.problems||''}' /></div></div>
    <label>メモ</label><textarea id='fMemo'>${r.memo||''}</textarea>
    <div class='row'><button id='saveRecord' class='btn primary'>保存</button>${edit?"<button id='cancelEdit' class='btn'>キャンセル</button>":''}</div>
  </div>`;
  document.querySelectorAll('.qmin').forEach(b=>b.onclick=()=>$('#fMinutes').value=b.dataset.min);
  const auto=()=>{const m=calcMinutesByTime($('#fStart').value,$('#fEnd').value); if(m) $('#fMinutes').value=m;}; $('#fStart').onchange=auto; $('#fEnd').onchange=auto;
  $('#saveRecord').onclick=async()=>{const data={date:$('#fDate').value,startTime:$('#fStart').value,endTime:$('#fEnd').value,minutes:+$('#fMinutes').value,subjectId:$('#fSubject').value,materialId:$('#fMaterial').value,labelIds:[...$('#fLabels').selectedOptions].map(o=>o.value),quality:$('#fQuality').value,pages:+($('#fPages').value||0),problems:+($('#fProblems').value||0),memo:$('#fMemo').value,updatedAt:new Date().toISOString()}; if(!data.minutes) return alert('分数は必須');
    if(edit) await updateDoc(userDoc('studyRecords',edit.id),data); else await addDoc(userCol('studyRecords'),{...data,createdAt:new Date().toISOString()});
    await refresh(); switchScreen('list');
  };
  if(edit) $('#cancelEdit').onclick=()=>renderRecordForm();
}

function renderList(){
  $('#list').innerHTML=`<div class='card'><div class='row'><input id='fltDate' type='date'/><select id='fltSubject'><option value=''>教科全て</option>${state.subjects.map(s=>`<option value='${s.id}'>${s.name}</option>`)}</select></div><div class='row'><select id='fltQuality'><option value=''>質全て</option>${['S','A','B','C','D'].map(q=>`<option>${q}</option>`)}</select><select id='fltLabel'><option value=''>ラベル全て</option>${state.labels.map(l=>`<option value='${l.id}'>${l.name}</option>`)}</select></div></div><div id='recordsWrap'></div>`;
  const draw=()=>{const d=$('#fltDate').value,s=$('#fltSubject').value,q=$('#fltQuality').value,l=$('#fltLabel').value;
    const rows=state.records.filter(r=>(!d||r.date===d)&&(!s||r.subjectId===s)&&(!q||r.quality===q)&&(!l||(r.labelIds||[]).includes(l)));
    $('#recordsWrap').innerHTML=rows.map(r=>`<div class='list-item'><b>${r.date}</b> ${subjectName(r.subjectId)} / ${materialName(r.materialId)||'教材未選択'}<br>${r.minutes}分（集中${focusMinutes(r)}分）質:${r.quality}<div class='tags'>${(r.labelIds||[]).map(id=>`<span class='tag'>${labelName(id)}</span>`).join('')}</div><div class='small'>${r.memo||''}</div><div class='row'><button class='btn edit' data-id='${r.id}'>編集</button><button class='btn danger del' data-id='${r.id}'>削除</button></div></div>`).join('')||'<div class="card">データなし</div>';
    document.querySelectorAll('.edit').forEach(b=>b.onclick=()=>{switchScreen('record');renderRecordForm(state.records.find(x=>x.id===b.dataset.id));});
    document.querySelectorAll('.del').forEach(b=>b.onclick=async()=>{if(confirm('削除しますか？')){await deleteDoc(userDoc('studyRecords',b.dataset.id)); await refresh();}});
  }; ['fltDate','fltSubject','fltQuality','fltLabel'].forEach(id=>$('#'+id).onchange=draw); draw();
}
const subjectName=id=>state.subjects.find(x=>x.id===id)?.name||'未設定';
const materialName=id=>state.materials.find(x=>x.id===id)?.name||'';
const labelName=id=>state.labels.find(x=>x.id===id)?.name||'不明';

function renderManage(){ $('#manage').innerHTML=`<div class='card'>${managerBlock('教科','subjects',state.subjects,true)}${managerBlock('教材','materials',state.materials,false,true)}${managerBlock('ラベル','labels',state.labels,true)}</div>`; bindManager(); }
function managerBlock(title,key,items,hasColor=false,hasSubject=false){ return `<h3>${title}</h3><div class='row'>${hasSubject?`<select id='new-${key}-subject'>${state.subjects.map(s=>`<option value='${s.id}'>${s.name}</option>`)}</select>`:''}<input id='new-${key}-name' placeholder='${title}名'/>${hasColor?"<input id='new-"+key+"-color' placeholder='#26c6da'/>":''}<button class='btn add' data-key='${key}'>追加</button></div>${items.map(i=>`<div class='list-item'>${i.name}<button class='btn danger delm' data-key='${key}' data-id='${i.id}'>削除</button></div>`).join('')}`; }
function bindManager(){ document.querySelectorAll('.add').forEach(b=>b.onclick=async()=>{const key=b.dataset.key; const name=$(`#new-${key}-name`).value.trim(); if(!name)return; const base={name,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; if(key==='materials') base.subjectId=$('#new-materials-subject').value; if(key!=='materials') base.color=$(`#new-${key}-color`)?.value||'#26c6da'; await addDoc(userCol(key),base); await refresh();});
  document.querySelectorAll('.delm').forEach(b=>b.onclick=async()=>{if(confirm('関連記録がある可能性があります。削除しますか？')){await deleteDoc(userDoc(b.dataset.key,b.dataset.id)); await refresh();}});
}
function renderGoals(){ $('#goals').innerHTML=`<div class='card'><h3>今週の目標</h3><input id='goalInput' type='number' value='${state.weekGoal||0}'/><button id='saveGoal' class='btn primary'>保存</button></div><div class='card'><h3>テスト登録</h3><input id='testName' placeholder='テスト名'/><input id='testDate' type='date'/><textarea id='testMemo' placeholder='メモ'></textarea><button id='addTest' class='btn'>追加</button>${state.tests.map(t=>`<div class='list-item'>${t.name} ${t.date}<button class='btn danger deltest' data-id='${t.id}'>削除</button></div>`).join('')}</div>`;
$('#saveGoal').onclick=async()=>{const weekStartDate=mondayOf(); const g=(await getDocs(query(userCol('weeklyGoals')))).docs.map(d=>({id:d.id,...d.data()})).find(x=>x.weekStartDate===weekStartDate); if(g) await updateDoc(userDoc('weeklyGoals',g.id),{targetMinutes:+$('#goalInput').value,updatedAt:new Date().toISOString()}); else await addDoc(userCol('weeklyGoals'),{weekStartDate,targetMinutes:+$('#goalInput').value,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); await refresh();};
$('#addTest').onclick=async()=>{await addDoc(userCol('tests'),{name:$('#testName').value,date:$('#testDate').value,memo:$('#testMemo').value,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); await refresh();};
document.querySelectorAll('.deltest').forEach(b=>b.onclick=async()=>{await deleteDoc(userDoc('tests',b.dataset.id)); await refresh();}); }
function renderSettings(){ $('#settings').innerHTML=`<div class='card'><h3>質係数</h3>${['S','A','B','C','D'].map(k=>`<label>${k}</label><input id='q-${k}' type='number' step='0.01' value='${state.quality[k]}'/>`).join('')}<button id='saveQ' class='btn primary'>保存</button></div><div class='card'><h3>バックアップ</h3><button id='exp' class='btn'>JSONエクスポート</button><input id='impFile' type='file' accept='application/json'/><button id='imp' class='btn'>JSONインポート</button><button id='wipe' class='btn danger'>全データ削除</button></div><div class='card small'>このアプリは、ログインした利用者の学習記録をFirebase Cloud Firestoreに保存し、PCとiPhoneなど複数端末で同期します。学習記録、教材名、メモなどのデータは、ログインした本人のデータとして保存されます。Firestore Security Rulesにより、各ユーザーは自分のデータのみ読み書きできる設計にしてください。なお、端末やブラウザ上にもPWAのキャッシュや一時データが保存される場合があります。必要に応じてJSONエクスポート機能でバックアップしてください。</div>`;
$('#saveQ').onclick=async()=>{const quality={}; ['S','A','B','C','D'].forEach(k=>quality[k]=+($(`#q-${k}`).value||1)); await setDoc(doc(db,`users/${state.uid}/settings/main`),{quality,appName:APP_NAME},{merge:true}); await refresh();};
$('#exp').onclick=()=>{const data={subjects:state.subjects,materials:state.materials,labels:state.labels,studyRecords:state.records,tests:state.tests,settings:{quality:state.quality}}; const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`study-density-backup-${todayStr()}.json`; a.click();};
$('#imp').onclick=async()=>{const f=$('#impFile').files[0]; if(!f) return; const j=JSON.parse(await f.text()); for(const key of ['subjects','materials','labels','studyRecords','tests']) for(const item of (j[key]||[])) await addDoc(userCol(key==='studyRecords'?'studyRecords':key),item); if(j.settings?.quality) await setDoc(doc(db,`users/${state.uid}/settings/main`),{quality:j.settings.quality},{merge:true}); await refresh();};
$('#wipe').onclick=async()=>{if(!confirm('全削除します')) return; for(const key of ['subjects','materials','labels','studyRecords','tests','weeklyGoals']){const docs=(await getDocs(userCol(key))).docs; for(const d of docs) await deleteDoc(d.ref);} await refresh();}; }

function switchScreen(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===id)); document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.screen===id)); if(id==='record') renderRecordForm(); if(id==='list') renderList(); if(id==='manage') renderManage(); if(id==='goals') renderGoals(); if(id==='settings') renderSettings(); if(id==='dashboard') renderDashboard(); }
async function refresh(){ await loadAll(); ['dashboard','record','list','manage','goals','settings'].forEach(id=>{ if($('#'+id).classList.contains('active')) switchScreen(id); }); }

$('#appTitle').textContent = APP_NAME;
$('#loginBtn').onclick=()=>signInWithRedirect(auth,new GoogleAuthProvider());
$('#logoutBtn').onclick=()=>signOut(auth);
document.querySelectorAll('.bottom-nav button').forEach(b=>b.onclick=()=>switchScreen(b.dataset.screen));
getRedirectResult(auth).catch((err) => {
  console.error('Redirect login failed:', err);
  alert('ログイン処理でエラーが発生しました。時間をおいて再試行してください。');
});
onAuthStateChanged(auth, async user=>{
  if(!user){ state.uid=null; $('#app').hidden=true; $('#bottomNav').hidden=true; $('#loginBtn').hidden=false; $('#logoutBtn').hidden=true; return; }
  state.uid=user.uid; $('#app').hidden=false; $('#bottomNav').hidden=false; $('#loginBtn').hidden=true; $('#logoutBtn').hidden=false;
  await ensureSeedData(); await refresh(); switchScreen('dashboard');
});
if('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');
