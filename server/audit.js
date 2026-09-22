import {createInitialState,applyAction,getOutcome,boardRows} from '../public/rules.js';
import {canonical,sha256} from './util.js';
import {GENESIS} from './db.js';
import {validateResponse,rankAnswers} from './jev.js';
/** Offline verification uses recorded evidence only. It never contacts JEV or Discord. */
export async function auditExport(exp) {
  const errors=[],checks={hashChain:false,rules:false,decisionProvenance:false,outcome:false},m=exp.match;
  if(!m||!Array.isArray(exp.events))return {ok:false,checks,errors:['INVALID_EXPORT']};
  if(m.diagnosticEvidence==='pruned')return {ok:false,checks,errors:['DIAGNOSTIC_EVIDENCE_PRUNED'],replayOnly:true};
  let prev=GENESIS,seq=0,state=createInitialState();const actions=[],plans=new Map(),decisions=new Map();
  const acceptedDecisions=new Set();
  for(const e of exp.events) {
    const {hash,...body}=e;
    if(e.matchId!==m.id||e.seq!==++seq||e.prevHash!==prev||await sha256(canonical(body))!==hash)errors.push(`CHAIN_${seq}`);
    prev=hash;
    const p=e.payload;
    if(e.type==='match.started') {
      if(seq!==1||canonical(p.manifest)!==canonical(m.manifest)||p.humanDisc!==m.humanDisc||p.ranked!==m.ranked)
        errors.push('MANIFEST_MISMATCH');
    }
    if(e.type==='decision.prepared') {
      if(plans.has(p.decisionId))errors.push('DUPLICATE_DECISION_ID');
      plans.set(p.decisionId,p);
      if(await sha256(canonical(p.plan.request))!==p.plan.requestHash)errors.push('REQUEST_HASH');
      if(p.plan.model!==m.manifest.model||p.plan.policyVersion!==m.manifest.policyVersion||canonical(p.plan.profile)!==canonical(m.manifest.profile))errors.push('OPPONENT_VERSION');
      if(canonical(p.plan.request.state.boardTopToBottom)!==canonical(boardRows(state,state.toMove)))errors.push('REQUEST_BOARD_MISMATCH');
      if(p.ply!==state.ply+1||state.toMove===m.humanDisc)errors.push('PREPARE_WRONG_TURN');
    }
    if(e.type==='decision.completed') {
      const pre=plans.get(p.decisionId),d=p.decision;
      if(!pre) {errors.push('MISSING_PREPARATION');continue;}
      if(decisions.has(p.decisionId))errors.push('DUPLICATE_DECISION_RESULT');
      decisions.set(p.decisionId,d);
      if(!pre.plan.eligible.includes(`c${d.action.column}`))errors.push('INELIGIBLE_ACTION');
      if(d.requestHash!==pre.plan.requestHash)errors.push('DECISION_REQUEST_HASH');
      if(d.source==='model') {
        try {
          const response=validateResponse(d.response,pre.plan.request),ranked=rankAnswers(pre.plan,response);
          if(ranked[0].column!==d.action.column)errors.push('RANKING_MISMATCH');
          if(await sha256(canonical(response))!==d.responseHash)errors.push('RESPONSE_HASH');
        }catch{errors.push('INVALID_RECORDED_RESPONSE');}
      } else if(d.source==='tactical') {
        if(pre.plan.eligible.length!==1||pre.plan.needsModel)errors.push('INVALID_TACTICAL_BYPASS');
      } else errors.push('UNVERIFIED_OPPONENT_SOURCE');
    }
    if(e.type==='move.accepted') {
      if(p.ply!==state.ply+1)errors.push('MOVE_ORDER');
      if((state.toMove===m.humanDisc?'human':'jev')!==p.actor)errors.push('ACTOR_ORDER');
      if(await sha256(canonical(state))!==p.preStateHash)errors.push('PRE_STATE_HASH');
      if(p.actor==='jev') {
        const d=decisions.get(p.decisionId);
        if(!d||d.action.column!==p.column||acceptedDecisions.has(p.decisionId))errors.push('MOVE_PROVENANCE');
        acceptedDecisions.add(p.decisionId);
      }
      try {state=applyAction(state,{type:'drop',column:p.column});actions.push(p.column);
        if(state.lastMove.row!==p.row||await sha256(canonical(state))!==p.postStateHash)errors.push('POST_STATE_HASH');}
      catch{errors.push('ILLEGAL_MOVE');}
    }
  }
  if(seq!==m.eventSeq||prev!==m.eventHead)errors.push('CHAIN_TIP_OR_LENGTH');
  if(canonical(actions)!==canonical(m.actions)||canonical(state)!==canonical(m.state))errors.push('FINAL_STATE');
  const boardResult=getOutcome(state,m.humanDisc);
  if(m.status==='completed'&&(!boardResult||boardResult!==m.result))errors.push('RESULT');
  if(m.status==='adjudicated'&&(state.status!=='active'||m.result!=='loss'||!['resigned','deadline'].includes(m.adjudication)))errors.push('ADJUDICATION');
  if(m.status==='interrupted'&&(m.eligible||m.result))errors.push('INTERRUPTED_RANKING');
  checks.hashChain=!errors.some(e=>/CHAIN|MANIFEST/.test(e));
  checks.rules=!errors.some(e=>/STATE|MOVE_ORDER|ACTOR_ORDER|ILLEGAL/.test(e));
  checks.decisionProvenance=!errors.some(e=>/DECISION|PREPAR|REQUEST|RESPONSE|OPPONENT|INELIGIBLE|RANKING|TACTICAL|PROVENANCE/.test(e));
  checks.outcome=!errors.some(e=>/RESULT|ADJUDICATION|INTERRUPTED/.test(e));
  return {ok:!errors.length,checks,errors,eventCount:seq,moves:actions.length,replayHash:await sha256(canonical([
    'connect-four',1,m.opponentVersion,m.humanDisc,actions])),
    limitation:'Checks internal consistency against the recorded database tip; not an independently signed attestation.'};
}
