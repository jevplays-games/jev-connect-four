/** Derived evidence, not hidden reasoning. This module runs unchanged in browser and CLI. */
export function distribution(values) {
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y),n=a.length;
  if(!n) return {n:0,min:null,max:null,mean:null,p50:null,p90:null,p95:null,p99:null};
  const q=p=>{const i=(n-1)*p,lo=Math.floor(i);return a[lo]+(a[Math.ceil(i)]-a[lo])*(i-lo);};
  return {n,min:a[0],max:a[n-1],mean:a.reduce((s,v)=>s+v,0)/n,p50:q(.5),p90:q(.9),p95:q(.95),p99:q(.99)};
}
export function wilson(successes,total,z=1.959963984540054) {
  if(!total) return null;
  const p=successes/total,den=1+z*z/total,center=(p+z*z/(2*total))/den;
  const half=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/den;
  return {low:Math.max(0,center-half),high:Math.min(1,center+half)};
}
const rate=(n,d)=>d?n/d:null;
const sum=(a,fn)=>a.reduce((s,v)=>s+(fn(v)||0),0);
export function flattenEvidence(exports) {
  const tables={matches:[],moves:[],decisions:[],candidates:[],questions:[],attempts:[],events:[],clientMetrics:[]};
  for(const exp of exports) {
    const m=exp.match, prepared=new Map(), base={matchId:m.id,difficulty:m.difficulty,opponentVersion:m.opponentVersion,
      humanDisc:m.humanDisc,ranked:!!m.ranked,eligible:!!m.eligible};
    tables.matches.push({...base,status:m.status,result:m.result??null,adjudication:m.adjudication??null,
      startedAt:m.startedAt,finishedAt:m.finishedAt??null,plies:m.actions?.length??0,
      durationMs:m.finishedAt?m.finishedAt-m.startedAt:null,diagnosticEvidence:m.diagnosticEvidence??'retained'});
    for(const e of exp.events||[]) {
      tables.events.push({...base,seq:e.seq,type:e.type,utcMs:e.utcMs,hash:e.hash,prevHash:e.prevHash});
      const p=e.payload;
      if(e.type==='move.accepted') tables.moves.push({...base,...p,utcMs:e.utcMs});
      if(e.type==='decision.prepared') prepared.set(p.decisionId,p);
      if(e.type==='decision.completed'||e.type==='decision.failed') {
        const pre=prepared.get(p.decisionId),d=p.decision||{},failed=e.type==='decision.failed';
        const selected=d.ranked?.find(c=>c.column===d.action?.column);
        const decisionActor=p.actor??pre?.actor??'jev';
        tables.decisions.push({...base,decisionActor,decisionId:p.decisionId,ply:p.ply,source:failed?'failed':d.source,
          model:d.model??null,selectedColumn:d.action?.column??null,failed,errorCode:p.errorCode??null,
          latencyMs:d.latencyMs??p.latencyMs??null,prepareMs:pre?.plan?.prepareMs??d.prepareMs??null,
          candidateCount:pre?.plan?.candidates.length??d.candidateCount??null,
          eligibleCount:pre?.plan?.eligible.length??d.eligibleCount??null,
          questions:pre?.plan?.needsModel?Object.keys(pre.plan.request.questions).length:0,
          requestBytes:pre?.plan?.requestBytes??null,inputTokens:d.usage?.input_tokens??null,
          outputTokens:d.usage?.output_tokens??null,utility:selected?.utility??null,utilityGap:d.utilityGap??null,
          requestHash:pre?.plan?.requestHash??null,responseHash:d.responseHash??null,
          estimatedInputUSD:d.usage?d.usage.input_tokens*(m.manifest?.inputUsdPerMillion||0)/1e6:null,
          estimatedOutputUSD:d.usage?d.usage.output_tokens*(m.manifest?.outputUsdPerMillion||0)/1e6:null,
          priceConfigured:!!m.manifest?.inputUsdPerMillion});
        const attempts=d.attempts||p.attempts||[];
        for(const a of attempts) tables.attempts.push({...base,decisionActor,decisionId:p.decisionId,...a});
        for(const c of pre?.plan?.candidates||d.candidates||[]) {
          const evaluated=d.ranked?.find(x=>x.id===c.id);
          tables.candidates.push({...base,decisionActor,decisionId:p.decisionId,ply:p.ply,candidateId:c.id,column:c.column,
            landingRow:c.landingRow,eligible:c.eligible,exclusionReason:c.excludedReason,
            selected:c.column===d.action?.column,lowerBound:c.search.bounds[0],upperBound:c.search.bounds[1],
            nodes:c.search.nodes,leaves:c.search.leaves,cutoffs:c.search.cutoffs,maxDepth:c.search.maxDepth,
            budgetExhausted:c.search.budgetExhausted,humanWinningReplies:c.humanWinningReplies.length,
            playableThreats:c.threats.self.filter(t=>t.playable).length,
            unsupportedThreats:c.threats.self.filter(t=>!t.playable).length,utility:evaluated?.utility??null});
        }
        for(const ranked of d.ranked||[]) for(const [factor,a] of Object.entries(ranked.factors)) {
          tables.questions.push({...base,decisionActor,decisionId:p.decisionId,candidateId:ranked.id,column:ranked.column,
            selected:ranked.column===d.action.column,factor,score:a.score,normalizedScore:a.normalizedScore,
            confidence:a.confidence,entropyBits:a.entropyBits,weight:a.weight,
            p0:a.probabilities['0'],p1:a.probabilities['1'],p2:a.probabilities['2'],p3:a.probabilities['3'],p4:a.probabilities['4']});
        }
      }
    }
    for(const c of exp.clientMetrics||[]) tables.clientMetrics.push({...base,trust:'client-reported-unverified',...c});
  }
  return tables;
}
export function summarize(exports) {
  const t=flattenEvidence(exports),completed=t.matches.filter(m=>['completed','adjudicated'].includes(m.status));
  const verified=completed.filter(m=>m.eligible),w=verified.filter(m=>m.result==='win').length,
    l=verified.filter(m=>m.result==='loss').length,d=verified.filter(m=>m.result==='draw').length,n=w+l+d;
  const decisions=t.decisions,success=decisions.filter(d=>!d.failed),model=success.filter(d=>d.source==='model');
  const columns={human:Array(7).fill(0),jev:Array(7).fill(0)},heatmap={human:Array(42).fill(0),jev:Array(42).fill(0)};
  const tactics={};
  for(const actor of ['human','jev']) {
    const moves=t.moves.filter(m=>m.actor===actor),opportunities=moves.filter(m=>m.metrics?.immediateWinAvailable);
    const threats=moves.filter(m=>m.metrics?.opponentThreatsBefore.length&&m.metrics?.safeAlternatives.length);
    for(const move of moves) {columns[actor][move.column]++;heatmap[actor][move.row*7+move.column]++;}
    tactics[actor]={moves:moves.length,immediateWinOpportunities:opportunities.length,
      takenImmediateWins:opportunities.filter(m=>m.metrics.tookImmediateWin).length,
      missedImmediateWins:opportunities.filter(m=>m.metrics.missedImmediateWin).length,
      immediateWinConversion:rate(opportunities.filter(m=>m.metrics.tookImmediateWin).length,opportunities.length),
      blockableThreatTurns:threats.length,threatsNeutralized:threats.filter(m=>m.metrics.blockedThreat||m.metrics.tookImmediateWin).length,
      blockRate:rate(threats.filter(m=>m.metrics.blockedThreat||m.metrics.tookImmediateWin).length,threats.length),
      avoidableImmediateLosses:moves.filter(m=>m.metrics?.avoidableImmediateLoss).length,
      centerMoveRate:rate(moves.filter(m=>m.column===3).length,moves.length),
      playableThreatsAfter:distribution(moves.map(m=>m.metrics?.playableThreatsAfter)),
      unsupportedThreatsAfter:distribution(moves.map(m=>m.metrics?.unsupportedThreatsAfter))};
  }
  const cohortMap=new Map();
  for(const m of t.matches) {
    const key=[m.difficulty,m.opponentVersion,m.humanDisc,m.ranked?'ranked':'practice'].join('|');
    if(!cohortMap.has(key)) cohortMap.set(key,{key,difficulty:m.difficulty,opponentVersion:m.opponentVersion,humanDisc:m.humanDisc,
      mode:m.ranked?'ranked':'practice',matches:0,verified:0,wins:0,losses:0,draws:0,interrupted:0});
    const c=cohortMap.get(key);c.matches++;if(m.eligible){c.verified++;c[m.result==='win'?'wins':m.result==='loss'?'losses':'draws']++;}
    if(m.status==='interrupted')c.interrupted++;
  }
  const cohorts=[...cohortMap.values()].map(c=>({...c,resultRate:rate(c.wins+.5*c.draws,c.verified)}));
  const decisionSources={};for(const item of decisions)decisionSources[item.source]=(decisionSources[item.source]||0)+1;
  const failureReasons={};for(const item of decisions)if(item.failed)failureReasons[item.errorCode||'UNKNOWN']=(failureReasons[item.errorCode||'UNKNOWN']||0)+1;
  const practice=completed.filter(m=>!m.eligible);
  const exclusionReasons={};for(const c of t.candidates)if(c.exclusionReason)exclusionReasons[c.exclusionReason]=(exclusionReasons[c.exclusionReason]||0)+1;
  const statusCounts={};for(const a of t.attempts)statusCounts[a.httpStatus??'network']=(statusCounts[a.httpStatus??'network']||0)+1;
  const firstMoveIds=new Set(t.moves.map(m=>m.matchId)),inferenceIds=new Set(model.map(m=>m.matchId));
  const ordered=[...verified].sort((a,b)=>(a.finishedAt-b.finishedAt)||a.matchId.localeCompare(b.matchId));
  let currentStreak=0,bestStreak=0;for(const m of ordered){currentStreak=m.result==='win'?currentStreak+1:0;bestStreak=Math.max(bestStreak,currentStreak);}
  return {schemaVersion:1,generatedAt:new Date().toISOString(),coverage:{matches:exports.length,
      diagnosticMatches:t.matches.filter(m=>m.diagnosticEvidence==='retained').length,
      notExhaustiveGameTree:true,modelConfidenceIsWinProbability:false},
    outcomes:{matches:t.matches.length,completed:completed.length,verified:n,wins:w,losses:l,draws:d,
      interrupted:t.matches.filter(m=>m.status==='interrupted').length,
      adjudicated:t.matches.filter(m=>m.status==='adjudicated').length,
      active:t.matches.filter(m=>['active','thinking'].includes(m.status)).length,
      resultRate:rate(w+.5*d,n),winRate:rate(w,n),binaryWinRateWilson95:wilson(w,n),currentStreak,bestStreak,
      practiceCompleted:practice.length,practiceWins:practice.filter(m=>m.result==='win').length,
      practiceLosses:practice.filter(m=>m.result==='loss').length,practiceDraws:practice.filter(m=>m.result==='draw').length},
    funnel:{started:t.matches.length,firstMove:firstMoveIds.size,modelEvaluated:inferenceIds.size,
      completed:completed.length,verified:n},
    jev:{decisions:decisions.length,decisionSources,failureReasons,modelDecisions:model.length,tacticalDecisions:success.filter(d=>d.source==='tactical').length,
      failedDecisions:decisions.filter(d=>d.failed).length,failureRate:rate(decisions.filter(d=>d.failed).length,decisions.length),
      providerAttempts:t.attempts.length,retries:t.attempts.filter(a=>a.attempt>1).length,statusCounts,
      failedAttempts:t.attempts.filter(a=>a.errorCode).length,exclusionReasons,
      candidates:distribution(decisions.map(d=>d.candidateCount)),eligibleCandidates:distribution(decisions.map(d=>d.eligibleCount)),
      utilityGap:distribution(model.map(d=>d.utilityGap)),confidence:distribution(t.questions.filter(q=>q.selected).map(q=>q.confidence)),
      entropyBits:distribution(t.questions.filter(q=>q.selected).map(q=>q.entropyBits)),
      inputTokens:sum(model,d=>d.inputTokens),outputTokens:sum(model,d=>d.outputTokens),
      questions:sum(decisions,d=>d.questions),searchNodes:sum(t.candidates,c=>c.nodes),
      searchBudgetExhaustedCandidates:t.candidates.filter(c=>c.budgetExhausted).length},
    cost:{estimatedInputUSD:sum(model,d=>d.estimatedInputUSD),estimatedOutputUSD:sum(model,d=>d.estimatedOutputUSD),
      knownUsageDecisions:model.filter(d=>d.inputTokens!==null).length,
      attemptsWithUnknownBilling:t.attempts.filter(a=>!a.usage).length,
      allModelPricesConfigured:model.length>0&&model.every(d=>d.priceConfigured),excludesHosting:true,isInvoice:false},
    latency:{modelMs:distribution(model.map(d=>d.latencyMs)),providerAttemptMs:distribution(t.attempts.map(a=>a.latencyMs)),
      preparationMs:distribution(decisions.map(d=>d.prepareMs)),humanWallTurnMs:distribution(t.moves.filter(m=>m.actor==='human').map(m=>m.turnElapsedMs)),
      matchDurationMs:distribution(completed.map(m=>m.durationMs)),plies:distribution(completed.map(m=>m.plies))},
    tactics,columns,heatmap,cohorts,eventCount:t.events.length,
    notes:['Official outcome aggregates exclude practice and interruptions.',
      'Cohorts must be compared separately by difficulty, opponent version and starting side.',
      'Server turn elapsed time includes human idle time and network delay, not just thinking.',
      'Tactical metrics identify immediate opportunities only, not game-theoretic optimality.',
      'Client metrics are opt-in, unverified, and never used to award results.',
      'Wilson interval describes binary wins; repeated games need not be independent.']};
}
export function csv(records) {
  if(!records.length)return '';
  const keys=[...new Set(records.flatMap(Object.keys))];
  const cell=v=>{
    let s=v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v);
    // Prevent spreadsheet formula injection when opening exported CSV.
    if(/^[=+@\-\t\r]/.test(s)&&typeof v!=='number')s="'"+s;
    return '"'+s.replaceAll('"','""')+'"';
  };
  return [keys.map(cell).join(','),...records.map(r=>keys.map(k=>cell(r[k])).join(','))].join('\r\n');
}
