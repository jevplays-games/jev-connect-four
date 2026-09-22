import {buildCandidates,POLICY_VERSION} from '../public/policy.js';
import {boardRows,ORDER} from '../public/rules.js';
import {canonical,sha256,utf8,HttpError} from './util.js';
const FACTORS = {
  position: {task:'Assess the overall strategic position for JEV after this candidate.', levels:[
    'The shown position gives the human strong threats while JEV lacks counterplay.',
    'The shown position favors human development and restricts JEV opportunities.',
    'Neither player has a clear positional advantage in the supplied evidence.',
    'JEV has useful central control or developing threats with manageable human counterplay.',
    'JEV has mutually reinforcing winning threats and the human has little effective counterplay.']},
  attack: {task:'Assess JEV\'s future winning opportunities after this candidate.',levels:[
    'JEV has almost no useful unblocked four-cell windows or accessible completion squares.',
    'JEV opportunities are sparse, isolated, or depend on unavailable support.',
    'JEV has some developing lines but no coherent supported attack.',
    'JEV has several useful supported lines or a direct playable threat.',
    'JEV has multiple independent playable winning threats or an already completed winning line.']},
  safety: {task:'Assess resistance to the human threats shown after this candidate.',levels:[
    'The human can win on the next move or a supplied tactical bound proves JEV loses.',
    'The human has dangerous connected threats that are difficult for JEV to contain.',
    'The supplied evidence is balanced or insufficient to establish safety.',
    'The human has limited immediate threats and JEV retains useful defensive access.',
    'JEV has already won or supplied tactical evidence proves a JEV win despite human replies.']},
  support: {task:'Assess whether gravity and supporting cells favor JEV access to future winning squares.',levels:[
    'Supporting cells make human completion squares playable while JEV completions remain inaccessible.',
    'Gravity restricts JEV useful completion squares more than human completion squares.',
    'Supporting-cell evidence does not clearly favor either player.',
    'JEV useful completion squares have accessible support and human completions are restricted.',
    'Multiple independent JEV completion squares are already playable without enabling a human win.']},
  initiative: {task:'Assess whether this candidate forces human responses that help JEV.',levels:[
    'JEV must respond to an immediate human win and has no effective forcing reply.',
    'The human can build threats freely while JEV is constrained to defense.',
    'Neither player has a clearly forcing continuation in the supplied evidence.',
    'JEV poses a supported threat that constrains the human response.',
    'JEV creates simultaneous forcing threats the human cannot meet with a single move.']}
};
export async function prepareDecision(state,difficulty,model,options={}) {
  const start=performance.now(), {candidates,eligible,profile}=buildCandidates(state,difficulty,state.toMove,options);
  if(!eligible.length) throw new Error('NO_LEGAL_CANDIDATES');
  const encoded={game:'connect-four',rulesVersion:1,perspective:'JEV',
    notation:{J:'JEV disc',H:'human disc','.':'empty',columns:'0 through 6 left to right',boardRows:'top to bottom',coordinateRows:'0 through 5 bottom to top'},
    boardTopToBottom:boardRows(state,state.toMove),candidates:Object.fromEntries(eligible.map(c=>[c.id,c]))};
  const questions={};
  for(const c of eligible) for(const factor of Object.keys(profile.factors)) {
    questions[`${c.id}_${factor}`]={type:'score',instructions:{candidate:c.id,statePath:`candidates.${c.id}`,
      task:FACTORS[factor].task,perspective:'JEV',constraints:[
        'Evaluate only this candidate and this factor using the supplied board and exact computed features.',
        'Unsupported completion squares are not immediately playable.',
        'A tactical interval [-1,1] is unresolved, not a proven draw or win.']},criteria:FACTORS[factor].levels};
  }
  const request={model,state:encoded,questions};
  return {policyVersion:POLICY_VERSION,difficulty,model,candidates,eligible:eligible.map(c=>c.id),profile,
    request,requestHash:await sha256(canonical(request)),requestBytes:utf8(JSON.stringify(request)).length,
    prepareMs:performance.now()-start,needsModel:eligible.length>1};
}
function bad(condition,code) { if(!condition) throw new HttpError(502,code); }
export function validateResponse(data,request) {
  bad(data&&typeof data==='object','JEV_INVALID_RESPONSE');
  bad(data.model===request.model,'JEV_MODEL_MISMATCH');
  bad(data.answers&&typeof data.answers==='object','JEV_MISSING_ANSWERS');
  const expected=Object.keys(request.questions).sort(),got=Object.keys(data.answers).sort();
  bad(JSON.stringify(expected)===JSON.stringify(got),'JEV_ANSWER_KEYS');
  const answers={};
  for(const id of expected) {
    const a=data.answers[id], levels=request.questions[id].criteria,keys=levels.map((_,i)=>String(i));
    bad(a?.type==='score'&&Number.isFinite(a.score)&&a.score>=0&&a.score<=levels.length-1,'JEV_SCORE_RANGE');
    bad(Number.isFinite(a.confidence)&&a.confidence>=0&&a.confidence<=1,'JEV_CONFIDENCE_RANGE');
    bad(a.probabilities&&JSON.stringify(Object.keys(a.probabilities).sort())===JSON.stringify(keys),'JEV_PROBABILITY_KEYS');
    const probs=keys.map(k=>a.probabilities[k]);
    bad(probs.every(p=>Number.isFinite(p)&&p>=0&&p<=1),'JEV_PROBABILITY_RANGE');
    bad(Math.abs(probs.reduce((x,y)=>x+y,0)-1)<=.015,'JEV_PROBABILITY_SUM');
    bad(Math.abs(probs.reduce((sum,p,i)=>sum+p*i,0)-a.score)<=.04,'JEV_SCORE_INCONSISTENT');
    bad(a.legend&&keys.every(k=>a.legend[k]===levels[Number(k)]),'JEV_LEGEND_MISMATCH');
    answers[id]={type:'score',score:a.score,confidence:a.confidence,probabilities:a.probabilities,
      legend:Object.fromEntries(keys.map(k=>[k,levels[Number(k)]]))};
  }
  bad(data.usage&&['input_tokens','output_tokens'].every(k=>Number.isInteger(data.usage[k])&&data.usage[k]>=0),'JEV_USAGE_INVALID');
  return {model:data.model,answers,usage:{input_tokens:data.usage.input_tokens,output_tokens:data.usage.output_tokens}};
}
export function rankAnswers(plan,response) {
  return plan.eligible.map(id=>{
    const factors={}; let utility=0;
    for(const [factor,weight] of Object.entries(plan.profile.factors)) {
      const a=response.answers[`${id}_${factor}`];
      const entropy=-Object.values(a.probabilities).reduce((s,p)=>s+(p?p*Math.log2(p):0),0);
      factors[factor]={...a,normalizedScore:a.score/4,entropyBits:entropy,weight};
      utility+=weight*a.score/4;
    }
    return {id,column:Number(id.slice(1)),utility:Math.round(utility*1e6)/1e6,factors};
  }).sort((a,b)=>b.utility-a.utility||ORDER.indexOf(a.column)-ORDER.indexOf(b.column));
}
/** Caller persists plan before invocation. No provider secrets enter returned evidence. */
export async function executeDecision(plan,env,options={}) {
  const started=performance.now(),attempts=[];
  if(!plan.needsModel) return {action:{type:'drop',column:Number(plan.eligible[0].slice(1))},source:'tactical',model:null,
    candidates:plan.candidates,ranked:[],factors:{},attempts,usage:null,response:null,
    latencyMs:0,prepareMs:plan.prepareMs,requestHash:plan.requestHash,responseHash:null,
    candidateCount:plan.candidates.length,eligibleCount:1,reason:'Only one candidate remains after versioned tactical safeguards'};
  if(!env.TYPESAFE_API_KEY) throw Object.assign(new HttpError(503,'JEV_NOT_CONFIGURED'),{attempts});
  const budget=options.budgetMs??3000,fetcher=env.FETCH||fetch;
  for(let attempt=1;attempt<=2;attempt++) {
    const remaining=budget-(performance.now()-started);
    if(remaining<50) break;
    try { await options.beforeAttempt?.(attempt); } catch (error) { throw Object.assign(new HttpError(error.status||429,error.code||'PROVIDER_BUDGET_EXHAUSTED'),{attempts}); }
    const t=performance.now(); let httpStatus=null;
    try {
      const response=await fetcher('https://api.typesafe.ai/v1/systemone',{
        method:'POST',headers:{Authorization:`Bearer ${env.TYPESAFE_API_KEY}`,'Content-Type':'application/json'},
        body:JSON.stringify(plan.request),signal:AbortSignal.timeout(Math.max(1,Math.floor(remaining)))});
      httpStatus=response.status;
      if(!response.ok) {
        const retryAfter=response.headers.get('retry-after');
        const numeric=Number(retryAfter);
        const delay=retryAfter ? (Number.isFinite(numeric)?numeric*1000:Math.max(0,Date.parse(retryAfter)-Date.now())) : 200;
        attempts.push({attempt,httpStatus,latencyMs:performance.now()-t,errorCode:`HTTP_${httpStatus}`});
        await response.body?.cancel();
        if(attempt===1&&[429,529,502,503,504].includes(httpStatus)&&Number.isFinite(delay)&&delay>=0&&delay+100<budget-(performance.now()-started)) {
          await new Promise(r=>setTimeout(r,delay)); continue;
        }
        throw Object.assign(new HttpError(503,`JEV_HTTP_${httpStatus}`),{alreadyRecorded:true});
      }
      const raw=await response.text(); bad(raw.length<1000000,'JEV_RESPONSE_TOO_LARGE');
      let decoded; try {decoded=JSON.parse(raw);} catch {throw new HttpError(502,'JEV_INVALID_JSON');}
      const valid=validateResponse(decoded,plan.request),ranked=rankAnswers(plan,valid);
      attempts.push({attempt,httpStatus,latencyMs:performance.now()-t,responseBytes:utf8(raw).length,usage:valid.usage,errorCode:null});
      return {action:{type:'drop',column:ranked[0].column},source:'model',model:valid.model,candidates:plan.candidates,
        ranked,factors:ranked[0].factors,attempts,usage:valid.usage,response:valid,
        latencyMs:performance.now()-started,prepareMs:plan.prepareMs,requestHash:plan.requestHash,
        responseHash:await sha256(canonical(valid)),candidateCount:plan.candidates.length,eligibleCount:plan.eligible.length,
        utilityGap:ranked.length>1?ranked[0].utility-ranked[1].utility:null,reason:'Highest weighted JEV factor score among eligible candidates'};
    } catch(error) {
      if(!error.alreadyRecorded) attempts.push({attempt,httpStatus,latencyMs:performance.now()-t,
        errorCode:error.name==='TimeoutError'||error.name==='AbortError'?'JEV_TIMEOUT':error.code||'JEV_NETWORK_OR_SCHEMA_ERROR'});
      const failureCode=error.name==='TimeoutError'||error.name==='AbortError'?'JEV_TIMEOUT':typeof error.code==='string'?error.code:'JEV_UNAVAILABLE';
      throw Object.assign(new HttpError(error.status||503,failureCode),{attempts});
    }
  }
  throw Object.assign(new HttpError(503,'JEV_TIMEOUT'),{attempts});
}
