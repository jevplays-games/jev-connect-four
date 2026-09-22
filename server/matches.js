import {createInitialState,applyAction,replay,getOutcome} from '../public/rules.js';
import {profileFor,moveMetrics,POLICY_VERSION} from '../public/policy.js';
import {prepareDecision,executeDecision} from './jev.js';
import {one,rows,loadMatch,loadEvents,insertMatch,commitMatch,chainEvents,consumeQuota,countOperation} from './db.js';
import {assert,HttpError,canonical,sha256,now,randomToken,safeConfig,hmac} from './util.js';
import {contextFor} from './auth.js';
import {auditExport} from './audit.js';
export async function ownedMatch(env,session,id) {
  const m=await loadMatch(env,id);
  assert((m.user_id&&m.user_id===session.user_id)||(!m.user_id&&m.guest_session===session.token_hash),404,'MATCH_NOT_FOUND');
  return m;
}
export function viewMatch(row) {
  const d=row.data;
  return {id:d.id,state:d.state,stateHash:d.stateHash,revision:d.state.ply,actions:d.actions,
    humanDisc:d.humanDisc,difficulty:d.difficulty,opponentVersion:d.opponentVersion,
    status:d.status,result:d.result??null,adjudication:d.adjudication??null,ranked:d.ranked,eligible:!!d.eligible,
    startedAt:d.startedAt,finishedAt:d.finishedAt??null,deadlineAt:d.deadlineAt,
    community:d.guildId?{guildId:d.guildId,channelId:d.channelId}:null,
    lastDecision:d.lastDecision??null,interruption:d.interruption??null,
    pending:d.pending?{decisionId:d.pending.id,expiresAt:d.pending.expiresAt}:null,
    verification:d.verification??null,eventCount:row.event_seq,eventHead:row.event_head};
}
export function exportMatch(row,events,clientMetrics=[]) {
  const d=row.data;
  return {format:'jev-connect-four-audit/1',exportedAt:new Date().toISOString(),match:{id:d.id,manifest:d.manifest,
    state:d.state,actions:d.actions,humanDisc:d.humanDisc,difficulty:d.difficulty,opponentVersion:d.opponentVersion,
    status:d.status,result:d.result??null,adjudication:d.adjudication??null,ranked:d.ranked,eligible:!!d.eligible,
    startedAt:d.startedAt,finishedAt:d.finishedAt??null,eventSeq:row.event_seq,eventHead:row.event_head,
    diagnosticEvidence:d.diagnosticEvidence||'retained'},events,clientMetrics};
}
async function finalize(env,current,data,events,adjudication=null) {
  data.status=adjudication?'adjudicated':'completed';data.result=adjudication?'loss':getOutcome(data.state,data.humanDisc);
  assert(data.result,500,'NONTERMINAL_FINALIZATION');
  data.adjudication=adjudication;data.finishedAt=now(env);data.pending=null;
  events.push({type:adjudication?'match.adjudicated':'match.completed',payload:{result:data.result,adjudication,plies:data.state.ply}});
  // Verify the prospective action/provenance history BEFORE it becomes leaderboard-eligible.
  const existing=await loadEvents(env,current.id),chained=await chainEvents(current.id,current.event_seq,current.event_head,events,now(env));
  const prospective={...current,data,event_seq:chained.seq,event_head:chained.head};
  const audit=await auditExport(exportMatch(prospective,[...existing,...chained.events]));
  assert(audit.ok,500,'VERIFICATION_FAILED',{errors:audit.errors});
  data.verification=audit;data.eligible=!!data.ranked&&!!data.userId;
  events.push({type:'match.verified',payload:{eligible:data.eligible,checks:audit.checks,replayHash:audit.replayHash}});
}
async function addMove(env,data,column,actor,decisionId=null) {
  const before=data.state,after=applyAction(before,{type:'drop',column});
  const preStateHash=data.stateHash,postStateHash=await sha256(canonical(after));
  const move={ply:after.ply,actor,column,row:after.lastMove.row,decisionId,preStateHash,postStateHash,
    turnElapsedMs:actor==='human'?Math.max(0,now(env)-data.humanTurnReadyAt):null,
    metrics:moveMetrics(before,after,column)};
  data.state=after;data.stateHash=postStateHash;data.actions.push(column);
  if(after.status==='active'&&after.toMove===data.humanDisc)data.humanTurnReadyAt=now(env);
  return {type:'move.accepted',payload:move};
}
export async function createMatch(env,session,body,key,request) {
  const difficulty=body.difficulty||'normal';try{profileFor(difficulty);}catch{throw new HttpError(400,'INVALID_DIFFICULTY');}
  assert(body.ranked===undefined||typeof body.ranked==='boolean',400,'INVALID_RANKED_FLAG');
  assert(!body.gameId||body.gameId==='connect-four',400,'UNSUPPORTED_GAME');
  const ranked=body.ranked===true;
  assert(!ranked||session.user_id,401,'DISCORD_LOGIN_REQUIRED');
  assert(env.TYPESAFE_API_KEY,503,'JEV_NOT_CONFIGURED');
  const createHash=await sha256(canonical(body)),ownerField=session.user_id?'user_id':'guest_session',owner=session.user_id||session.token_hash;
  const existing=await one(env,`SELECT id,create_hash FROM matches WHERE ${ownerField}=? AND create_key=?`,owner,key);
  if(existing){assert(existing.create_hash===createHash,409,'IDEMPOTENCY_CONFLICT');return ownedMatch(env,session,existing.id);}
  if(ranked) {
    const active=await one(env,"SELECT id FROM matches WHERE user_id=? AND ranked=1 AND status IN ('active','thinking')",session.user_id);
    if(active){await expireMatch(env,await loadMatch(env,active.id));const check=await loadMatch(env,active.id);
      assert(!['active','thinking'].includes(check.data.status),409,'ACTIVE_RANKED_MATCH',{matchId:active.id});}
  }
  const context=body.contextId?await contextFor(env,session,body.contextId):null;
  const today=new Date(now(env)).toISOString().slice(0,10);
  const address=request?.headers.get('cf-connecting-ip')||request?.headers.get('x-local-address')||'unavailable';
  const bucket=await hmac(env.APP_SECRET,`quota:${today}:${session.user_id||address}`);
  await consumeQuota(env,bucket,'match_start',Number(session.user_id?env.USER_DAILY_MATCH_LIMIT||30:env.GUEST_DAILY_MATCH_LIMIT||3),now(env)+2*86400000);
  const config=safeConfig(env);
  assert(/^jev-\d+\.\d+\.\d+$/.test(config.model),503,'PINNED_JEV_MODEL_REQUIRED');
  const profile=profileFor(difficulty),manifest={schemaVersion:1,rulesVersion:1,policyVersion:POLICY_VERSION,
    difficulty,profile,model:config.model,inputUsdPerMillion:config.inputUsdPerMillion,outputUsdPerMillion:config.outputUsdPerMillion,
    appVersion:config.appVersion,provider:'typesafe',remoteDecisionBudgetMs:3000,prng:'none-in-gameplay',tieOrder:[3,2,4,1,5,0,6]};
  const {inputUsdPerMillion,outputUsdPerMillion,...opponentConfig}=manifest;
  const opponentVersion=(await sha256(canonical(opponentConfig))).slice(0,20);
  const humanDisc=ranked?1+(crypto.getRandomValues(new Uint8Array(1))[0]&1):(body.humanDisc===2?2:1);
  const state=createInitialState(),timestamp=now(env);
  const data={id:crypto.randomUUID(),userId:session.user_id||null,guestSession:session.user_id?null:session.token_hash,
    state,stateHash:await sha256(canonical(state)),actions:[],humanDisc,difficulty,manifest,opponentVersion,
    ranked,eligible:false,guildId:context?.guild_id||null,channelId:context?.channel_id||null,
    contextVerifiedAt:context?.verified_at||null,status:'active',result:null,startedAt:timestamp,
    deadlineAt:timestamp+86400000,humanTurnReadyAt:timestamp,diagnosticEvidence:'retained'};
  let stored;
  try{stored=await insertMatch(env,data,key,createHash);}catch(e){
    if(/UNIQUE/i.test(e.message)) {
      const row=await one(env,`SELECT id,create_hash FROM matches WHERE ${ownerField}=? AND create_key=?`,owner,key);
      if(row){assert(row.create_hash===createHash,409,'IDEMPOTENCY_CONFLICT');return loadMatch(env,row.id);}
      throw new HttpError(409,'ACTIVE_RANKED_MATCH');
    }throw e;
  }
  await countOperation(env,'match_started');
  return stored.data.state.toMove!==humanDisc?driveOpponent(env,stored):stored;
}
async function interrupt(env,current,reason,attempts=[],elapsed=null) {
  const data=structuredClone(current.data),pending=data.pending;
  data.status='interrupted';data.eligible=false;data.result=null;data.finishedAt=now(env);
  data.interruption=reason;data.pending=null;
  const events=[];
  if(pending)events.push({type:'decision.failed',payload:{decisionId:pending.id,ply:data.state.ply+1,errorCode:reason,attempts,latencyMs:elapsed}});
  events.push({type:'service.interrupted',payload:{reason,practiceContinuationAllowed:true}});
  return commitMatch(env,current,data,events);
}
export async function driveOpponent(env,current) {
  if(current.data.status==='thinking')return current;
  if(current.data.status!=='active'||current.data.state.toMove===current.data.humanDisc)return current;
  const preparedAt=performance.now(),data=structuredClone(current.data);
  const plan=await prepareDecision(data.state,data.difficulty,data.manifest.model);
  const pending={id:crypto.randomUUID(),lease:randomToken(16),expiresAt:now(env)+15000,plan};
  data.pending=pending;data.status='thinking';
  current=await commitMatch(env,current,data,[{type:'decision.prepared',payload:{decisionId:pending.id,ply:data.state.ply+1,plan}}]);
  let decision;
  try {
    decision=await executeDecision(plan,env,{beforeAttempt:async()=>{
      const day=new Date(now(env)).toISOString().slice(0,10);
      await consumeQuota(env,day,'provider_attempt_budget',Number(env.GLOBAL_DAILY_JEV_CALL_LIMIT||3000),now(env)+2*86400000);
    }});
  } catch(error) {
    const fresh=await loadMatch(env,current.id);
    if(fresh.data.pending?.lease!==pending.lease)return fresh;
    return interrupt(env,fresh,error.code||'JEV_UNAVAILABLE',error.attempts||[],performance.now()-preparedAt);
  }
  const fresh=await loadMatch(env,current.id);
  if(fresh.data.pending?.lease!==pending.lease)return fresh;
  if(fresh.data.pending.expiresAt<=now(env))return interrupt(env,fresh,'DECISION_LEASE_EXPIRED',decision.attempts||[]);
  const next=structuredClone(fresh.data),events=[{type:'decision.completed',payload:{decisionId:pending.id,ply:next.state.ply+1,decision}}];
  assert(plan.eligible.includes(`c${decision.action.column}`),500,'INELIGIBLE_JEV_MOVE');
  events.push(await addMove(env,next,decision.action.column,'jev',pending.id));
  const {response,...displayDecision}=decision;
  next.lastDecision=displayDecision;next.pending=null;next.status='active';
  if(next.state.status!=='active')await finalize(env,fresh,next,events);
  return commitMatch(env,fresh,next,events);
}
export async function expireMatch(env,row) {
  if(row.data.status==='thinking'&&row.data.pending.expiresAt<=now(env))return interrupt(env,row,'DECISION_LEASE_EXPIRED');
  if(row.data.status==='active'&&row.data.deadlineAt<=now(env)) {
    const data=structuredClone(row.data),events=[];
    await finalize(env,row,data,events,'deadline');return commitMatch(env,row,data,events);
  }
  return row;
}
export async function commandMatch(env,session,id,body,key) {
  let current=await ownedMatch(env,session,id);
  const requestHash=await sha256(canonical(body));
  const prior=await one(env,'SELECT * FROM commands WHERE match_id=? AND command_key=?',id,key);
  if(prior){assert(prior.request_hash===requestHash,409,'IDEMPOTENCY_CONFLICT');return expireMatch(env,current);}
  current=await expireMatch(env,current);
  assert(['drop','resume','resign'].includes(body.type),400,'INVALID_COMMAND');
  if(body.type==='resume')return driveOpponent(env,current);
  assert(current.data.status==='active',409,'MATCH_NOT_ACTIVE');
  assert(body.expectedRevision===current.data.state.ply&&body.expectedStateHash===current.data.stateHash,409,'STALE_MATCH');
  const data=structuredClone(current.data),events=[];
  if(body.type==='resign')await finalize(env,current,data,events,'resigned');
  else {
    assert(data.state.toMove===data.humanDisc,409,'NOT_YOUR_TURN');
    try{events.push(await addMove(env,data,body.column,'human'));}catch(e){throw new HttpError(400,e.message);}
    if(data.state.status!=='active')await finalize(env,current,data,events);
  }
  current=await commitMatch(env,current,data,events,{key,hash:requestHash});
  return driveOpponent(env,current);
}
