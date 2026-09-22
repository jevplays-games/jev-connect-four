import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createInitialState,replay,getLegalActions,applyAction,getOutcome} from '../public/rules.js';
import {localDecision,moveMetrics,profileFor,POLICY_VERSION} from '../public/policy.js';
import {prepareDecision,executeDecision} from '../server/jev.js';
import {chainEvents,GENESIS} from '../server/db.js';
import {canonical,sha256} from '../server/util.js';
import {summarize,flattenEvidence,csv,distribution} from '../public/analytics.js';
import {solveEndgame} from './oracle.mjs';
function arg(name,fallback){const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1];}
const pairs=Number(arg('pairs','10')),seed=Number(arg('seed','20260922')),difficulty=arg('difficulty','normal');
const policy=arg('policy','local'),opponent=arg('opponent','random'),out=resolve(arg('out','bench/output'));
const noSafeguards=process.argv.includes('--no-safeguards'),oracleEmpty=Number(arg('oracle-empty','8'));
if(!Number.isInteger(pairs)||pairs<1||pairs>1000||!Number.isInteger(seed))throw new Error('Use --pairs 1..1000 and an integer --seed.');
if(!['local','jev','random'].includes(policy)||!['random','heuristic','search','jev'].includes(opponent))throw new Error('Unsupported policy or opponent.');
if(!Number.isInteger(oracleEmpty)||oracleEmpty<0||oracleEmpty>10)throw new Error('--oracle-empty must be 0..10.');
profileFor(difficulty);
if((policy==='jev'||opponent==='jev')&&(!process.argv.includes('--allow-paid')||!process.env.TYPESAFE_API_KEY))throw new Error('Live JEV benchmarks require TYPESAFE_API_KEY and explicit --allow-paid.');
const rng=initial=>{let x=initial>>>0||1;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;};};
const env={TYPESAFE_API_KEY:process.env.TYPESAFE_API_KEY,JEV_MODEL:process.env.JEV_MODEL||'jev-1.13.0'};
const exports=[],results=[],oracleRows=[];
async function choose(state,who,rand){
  if(who==='random'){const legal=getLegalActions(state);return {action:legal[Math.floor(rand()*legal.length)],source:'random',latencyMs:0,reason:'Seeded benchmark random baseline'};}
  if(who==='jev'){const plan=await prepareDecision(state,difficulty,env.JEV_MODEL,{noSafeguards});return {plan,decision:await executeDecision(plan,env)};}
  return localDecision(state,who==='search'?'hard':who==='heuristic'?'normal':difficulty,{noSafeguards});
}
for(let pair=0;pair<pairs;pair++){
  const openingRng=rng(seed+pair*7919),opening=[];let openingState=createInitialState();
  // Identical legal opening prefix for both sides of a pair; seeds/prefixes are persisted.
  for(let k=0;k<pair%5;k++){const legal=getLegalActions(openingState),a=legal[Math.floor(openingRng()*legal.length)];opening.push(a.column);openingState=applyAction(openingState,a);}
  for(const policyDisc of [1,2]){
    const humanDisc=3-policyDisc,id=`bench-${seed}-${pair}-${policyDisc}`,startedAt=Date.now();
    const manifest={schemaVersion:1,rulesVersion:1,policyVersion:POLICY_VERSION,profile:profileFor(difficulty),difficulty,
      model:policy==='jev'?env.JEV_MODEL:null,provider:policy==='jev'?'typesafe':'local',benchmark:true,
      policy,opponent,noSafeguards,seed,pair,policyDisc,opening,inputUsdPerMillion:Number(process.env.JEV_INPUT_USD_PER_MILLION||0.042)};
    let state=createInitialState(),head=GENESIS,seq=0;const events=[],actions=[],rand=rng(seed+pair*101),baselineRand=rng(seed+pair*101+17);
    const emit=async(type,payload)=>{const chain=await chainEvents(id,seq,head,[{type,payload}],Date.now());seq=chain.seq;head=chain.head;events.push(...chain.events);};
    await emit('match.started',{manifest,humanDisc,ranked:false,createdState:state});
    const accept=async(column,decisionId=null,openingMove=false)=>{const before=state,actor=before.toMove===humanDisc?'human':'jev';state=applyAction(state,{type:'drop',column});actions.push(column);
      await emit('move.accepted',{ply:state.ply,actor,column,row:state.lastMove.row,decisionId,openingMove,
        preStateHash:await sha256(canonical(before)),postStateHash:await sha256(canonical(state)),turnElapsedMs:null,metrics:moveMetrics(before,state,column)});};
    for(const c of opening)await accept(c,null,true);
    let failure=null;
    while(state.status==='active'){
      const isPolicy=state.toMove===policyDisc,who=isPolicy?policy:opponent,decisionId=`${id}-ply-${state.ply+1}`;
      try{
        let picked;
        if(who==='jev'){
          const plan=await prepareDecision(state,difficulty,env.JEV_MODEL,{noSafeguards});
          await emit('decision.prepared',{decisionId,ply:state.ply+1,actor:isPolicy?'policy':'baseline',plan});
          picked=await executeDecision(plan,env);
        }else picked=await choose(state,who,isPolicy?rand:baselineRand);
        await emit('decision.completed',{decisionId,ply:state.ply+1,actor:isPolicy?'policy':'baseline',decision:picked});
        if(isPolicy&&42-state.ply<=oracleEmpty){const oracle=solveEndgame(state,state.toMove,{maxEmpty:oracleEmpty});oracleRows.push({matchId:id,pair,policyDisc,ply:state.ply+1,
          exact:oracle.exact,nodes:oracle.nodes,selectedColumn:picked.action.column,optimalColumns:oracle.optimalColumns,
          optimal:oracle.exact?oracle.optimalColumns.includes(picked.action.column):null,
          valueLoss:oracle.exact?oracle.value-oracle.actions.find(a=>a.column===picked.action.column).value:null});}
        await accept(picked.action.column,decisionId);
      }catch(e){failure=e.code||e.message;await emit('decision.failed',{decisionId,ply:state.ply+1,errorCode:failure,attempts:e.attempts||[]});break;}
    }
    const result=failure?null:getOutcome(state,humanDisc),policyResult=result==='win'?'loss':result==='loss'?'win':result;
    await emit(failure?'service.interrupted':'match.completed',{result,policyResult,errorCode:failure});
    const match={id,manifest,state,actions,humanDisc,difficulty,opponentVersion:`benchmark-${POLICY_VERSION}-${policy}`,
      status:failure?'interrupted':'completed',result,ranked:false,eligible:false,startedAt,finishedAt:Date.now(),eventSeq:seq,eventHead:head,diagnosticEvidence:'retained'};
    exports.push({format:'jev-benchmark-evidence/1',match,events,clientMetrics:[]});
    results.push({matchId:id,pair,policyDisc,opening,seed,policy,opponent,difficulty,noSafeguards,result:policyResult,plies:state.ply,errorCode:failure});
    console.log(`${id}: ${policyResult||'interrupted'} (${state.ply} plies)`);
  }
}
await mkdir(out,{recursive:true});
const summary=summarize(exports),exact=oracleRows.filter(r=>r.exact);
const observed={wins:results.filter(r=>r.result==='win').length,losses:results.filter(r=>r.result==='loss').length,
  draws:results.filter(r=>r.result==='draw').length,interrupted:results.filter(r=>r.errorCode).length};
