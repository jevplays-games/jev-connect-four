import {createInitialState,applyAction,getLegalActions,landingRow,replay,getOutcome,boardRows} from './rules.js';
import {moveMetrics,heuristicUtility,POLICY_VERSION} from './policy.js';
import {summarize,flattenEvidence,csv} from './analytics.js';
function uid(){if(crypto.randomUUID)return crypto.randomUUID();const a=crypto.getRandomValues(new Uint8Array(16));a[6]=(a[6]&15)|64;a[8]=(a[8]&63)|128;const h=[...a].map(x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
const $=id=>document.getElementById(id),fmt=(n,d=1)=>Number.isFinite(n)?n.toLocaleString(undefined,{maximumFractionDigits:d}):'—';
const pct=n=>Number.isFinite(n)?`${fmt(n*100,1)}%`:'—';
const ms=n=>Number.isFinite(n)?n>=1000?`${fmt(n/1000,2)} s`:`${fmt(n,0)} ms`:'—';
const make=(tag,className,text)=>{const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;};
function readStorage(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}
function store(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{notice('Browser storage is unavailable or full. The current game still works, but local history may not persist.');}}
let identity={user:null,contexts:[],jevConfigured:false,discordConfigured:false},csrf='',match=null,localExport=null;
let busy=false,selectedColumn=3,optimistic=null,requestId=0,liveAnalysis=null,leaderCursor=null,leaderRows=[];
let clientPerformance={longTaskCount:0,longTaskDurationMs:0,hiddenMs:0},hiddenStarted=null;
try{new PerformanceObserver(list=>{if($('telemetry-consent').checked&&match&&!isLocal()){for(const e of list.getEntries()){clientPerformance.longTaskCount++;clientPerformance.longTaskDurationMs+=e.duration;}}}).observe({type:'longtask',buffered:false});}catch{/* Browser does not expose long-task measurements. */}
document.addEventListener('visibilitychange',()=>{if(!$('telemetry-consent').checked||!match||isLocal())return;if(document.hidden)hiddenStarted=performance.now();else if(hiddenStarted!==null){clientPerformance.hiddenMs+=performance.now()-hiddenStarted;hiddenStarted=null;}});
let replayActions=[],replayHumanDisc=1,localHistory=readStorage('c4-local-history',[]),currentPage='play',pollTimer=null;
if(!Array.isArray(localHistory))localHistory=[];
const prefs=readStorage('c4-preferences',{}),worker=new Worker('/fallback-worker.js',{type:'module'}),workerJobs=new Map();
worker.onmessage=({data})=>{const job=workerJobs.get(data.id);if(!job)return;workerJobs.delete(data.id);clearTimeout(job.timer);data.error?job.reject(new Error(data.error)):job.resolve(data.decision);};
worker.onerror=()=>{for(const job of workerJobs.values()){clearTimeout(job.timer);job.reject(new Error('Local opponent worker failed.'));}workerJobs.clear();};
function askLocal(state,difficulty){return new Promise((resolve,reject)=>{const id=++requestId,timer=setTimeout(()=>{workerJobs.delete(id);reject(new Error('Local opponent exceeded its time budget.'));},15000);workerJobs.set(id,{resolve,reject,timer});worker.postMessage({id,state,difficulty});});}
function notice(text,info=false){$('notice').textContent=text;$('notice').classList.toggle('info',info);$('notice').hidden=!text;}
async function api(path,{method='GET',body,key}={}){
  const start=performance.now(),response=await fetch(path,{method,credentials:'same-origin',headers:method==='GET'?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf,...(key?{'Idempotency-Key':key}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw new Error('The server returned an unreadable response.');}
  if(!response.ok){const error=new Error(data.error||`Request failed (${response.status})`);error.code=data.error;error.details=data.details;error.status=response.status;throw error;}
  return {data,latency:performance.now()-start};
}
function errorMessage(error){const map={JEV_NOT_CONFIGURED:'JEV is not configured on this server. Local practice remains available.',DISCORD_NOT_CONFIGURED:'Discord is not configured on this server.',RATE_LIMITED:'The server usage limit was reached. Local practice remains available.',ACTIVE_RANKED_MATCH:'You have an active official match. Resume or resign that match before starting another.',CONTEXT_EXPIRED_OR_INVALID:'Community access expired. Use /play in the Discord channel to create a fresh launch.',LAUNCH_WRONG_DISCORD_USER:'Sign in with the Discord account that launched this game.',SESSION_REQUIRED:'Your session expired. Reload the page before continuing.',CSRF_REJECTED:'Your session changed. Reload the page before continuing.',STALE_MATCH:'The board changed in another request or tab. Resume to synchronize.'};return map[error.code]||error.message;}
function setBusy(value){busy=value;$('new-game').disabled=value;renderBoard();}
function isLocal(){return match?.local===true;}
function savePrefs(){store('c4-preferences',{difficulty:$('difficulty').value,mode:$('mode').value,analysis:$('show-analysis').checked,telemetry:$('telemetry-consent').checked});}
function syncControls(){const remote=$('mode').value==='jev';$('ranked').disabled=!remote||!identity.user;$('human-disc').disabled=remote&&$('ranked').checked;
  $('ranked-note').textContent=!remote?'Local practice stays on this device and never enters a leaderboard.':$('ranked').checked?'Official: server-assigned starting side · no undo · 24-hour deadline · resignation is a loss.':'Server-controlled JEV practice. Sign in and select Official match before starting to qualify for leaderboards.';savePrefs();}
async function refreshIdentity(){const {data}=await api('/api/me');identity=data;csrf=data.csrf;$('identity').textContent=data.user?.displayName||'Guest';$('human-name').textContent=data.user?.displayName||'You';$('login').hidden=!!data.user;$('logout').hidden=!data.user;$('login').disabled=!data.discordConfigured;$('login').title=data.discordConfigured?'Sign in with Discord':'Configure Discord client credentials on the server';$('operator-panel').hidden=!data.isAdmin;syncControls();return data;}
function renderBoard(){
  const start=performance.now(),s=optimistic||match?.state||createInitialState(),humanDisc=match?.humanDisc||Number($('human-disc').value);
  const active=match?.status==='active'&&s.status==='active',myTurn=active&&s.toMove===humanDisc&&!busy&&!optimistic;
  const cols=$('column-controls');if(!cols.children.length)for(let c=0;c<7;c++){const b=make('button','column-button',String(c+1));b.type='button';b.dataset.column=c;b.addEventListener('pointerenter',()=>{selectedColumn=c;renderBoard();});b.addEventListener('focus',()=>{if(selectedColumn!==c){selectedColumn=c;renderBoard();}});b.addEventListener('click',e=>drop(c,e.pointerType==='touch'?'touch':e.detail===0?'keyboard':'pointer'));cols.append(b);}
  [...cols.children].forEach((b,c)=>{b.disabled=!myTurn||s.board[35+c]!==0;b.classList.toggle('selected',selectedColumn===c);b.setAttribute('aria-label',`Drop disc in column ${c+1}${s.board[35+c]?' (full)':''}`);});
  drawBoard($('board'),s,humanDisc,myTurn?selectedColumn:null);
  const table=$('board-table');table.replaceChildren(make('caption',null,'Board, top row to bottom row'));
  const head=make('tr');for(let c=0;c<7;c++)head.append(make('th',null,`Col ${c+1}`));table.append(head);
  for(let r=5;r>=0;r--){const tr=make('tr');for(let c=0;c<7;c++){const v=s.board[r*7+c];tr.append(make('td',null,v===0?'Empty':v===humanDisc?'Human':'Opponent'));}table.append(tr);}
  let status=!match?'Ready to play':busy?(isLocal()?'Local opponent evaluating…':'Waiting for server…'):match.status==='interrupted'?'Service interrupted':match.status==='thinking'?'JEV turn pending':match.result==='win'?'You win':match.result==='loss'?(match.adjudication?'Match adjudicated':'Opponent wins'):match.result==='draw'?'Draw':myTurn?'Your turn':'Opponent’s turn';
  $('turn-label').textContent=status;$('move-count').textContent=String(s.ply).padStart(2,'0');
  $('opponent-name').textContent=isLocal()||!match?'Local practice':'JEV';$('opponent-subtitle').textContent=isLocal()||!match?'Not JEV':'With tactical safeguards';
  $('side-label').textContent=humanDisc===1?'You move first':'Opponent moves first';
  $('verification-badge').textContent=!match||isLocal()?'LOCAL PRACTICE':match.eligible?'VERIFIED RESULT':match.status==='interrupted'?'UNRANKED · INTERRUPTED':match.ranked?'OFFICIAL · IN PROGRESS':'SERVER PRACTICE';
  $('resign').disabled=busy||!match||match.status!=='active';$('continue-local').hidden=match?.status!=='interrupted';
  $('resume').hidden=!match||isLocal()||!['active','thinking'].includes(match.status);$('resume').disabled=busy;
  $('board-help').textContent=match?.state.lastMove?`${match.state.lastMove.disc===humanDisc?'Human':'Opponent'} placed a disc in column ${match.state.lastMove.column+1}, row ${match.state.lastMove.row+1}. ${status}.`:'Choose a column. Keyboard: 1–7 or arrow keys + Enter.';
  renderTimeline();return performance.now()-start;
}
function drawBoard(node,state,humanDisc,preview=null){node.replaceChildren();for(let r=5;r>=0;r--)for(let c=0;c<7;c++){const i=r*7+c,v=state.board[i],cell=make('div','cell');cell.dataset.row=r;cell.dataset.column=c;if(v)cell.classList.add(v===humanDisc?'disc-human':'disc-jev');if(state.winningCells?.includes(i))cell.classList.add('winning');if(state.lastMove?.row===r&&state.lastMove?.column===c)cell.classList.add('last');if(!v&&preview===c&&landingRow(state.board,c)===r)cell.classList.add('preview');node.append(cell);}}
function renderTimeline(){const el=$('move-timeline');el.replaceChildren();if(!match?.actions?.length){el.append(make('p','empty-state','Your match begins here.'));return;}match.actions.forEach((c,i)=>{const actor=(i%2===0?1:2)===match.humanDisc?'H':'J';const e=make('span',`move-chip ${actor==='H'?'human-chip':''}`,`${String(i+1).padStart(2,'0')} · ${actor} ${c+1}`);e.title=`Move ${i+1}: ${actor==='H'?'human':'opponent'} column ${c+1}`;el.append(e);});}
function renderDecision(d=match?.lastDecision){$('analysis-body').hidden=!$('show-analysis').checked;if(!d){$('analysis-title').textContent='Awaiting the first move';$('analysis-source').textContent='Evidence appears after the opponent acts.';$('candidate-count').textContent='—';$('eligible-count').textContent='—';$('decision-time').textContent='—';$('candidate-chart').replaceChildren(make('p','empty-state','No decisions yet.'));$('factor-list').replaceChildren(make('p','empty-state','Only returned structured judgments are shown.'));$('decision-json').textContent='No decision recorded.';return;}
  const local=d.source==='local',tactical=d.source==='tactical';$('analysis-title').textContent=`Column ${d.action.column+1} selected`;
  $('analysis-source').textContent=local?'Local heuristic · not JEV':tactical?'Engine-proven safeguard · no model call':`${d.model} · structured model evaluation`;
  $('candidate-count').textContent=d.candidateCount??d.candidates.length;$('eligible-count').textContent=d.eligibleCount??d.candidates.filter(c=>c.eligible).length;
  $('decision-time').textContent=ms((d.latencyMs||0)+(d.prepareMs||0));$('candidate-metric-label').textContent=local?'Heuristic score':tactical?'Tactical filter':'JEV utility';
  const chart=$('candidate-chart');chart.replaceChildren();const candidates=[...d.candidates].sort((a,b)=>a.column-b.column);
  const heuristic=candidates.map(heuristicUtility),hMin=Math.min(...heuristic),hMax=Math.max(...heuristic);
  for(const c of candidates){const selected=c.column===d.action.column,row=make('div',`candidate-row ${selected?'best':''} ${c.eligible?'':'excluded'}`);row.append(make('span',null,`C${c.column+1}`));
    const track=make('div','track'),bar=make('div','bar');const utility=d.ranked?.find(r=>r.column===c.column)?.utility;
    const value=local?heuristicUtility(c):utility;const width=!c.eligible?0:local?((value-hMin)/(hMax-hMin||1)*.85+.15):tactical?(selected?1:0):utility??0;
    bar.style.width=`${Math.max(0,Math.min(1,width))*100}%`;track.append(bar);row.append(track,make('span','value',!c.eligible?'pruned':tactical?'forced':fmt(value,local?0:3)));
    row.title=c.excludedReason||`Search interval [${c.search.bounds.join(', ')}], ${c.search.nodes} nodes`;chart.append(row);}
  const factors=$('factor-list');factors.replaceChildren();
  for(const [factor,a] of Object.entries(d.factors||{})){const row=make('div','factor-row'),label=make('div',null,factor[0].toUpperCase()+factor.slice(1));label.append(make('small',null,`Model judgment · certainty ${pct(a.confidence)}`));row.append(label,make('b',null,`${fmt(a.score,2)} / 4`));factors.append(row);}
  const selected=candidates.find(c=>c.column===d.action.column);
  for(const [label,value] of [['Human winning replies',selected?.humanWinningReplies.length??0],['Playable JEV threats',selected?.threats.self.filter(t=>t.playable).length??0],['Search nodes',selected?.search.nodes??0]]){const row=make('div','factor-row'),l=make('div',null,label);l.append(make('small',null,'Engine-computed fact'));row.append(l,make('b',null,fmt(value,0)));factors.append(row);}
  $('decision-json').textContent=JSON.stringify(d,null,2);
}
function localEvent(type,payload){localExport.events.push({schemaVersion:1,matchId:match.id,seq:localExport.events.length+1,type,utcMs:Date.now(),source:'local-unverified',payload});}
function persistLocal(){localExport.match={...localExport.match,state:match.state,actions:match.actions,status:match.status,result:match.result,adjudication:match.adjudication??null,finishedAt:match.finishedAt??null};localHistory=localHistory.filter(e=>e.match.id!==match.id);localHistory.push(localExport);localHistory=localHistory.slice(-20);store('c4-local-history',localHistory);}
function createLocal(actions=[],humanDisc=Number($('human-disc').value)){
  const state=replay(actions),id=`local-${uid()}`,difficulty=$('difficulty').value;
  match={id,local:true,state,actions:[...actions],humanDisc,difficulty,opponentVersion:`local-${POLICY_VERSION}-${difficulty}`,
    status:state.status==='active'?'active':'completed',result:getOutcome(state,humanDisc),ranked:false,eligible:false,startedAt:Date.now(),turnReadyAt:Date.now(),lastDecision:null};
  localExport={format:'local-practice-evidence/1',match:{...match,manifest:{model:null,provider:'local',policyVersion:POLICY_VERSION,inputUsdPerMillion:0},diagnosticEvidence:'local-unverified'},events:[]};
  localEvent('match.started',{source:'local',continuedFromActions:actions.length});persistLocal();
}
function localApply(column,actor,decisionId=null){const before=match.state,after=applyAction(before,{type:'drop',column});
  localEvent('move.accepted',{ply:after.ply,actor,column,row:after.lastMove.row,decisionId,
    turnElapsedMs:actor==='human'?Math.max(0,Date.now()-match.turnReadyAt):null,metrics:moveMetrics(before,after,column)});
  match.state=after;match.actions.push(column);match.result=getOutcome(after,match.humanDisc);
  if(after.status!=='active'){match.status='completed';match.finishedAt=Date.now();localEvent('match.completed',{result:match.result,plies:after.ply});}
  match.turnReadyAt=Date.now();persistLocal();
}
async function localOpponent(){if(!match||!isLocal()||match.state.status!=='active'||match.state.toMove===match.humanDisc)return;
  setBusy(true);const current=match.id;
  try{const decision=await askLocal(match.state,match.difficulty);if(match?.id!==current)return;const decisionId=uid();localEvent('decision.completed',{decisionId,ply:match.state.ply+1,decision});localApply(decision.action.column,'jev',decisionId);match.lastDecision=decision;persistLocal();renderDecision();}
  catch(error){notice(error.message);}finally{setBusy(false);}
}
async function startGame(){if(busy)return;notice('');clearTimeout(pollTimer);
  if(match?.ranked&&['active','thinking'].includes(match.status)){notice('An official match is still active. Resume or resign it before starting another game.');return;}
  setBusy(true);
  try{if($('mode').value==='local'){createLocal();renderDecision();setBusy(false);await localOpponent();return;}
    const {data}=await api('/api/matches',{method:'POST',key:uid(),body:{gameId:'connect-four',difficulty:$('difficulty').value,
      humanDisc:Number($('human-disc').value),ranked:$('ranked').checked,contextId:identity.contexts[0]?.id}});
    match=data;localExport=null;store('c4-active-server-match',match.id);renderDecision();checkRemoteStatus();
  }catch(error){notice(errorMessage(error));if(error.details?.matchId){store('c4-active-server-match',error.details.matchId);await resumeMatch(error.details.matchId);}}
  finally{setBusy(false);}
}
async function drop(column,inputMethod='pointer'){if(busy||!match||match.status!=='active'||match.state.toMove!==match.humanDisc)return;
  const started=performance.now();if(!getLegalActions(match.state).some(a=>a.column===column))return;
  if(isLocal()){localApply(column,'human');renderBoard();await localOpponent();return;}
  setBusy(true);optimistic=applyAction(match.state,{type:'drop',column});renderBoard();
  try{const {data,latency}=await api(`/api/matches/${match.id}/commands`,{method:'POST',key:uid(),body:{type:'drop',column,expectedRevision:match.revision,expectedStateHash:match.stateHash}});
    match=data;optimistic=null;const renderMs=renderBoard();renderDecision();checkRemoteStatus();
    if($('telemetry-consent').checked)sendTelemetry({requestMs:latency,renderMs,inputDelayMs:Math.max(0,performance.now()-started-latency-renderMs),inputMethod});
  }catch(error){optimistic=null;notice(`${errorMessage(error)} The move may already have been accepted. Use Resume match to synchronize.`);}
  finally{setBusy(false);}
}
async function sendTelemetry(metrics){if(!match||isLocal()||!$('telemetry-consent').checked)return;try{await api(`/api/matches/${match.id}/telemetry`,{method:'POST',body:{id:uid(),consent:true,...clientPerformance,...metrics,viewportWidth:innerWidth,viewportHeight:innerHeight}});clientPerformance={longTaskCount:0,longTaskDurationMs:0,hiddenMs:0};}catch{/* Optional telemetry never blocks play. */}}
function checkRemoteStatus(){clearTimeout(pollTimer);if(match?.status==='interrupted')notice(`JEV service interrupted (${match.interruption}). This result is not ranked. Continue as local practice to keep playing.`);
  if(match?.status==='thinking')pollTimer=setTimeout(async()=>{try{const {data}=await api(`/api/matches/${match.id}`);match=data;renderBoard();renderDecision();checkRemoteStatus();}catch{}},1500);
}
async function resumeMatch(id=match?.id||identity.activeMatchId||readStorage('c4-active-server-match',null)){if(!id)return;notice('');setBusy(true);try{let {data}=await api(`/api/matches/${id}`);match=data;localExport=null;
  if(data.status==='active'&&data.state.toMove!==data.humanDisc){data=(await api(`/api/matches/${id}/commands`,{method:'POST',key:uid(),body:{type:'resume'}})).data;match=data;}
  $('mode').value='jev';$('difficulty').value=match.difficulty;syncControls();renderDecision();checkRemoteStatus();
  }catch(error){notice(errorMessage(error));}finally{setBusy(false);}}
async function resign(){if(!match||busy||match.status!=='active')return;if(!confirm('Resign this match? Official matches record a loss.'))return;
  if(isLocal()){match.status='adjudicated';match.result='loss';match.adjudication='resigned';match.finishedAt=Date.now();localEvent('match.adjudicated',{result:'loss',adjudication:'resigned'});persistLocal();renderBoard();return;}
  setBusy(true);try{match=(await api(`/api/matches/${match.id}/commands`,{method:'POST',key:uid(),body:{type:'resign',expectedRevision:match.revision,expectedStateHash:match.stateHash}})).data;renderDecision();}catch(error){notice(errorMessage(error));}finally{setBusy(false);}}
function page(name){currentPage=name;for(const el of document.querySelectorAll('.page')){el.hidden=el.id!==`page-${name}`;el.classList.toggle('active',!el.hidden);}for(const b of document.querySelectorAll('[data-page]'))b.classList.toggle('active',b.dataset.page===name);
  if(name==='analytics')loadAnalytics();if(name==='leaderboard')loadLeaders();}
function download(content,name,type='application/json'){const url=URL.createObjectURL(new Blob([content],{type})),a=make('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function currentExport(){if(!match)throw new Error('Start a match first.');if(isLocal()){persistLocal();return structuredClone(localExport);}return (await api(`/api/matches/${match.id}/export`)).data;}
async function loadAnalytics(){try{let summary,tables=null,audit=null;
    if($('analytics-scope').value==='mine'){const {data}=await api('/api/analytics/me');summary=data.summary;$('analytics-coverage').textContent=`Server matches: ${data.sample.included} of ${data.sample.total}. ${data.sample.limited?'Limited to the most recent sample.':'All currently selected history included.'} Local practice is excluded.`;}
    else if(match){const exp=await currentExport();summary=summarize([exp]);tables=flattenEvidence([exp]);if(!isLocal())audit=(await api(`/api/matches/${match.id}/analytics`)).data.audit;
      $('analytics-coverage').textContent=isLocal()?'Local practice measurements · unverified · never part of official results.':`Match ${match.id.slice(0,8)} · ${summary.eventCount} audit events · ${match.difficulty} · ${match.humanDisc===1?'human':'JEV'} first.`;}
    else{summary=summarize([]);$('analytics-coverage').textContent='Start a match to collect analytics. No synthetic data is shown.';}
    liveAnalysis={summary,tables,audit};renderAnalytics(summary,tables,audit);
  }catch(error){notice(errorMessage(error));}}
function table(headers,records){const t=make('table'),thead=make('thead'),row=make('tr');headers.forEach(h=>row.append(make('th',null,h)));thead.append(row);t.append(thead);const tbody=make('tbody');for(const cells of records){const tr=make('tr');cells.forEach(c=>tr.append(make('td',null,String(c??'—'))));tbody.append(tr);}if(!records.length){const tr=make('tr'),td=make('td','empty-state','No observations in this view.');td.colSpan=headers.length;tr.append(td);tbody.append(tr);}t.append(tbody);return t;}
function pairs(node,items){const grid=make('div','data-pairs');for(const [label,value] of items){const row=make('div','data-pair');row.append(make('span',null,label),make('strong',null,String(value)));grid.append(row);}node.replaceChildren(grid);}
const NS='http://www.w3.org/2000/svg';function svgEl(tag,attrs={},text){const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;}
function latencyChart(node,values){node.replaceChildren();if(!values?.length){node.append(make('p','empty-state','No model-call timings recorded. Local and tactical decisions are not model calls.'));return;}
  const svg=svgEl('svg',{viewBox:'0 0 450 185',role:'img','aria-label':`Model latency across ${values.length} decisions`}),max=Math.max(...values,1),left=38,right=432,top=16,bottom=150;
  for(const f of [0,.5,1]){const y=bottom-f*(bottom-top);svg.append(svgEl('line',{x1:left,x2:right,y1:y,y2:y,class:'chart-axis'}),svgEl('text',{x:0,y:y+4,class:'chart-label'},fmt(max*f,0)));}
  const pts=values.map((v,i)=>[left+(right-left)*(values.length===1?.5:i/(values.length-1)),bottom-v/max*(bottom-top)]);
  svg.append(svgEl('polyline',{points:pts.map(p=>p.join(',')).join(' '),class:'chart-line'}));pts.forEach(([x,y],i)=>{const c=svgEl('circle',{cx:x,cy:y,r:3,class:'chart-point'});c.append(svgEl('title',{},`Decision ${i+1}: ${ms(values[i])}`));svg.append(c);});
  svg.append(svgEl('text',{x:left,y:177,class:'chart-label'},'Earlier decisions'),svgEl('text',{x:right,y:177,'text-anchor':'end',class:'chart-label'},'Later decisions'));node.append(svg);}
function columnChart(node,columns){const svg=svgEl('svg',{viewBox:'0 0 440 190',role:'img','aria-label':'Placements in each column, human and opponent'}),max=Math.max(...columns.human,...columns.jev,1);
  for(let c=0;c<7;c++){const x=32+c*58;for(const [j,key] of ['human','jev'].entries()){const h=columns[key][c]/max*125,b=svgEl('rect',{x:x+j*19,y:150-h,width:15,height:h,rx:3,class:`chart-${key}`});b.append(svgEl('title',{},`${key}, column ${c+1}: ${columns[key][c]}`));svg.append(b);}svg.append(svgEl('text',{x:x+16,y:176,'text-anchor':'middle',class:'chart-label'},`C${c+1}`));}
  svg.append(svgEl('line',{x1:22,x2:433,y1:150,y2:150,class:'chart-axis'}));node.replaceChildren(svg);}
function renderAnalytics(s,tables,audit){const kpis=[['Verified result rate',pct(s.outcomes.resultRate),`${s.outcomes.wins} W · ${s.outcomes.losses} L · ${s.outcomes.draws} D`],['Model decisions',fmt(s.jev.modelDecisions,0),`${s.jev.tacticalDecisions} tactical bypasses · ${s.jev.failedDecisions} failed`],['Median model latency',ms(s.latency.modelMs.p50),`p95 ${ms(s.latency.modelMs.p95)} · n=${s.latency.modelMs.n}`],['Known input tokens',fmt(s.jev.inputTokens,0),s.cost.allModelPricesConfigured?`Estimated input $${s.cost.estimatedInputUSD.toFixed(6)}`:'No priced model usage']];
  $('analytics-kpis').replaceChildren(...kpis.map(([label,value,note])=>{const card=make('div','kpi');card.append(make('span',null,label),make('strong',null,value),make('small',null,note));return card;}));
  latencyChart($('latency-chart'),tables?.decisions.filter(d=>d.source==='model').map(d=>d.latencyMs));columnChart($('column-chart'),s.columns);
  pairs($('latency-details'),[['Mean',ms(s.latency.modelMs.mean)],['p99',ms(s.latency.modelMs.p99)],['Preparation median',ms(s.latency.preparationMs.p50)],['Human wall-turn median',ms(s.latency.humanWallTurnMs.p50)]]);
  const heat=$('heatmap'),values=s.heatmap.human.map((v,i)=>v+s.heatmap.jev[i]),max=Math.max(...values,1);heat.replaceChildren();for(let r=5;r>=0;r--)for(let c=0;c<7;c++){const i=r*7+c,value=values[i],level=value?Math.max(1,Math.ceil(value/max*4)):0,cell=make('div',`heat-cell heat-${level}`,String(value));cell.title=`Row ${r+1}, column ${c+1}: human ${s.heatmap.human[i]}, opponent ${s.heatmap.jev[i]}`;heat.append(cell);}
  $('tactics-table').replaceChildren(table(['Metric','Human','Opponent'],[
    ['Immediate win opportunities',s.tactics.human.immediateWinOpportunities,s.tactics.jev.immediateWinOpportunities],['Win conversion',pct(s.tactics.human.immediateWinConversion),pct(s.tactics.jev.immediateWinConversion)],
    ['Missed immediate wins',s.tactics.human.missedImmediateWins,s.tactics.jev.missedImmediateWins],['Block rate',pct(s.tactics.human.blockRate),pct(s.tactics.jev.blockRate)],
    ['Avoidable immediate losses',s.tactics.human.avoidableImmediateLosses,s.tactics.jev.avoidableImmediateLosses],['Center preference',pct(s.tactics.human.centerMoveRate),pct(s.tactics.jev.centerMoveRate)]]));
  pairs($('reliability-table'),[['Provider attempts',s.jev.providerAttempts],['Retries',s.jev.retries],['Failed attempts',s.jev.failedAttempts],['Decision failure rate',pct(s.jev.failureRate)],
    ['Search nodes',fmt(s.jev.searchNodes,0)],['Budget-exhausted candidates',s.jev.searchBudgetExhaustedCandidates],['Mean model certainty',pct(s.jev.confidence.mean)],['Mean answer entropy',`${fmt(s.jev.entropyBits.mean,3)} bits`],
    ['Median utility gap',fmt(s.jev.utilityGap.p50,3)],['Structured questions',s.jev.questions],['Interrupted matches',s.outcomes.interrupted],['Audit events',s.eventCount],
    ['Known output tokens',s.jev.outputTokens],['Attempts with unknown billing',s.cost.attemptsWithUnknownBilling],['Local/practice completions',s.outcomes.practiceCompleted],['Median game length',`${fmt(s.latency.plies.p50,0)} plies`]]);
  $('cohort-table').replaceChildren(table(['Difficulty','Opponent version','Human starts','Mode','Matches','Verified','W / L / D','Result rate'],s.cohorts.map(c=>[c.difficulty,c.opponentVersion,c.humanDisc===1?'Yes':'No',c.mode,c.matches,c.verified,`${c.wins} / ${c.losses} / ${c.draws}`,pct(c.resultRate)])));
  $('audit-badge').textContent=audit?(audit.ok?'CHAIN + REPLAY VALID':'AUDIT INCOMPLETE / FAILED'):isLocal()?'LOCAL · NOT VERIFIED':'NOT CHECKED';
}
async function exportData(format){try{const exp=await currentExport(),name=match.id;if(format==='json')download(JSON.stringify(exp,null,2),`${name}-audit.json`);
  else if(format==='ndjson')download(exp.events.map(e=>JSON.stringify(e)).join('\n')+'\n',`${name}-events.ndjson`,'application/x-ndjson');
  else{const nameTable=$('export-table').value;download(csv(flattenEvidence([exp])[nameTable]),`${name}-${nameTable}.csv`,'text/csv;charset=utf-8');}}catch(error){notice(errorMessage(error));}}
async function loadLeaders(more=false){try{const scope=$('leader-scope').value,context=identity.contexts[0];if(scope!=='world'&&!context)throw new Error('Launch with /play from your Discord server or channel to verify this community context.');
  const q=new URLSearchParams({scope,difficulty:$('leader-difficulty').value,humanDisc:$('leader-side').value});
  if($('leader-version').value)q.set('opponentVersion',$('leader-version').value);if(context)q.set('contextId',context.id);if(more&&leaderCursor)q.set('cursor',leaderCursor);
  const {data}=await api('/api/leaderboard?'+q);leaderCursor=data.nextCursor;leaderRows=more?[...leaderRows,...data.rows]:data.rows;
  $('leader-table').replaceChildren(table(['Rank','Player','Games','W','L','D','Result rate','Streak','Best'],leaderRows.map(r=>[r.provisional?'Provisional':r.rank,r.displayName,r.games,r.wins,r.losses,r.draws,pct(r.resultRate),r.currentStreak,r.bestStreak])));
  $('leader-more').hidden=!leaderCursor;$('leader-context').textContent=`${data.scope.toUpperCase()} · ${data.difficulty} · ${data.humanDisc===1?'human':'JEV'} first · opponent ${data.opponentVersion||'not yet available'} · results as of ${new Date(data.asOf).toLocaleString()}`;
  const selected=$('leader-version').value;$('leader-version').replaceChildren(new Option('Latest available',''),...data.availableVersions.map(v=>new Option(v,v)));if(selected)$('leader-version').value=selected;
  }catch(error){$('leader-table').replaceChildren(make('p','empty-state',errorMessage(error)));$('leader-more').hidden=true;}}
function renderReplay(){const n=Number($('replay-slider').value),state=replay(replayActions.slice(0,n));drawBoard($('replay-board'),state,replayHumanDisc);$('replay-status').textContent=`Move ${n} of ${replayActions.length} · ${state.status}`;$('replay-text').textContent=boardRows(state,3-replayHumanDisc).join('\n')+'\n\nH = human · J = opponent · . = empty';}
function inspectReplay(){replayActions=[...(match?.actions||[])];replayHumanDisc=match?.humanDisc||1;$('replay-slider').max=replayActions.length;$('replay-slider').value=replayActions.length;renderReplay();$('replay-dialog').showModal();}
async function importReplay(file){if(!file)return;try{if(file.size>2e6)throw new Error('Replay file is too large.');const raw=JSON.parse(await file.text()),actions=raw.actions||raw.match?.actions;replay(actions);replayActions=actions;replayHumanDisc=raw.humanDisc||raw.match?.humanDisc||1;$('replay-slider').max=actions.length;$('replay-slider').value=0;renderReplay();}catch(error){$('replay-status').textContent=`Invalid replay: ${error.message}`;}}
for(const b of document.querySelectorAll('[data-page]'))b.addEventListener('click',()=>page(b.dataset.page));
$('new-game').addEventListener('click',startGame);$('resign').addEventListener('click',resign);$('resume').addEventListener('click',()=>resumeMatch());
$('continue-local').addEventListener('click',async()=>{const actions=[...match.actions],disc=match.humanDisc;clearTimeout(pollTimer);$('mode').value='local';createLocal(actions,disc);notice('Continued from the interrupted board as local practice. Earlier remote decisions are preserved only in the original server match.',true);syncControls();renderBoard();renderDecision();await localOpponent();});
for(const id of ['mode','difficulty','human-disc','ranked'])$(id).addEventListener('change',syncControls);
$('show-analysis').addEventListener('change',()=>{savePrefs();renderDecision();});$('telemetry-consent').addEventListener('change',()=>{clientPerformance={longTaskCount:0,longTaskDurationMs:0,hiddenMs:0};hiddenStarted=null;savePrefs();});
$('login').addEventListener('click',()=>{location.href='/api/auth/discord';});$('logout').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST',body:{}});if(match&&!isLocal()){match=null;localExport=null;renderBoard();renderDecision();}localStorage.removeItem('c4-active-server-match');await refreshIdentity();notice('Signed out. Server matches remain associated with your account.',true);}catch(e){notice(errorMessage(e));}});
for(const [button,dialog] of [['rules-open','rules-dialog'],['privacy-open','privacy-dialog']])$(button).addEventListener('click',()=>$(dialog).showModal());
for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>$(b.dataset.close).close());
$('inspect-replay').addEventListener('click',inspectReplay);$('replay-slider').addEventListener('input',renderReplay);$('import-replay').addEventListener('change',e=>importReplay(e.target.files[0]));
$('export-replay').addEventListener('click',()=>{if(!match){notice('Start a match first.');return;}download(JSON.stringify({format:'jev-arcade-replay/1',game:'connect-four',rulesVersion:1,columnIndexBase:0,humanDisc:match.humanDisc,opponentVersion:match.opponentVersion,actions:match.actions,end:{outcome:match.result,adjudication:match.adjudication??null}},null,2),`${match.id}-replay.json`);});
$('refresh-analytics').addEventListener('click',loadAnalytics);$('analytics-scope').addEventListener('change',loadAnalytics);
$('export-audit').addEventListener('click',()=>exportData('json'));$('export-events').addEventListener('click',()=>exportData('ndjson'));$('export-csv').addEventListener('click',()=>exportData('csv'));
$('load-leaders').addEventListener('click',()=>loadLeaders());$('leader-more').addEventListener('click',()=>loadLeaders(true));
$('clear-local').addEventListener('click',()=>{if(confirm('Delete the local practice history on this device?')){localHistory=[];localStorage.removeItem('c4-local-history');if(isLocal()){match=null;localExport=null;renderBoard();renderDecision();}$('privacy-dialog').close();notice('Local practice history cleared.',true);}});
$('delete-account').addEventListener('click',async()=>{if(!identity.user){notice('Sign in to delete account-linked server data.');return;}if(prompt('Type DELETE to permanently remove your account, matches, and diagnostics.')!=='DELETE')return;try{await api('/api/me',{method:'DELETE',body:{confirm:'DELETE'}});match=null;localStorage.removeItem('c4-active-server-match');await refreshIdentity();renderBoard();$('privacy-dialog').close();notice('Account-linked server data deleted.',true);}catch(e){notice(errorMessage(e));}});
$('load-operator').addEventListener('click',async()=>{try{$('operator-json').textContent=JSON.stringify((await api('/api/analytics/operator')).data,null,2);}catch(e){notice(errorMessage(e));}});
document.addEventListener('keydown',event=>{if(currentPage!=='play'||document.querySelector('dialog[open]')||['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName)||event.ctrlKey||event.metaKey||event.altKey)return;
  if(/^[1-7]$/.test(event.key)){event.preventDefault();selectedColumn=Number(event.key)-1;drop(selectedColumn,'keyboard');}
  else if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();selectedColumn=(selectedColumn+(event.key==='ArrowRight'?1:6))%7;renderBoard();$('column-controls').children[selectedColumn].focus();}
  else if((event.key==='Enter'||event.key===' ')&&(event.target.closest('#column-controls')||event.target===document.body||event.target.id==='game')){event.preventDefault();drop(selectedColumn,'keyboard');}});
async function init(){if(['easy','normal','hard','jev'].includes(prefs.difficulty))$('difficulty').value=prefs.difficulty;$('show-analysis').checked=prefs.analysis!==false;$('telemetry-consent').checked=prefs.telemetry===true;
  const fragment=new URLSearchParams(location.hash.slice(1)),launch=fragment.get('launch');if(launch)history.replaceState(null,'',location.pathname+location.search);
  renderBoard();renderDecision();
  try{await refreshIdentity();$('mode').value=identity.jevConfigured?(prefs.mode==='local'?'local':'jev'):'local';syncControls();
    if(launch){const {data}=await api('/api/context/redeem',{method:'POST',body:{ticket:launch}});if(data.requiresLogin)notice('Community launch staged. Connect the same Discord account to verify the server and channel.',true);else{await refreshIdentity();notice('Discord community context verified for this launch.',true);}}
    else if(!identity.jevConfigured)notice('Local practice is ready. Configure the server’s TypeSafe key to enable real JEV; Discord credentials enable official results.',true);
    if(identity.activeMatchId)await resumeMatch(identity.activeMatchId);
  }catch(error){notice(`Local practice is available. ${errorMessage(error)}`);}
  if(!match){const recent=localHistory.at(-1);if(recent?.match?.status==='active'){try{replay(recent.match.actions);localExport=recent;match={...recent.match,local:true,turnReadyAt:Date.now()};renderBoard();renderDecision();await localOpponent();}catch{/* Invalid local storage never affects authoritative state. */}}}
  if(new URLSearchParams(location.search).get('auth')==='denied')notice('Discord sign-in was cancelled. Guest practice remains available.');
  await autoStart();
}
/* Auto-start: the board is playable as soon as the page is, with no click.
   It runs last and only when `match` is still empty, so a server match resumed
   by activeMatchId and an unfinished local game restored from history both win
   over starting a new one -- a reload rejoins, it never opens a second match.
   Ranked is taken only when the checkbox is actually enabled, which is the same
   gate the player faces by hand (JEV mode AND signed in). With no JEV key
   $('mode') is pinned to 'local' above and startGame() routes to createLocal(),
   so an auto-started game is never relabeled as JEV. */
async function autoStart(){
  if(match||busy)return;
  $('ranked').checked=!$('ranked').disabled;syncControls();
  try{await startGame();}catch(error){notice(errorMessage(error));}
}
init();