// Paired bootstrap interval: resample opening groups, not individual turns/games.
const completePairs=Array.from({length:pairs},(_,i)=>results.filter(r=>r.pair===i)).filter(g=>g.length===2&&g.every(r=>r.result));
const pairScores=completePairs.map(g=>g.reduce((s,r)=>s+(r.result==='win'?1:r.result==='draw'?.5:0),0)/2),bootRng=rng(seed+9001),bootstrap=[];
if(pairScores.length)for(let i=0;i<1000;i++){let score=0;for(let j=0;j<pairScores.length;j++)score+=pairScores[Math.floor(bootRng()*pairScores.length)];bootstrap.push(score/pairScores.length);}
bootstrap.sort((a,b)=>a-b);
const report={schemaVersion:1,createdAt:new Date().toISOString(),configuration:{pairs,seed,policy,opponent,difficulty,noSafeguards,oracleEmpty},
  results:observed,bySide:[1,2].map(policyDisc=>({policyDisc,wins:results.filter(r=>r.policyDisc===policyDisc&&r.result==='win').length,
    losses:results.filter(r=>r.policyDisc===policyDisc&&r.result==='loss').length,draws:results.filter(r=>r.policyDisc===policyDisc&&r.result==='draw').length})),
  pairedScore:pairScores.length?pairScores.reduce((a,b)=>a+b,0)/pairScores.length:null,
  pairedBootstrap95:bootstrap.length?{low:bootstrap[24],high:bootstrap[974],groups:pairScores.length,replicates:1000}:null,
  endgameOracle:{evaluated:oracleRows.length,exact:exact.length,optimalActionRate:exact.length?exact.filter(r=>r.optimal).length/exact.length:null,
    valueLoss:distribution(exact.map(r=>r.valueLoss))},telemetry:summary,
  caveats:['Offline local policy runs are not measurements of JEV.','Human labels in generic tables refer to the baseline agent in this harness.',
    'Oracle comparisons cover only completely searched endgames, not full-game optimality.','Opening-prefix moves are marked; do not count them as agent decisions.',
    'Timing and IDs are not deterministic; seeded logical play is deterministic for local policies.','This is a bounded smoke benchmark, not evidence of population-level skill or a publishable evaluation by itself.']};
await writeFile(resolve(out,'summary.json'),JSON.stringify(report,null,2));
await writeFile(resolve(out,'runs.json'),JSON.stringify({format:'jev-benchmark-bundle/1',runs:exports}));
await writeFile(resolve(out,'results.csv'),csv(results));await writeFile(resolve(out,'oracle.csv'),csv(oracleRows));
const tables=flattenEvidence(exports);for(const [name,data] of Object.entries(tables))await writeFile(resolve(out,`${name}.csv`),csv(data));
await writeFile(resolve(out,'events.ndjson'),exports.flatMap(e=>e.events).map(e=>JSON.stringify(e)).join('\n')+'\n');
console.log(JSON.stringify({out,...observed,oracleExact:exact.length},null,2));
