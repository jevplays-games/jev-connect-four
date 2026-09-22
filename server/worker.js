import {json,assert,HttpError,now,secureResponse,readJSON,parseIdempotency,int,hmac} from './util.js';
import {me,getSession,checkMutation,startOAuth,callbackOAuth,redeemLaunch,discordInteraction,userFor,sessionCookie} from './auth.js';
import {one,rows,run,loadMatch,loadEvents,consumeQuota,countOperation} from './db.js';
import {ownedMatch,viewMatch,exportMatch,createMatch,commandMatch,expireMatch} from './matches.js';
import {leaderboard,signCursor,readCursor} from './leaderboard.js';
import {summarize,flattenEvidence,csv,distribution} from '../public/analytics.js';
import {auditExport} from './audit.js';

async function getExport(env,row) {
  const events=await loadEvents(env,row.id);
  const client=(await rows(env,'SELECT received_at,body FROM client_metrics WHERE match_id=? ORDER BY received_at',row.id))
    .map(r=>({receivedAt:r.received_at,...JSON.parse(r.body)}));
  return exportMatch(row,events,client);
}
async function clientTelemetry(env,session,row,body) {
  assert(body.consent===true,400,'TELEMETRY_CONSENT_REQUIRED');
  assert(typeof body.id==='string'&&/^[A-Za-z0-9-]{8,64}$/.test(body.id),400,'TELEMETRY_ID_INVALID');
  const fields=['renderMs','requestMs','inputDelayMs','longTaskCount','longTaskDurationMs','hiddenMs','viewportWidth','viewportHeight'];
  const metrics={trust:'client-reported-unverified',schemaVersion:1};
  for(const key of fields)if(body[key]!==undefined){assert(Number.isFinite(body[key])&&body[key]>=0&&body[key]<=86400000,400,'INVALID_TELEMETRY_NUMBER');metrics[key]=body[key];}
  if(body.inputMethod!==undefined){assert(['keyboard','pointer','touch'].includes(body.inputMethod),400,'INVALID_INPUT_METHOD');metrics.inputMethod=body.inputMethod;}
  const today=new Date(now(env)).toISOString().slice(0,10);
  await consumeQuota(env,await hmac(env.APP_SECRET,`telemetry:${today}:${session.token_hash}`),'client_metrics',300,now(env)+86400000);
  const inserted=await run(env,'INSERT OR IGNORE INTO client_metrics(id,match_id,received_at,body) VALUES(?,?,?,?)',body.id,row.id,now(env),JSON.stringify(metrics));
  return {accepted:inserted.meta.changes===1};
}
async function mine(env,session,url) {
  const limit=int(url.searchParams.get('limit'),1,200,100),field=session.user_id?'user_id':'guest_session',owner=session.user_id||session.token_hash;
  let before=now(env)+1,beforeId='~';
  if(url.searchParams.has('cursor')) {
    const c=await readCursor(env,url.searchParams.get('cursor'));
    assert(c.kind==='history'&&c.owner===await hmac(env.APP_SECRET,`history:${owner}`)&&Number.isInteger(c.before)&&typeof c.id==='string',400,'CURSOR_OWNER_MISMATCH');
    before=c.before;beforeId=c.id;
  }
  const found=await rows(env,`SELECT id,started_at,status,result,difficulty,human_disc,opponent_version,eligible FROM matches
    WHERE ${field}=? AND (started_at<? OR (started_at=? AND id<?)) ORDER BY started_at DESC,id DESC LIMIT ?`,owner,before,before,beforeId,limit+1);
  const selected=found.slice(0,limit),hasMore=found.length>limit,last=selected.at(-1);
  return {matches:selected,limit,hasMore,nextCursor:hasMore?await signCursor(env,{kind:'history',owner:await hmac(env.APP_SECRET,`history:${owner}`),before:last.started_at,id:last.id}):null};
}
async function userAnalytics(env,session,url) {
  const limit=int(url.searchParams.get('limit'),1,200,100),field=session.user_id?'user_id':'guest_session',owner=session.user_id||session.token_hash;
  const ids=await rows(env,`SELECT id FROM matches WHERE ${field}=? ORDER BY started_at DESC LIMIT ?`,owner,limit);
  const total=(await one(env,`SELECT COUNT(*) AS n FROM matches WHERE ${field}=?`,owner)).n;
  const exports=[];for(const r of ids)exports.push(await getExport(env,await loadMatch(env,r.id)));
  return {summary:summarize(exports),sample:{included:ids.length,total,limited:total>ids.length,selection:'most recent matches'},
    history:exports.map(e=>e.match)};
}
async function operatorAnalytics(env,session) {
  const user=await userFor(env,session);
  assert(user&&(env.ADMIN_DISCORD_IDS||'').split(',').map(x=>x.trim()).includes(user.discord_id),403,'ADMIN_REQUIRED');
  const since=now(env)-30*86400000;
  const daily=await rows(env,`SELECT strftime('%Y-%m-%d',started_at/1000,'unixepoch') AS day,COUNT(*) AS starts,
    SUM(status='completed') AS completed,SUM(status='interrupted') AS interrupted,SUM(eligible) AS verified
    FROM matches WHERE started_at>=? GROUP BY day ORDER BY day`,since);
  const operations=await rows(env,"SELECT bucket AS day,name,value FROM counters WHERE name LIKE 'op:%' ORDER BY bucket DESC LIMIT 500");
  const latest=await rows(env,"SELECT body FROM events WHERE event_type IN ('decision.completed','decision.failed') AND utc_ms>=? ORDER BY utc_ms DESC LIMIT 10000",since);
  const decisions=latest.map(r=>JSON.parse(r.body));
  const attempts=decisions.flatMap(e=>e.payload.decision?.attempts||e.payload.attempts||[]);
  const countBy={};for(const a of attempts)countBy[a.httpStatus??'network']=(countBy[a.httpStatus??'network']||0)+1;
  return {windowDays:30,daily,operations,decisionSampleLimit:10000,decisionSampleCount:decisions.length,
    decisionSampleMayBeLimited:decisions.length===10000,
    providerLatencyMs:distribution(attempts.map(a=>a.latencyMs)),providerStatuses:countBy,
    failureCount:decisions.filter(e=>e.type==='decision.failed').length,
    retryAttempts:attempts.filter(a=>a.attempt>1).length,
    knownInputTokens:attempts.reduce((s,a)=>s+(a.usage?.input_tokens||0),0),
    knownOutputTokens:attempts.reduce((s,a)=>s+(a.usage?.output_tokens||0),0),
    noUserIdentities:true};
}
export async function route(request,env) {
  const url=new URL(request.url),path=url.pathname;
  if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
  assert(env.DB&&typeof env.APP_SECRET==='string'&&env.APP_SECRET.length>=32,503,'SERVER_CONFIGURATION_REQUIRED');
  assert(url.origin===new URL(env.APP_ORIGIN).origin,400,'HOST_REJECTED');
  if(path==='/api/health'&&request.method==='GET')return json({ok:true,version:'1.0.0'});
  if(path==='/api/discord/interactions'&&request.method==='POST')return discordInteraction(request,env);
  if(path==='/api/me'&&request.method==='GET')return me(request,env);
  if(path==='/api/auth/discord'&&request.method==='GET')return startOAuth(request,env);
  if(path==='/api/auth/discord/callback'&&request.method==='GET')return callbackOAuth(request,env);
  let session;
  if(path==='/api/leaderboard'&&request.method==='GET'&&(!url.searchParams.has('scope')||url.searchParams.get('scope')==='world')) {
    try{session=await getSession(request,env);}catch(e){if(e.status!==401)throw e;session={user_id:null,token_hash:null};}
  }else session=await getSession(request,env);
  if(!['GET','HEAD'].includes(request.method))await checkMutation(request,env,session);
  if(path==='/api/logout'&&request.method==='POST') {
    await run(env,'DELETE FROM sessions WHERE token_hash=?',session.token_hash);
    return json({ok:true},200,{'Set-Cookie':sessionCookie(env,'',0)});
  }
  if(path==='/api/me'&&request.method==='DELETE') {
    assert(session.user_id,401,'DISCORD_LOGIN_REQUIRED');
    const b=await readJSON(request);assert(b.confirm==='DELETE',400,'CONFIRMATION_REQUIRED');
    await run(env,'DELETE FROM users WHERE id=?',session.user_id);
    return json({deleted:true},200,{'Set-Cookie':sessionCookie(env,'',0)});
  }
  if(path==='/api/context/redeem'&&request.method==='POST') {
    const b=await readJSON(request);return json(await redeemLaunch(env,session,b.ticket));
  }
  if(path==='/api/matches'&&request.method==='POST') {
    const body=await readJSON(request),key=parseIdempotency(request);
    const row=await createMatch(env,session,body,key,request);return json(viewMatch(row),201);
  }
  if(path==='/api/history'&&request.method==='GET')return json(await mine(env,session,url));
  if(path==='/api/analytics/me'&&request.method==='GET')return json(await userAnalytics(env,session,url));
  if(path==='/api/analytics/operator'&&request.method==='GET')return json(await operatorAnalytics(env,session));
  if(path==='/api/leaderboard'&&request.method==='GET')return json(await leaderboard(env,session,url));
  const match=path.match(/^\/api\/matches\/([a-zA-Z0-9-]{16,64})(?:\/(commands|replay|export|analytics|telemetry))?$/);
  if(match) {
    const [,id,action]=match;
    if(action==='commands'&&request.method==='POST')return json(viewMatch(await commandMatch(env,session,id,await readJSON(request),parseIdempotency(request))));
    let row=await ownedMatch(env,session,id);
    if(!action&&request.method==='GET'){row=await expireMatch(env,row);return json(viewMatch(row));}
    if(action==='telemetry'&&request.method==='POST')return json(await clientTelemetry(env,session,row,await readJSON(request)));
    if(action==='replay'&&request.method==='GET')return json({format:'jev-arcade-replay/1',game:'connect-four',rulesVersion:1,
      columnIndexBase:0,initialState:'empty-7x6',humanDisc:row.data.humanDisc,opponentVersion:row.data.opponentVersion,
      actions:row.data.actions,end:{kind:row.data.adjudication?'adjudication':'board',outcome:row.data.result,reason:row.data.adjudication??null}});
    if(['export','analytics'].includes(action)&&request.method==='GET') {
      const exp=await getExport(env,row);
      if(action==='analytics')return json({summary:summarize([exp]),tables:flattenEvidence([exp]),audit:await auditExport(exp)});
      const format=url.searchParams.get('format')||'json';
      if(format==='json')return json(exp,200,{'Content-Disposition':`attachment; filename="${id}-audit.json"`});
      if(format==='ndjson')return new Response(exp.events.map(e=>JSON.stringify(e)).join('\n')+'\n',{headers:{'Content-Type':'application/x-ndjson','Content-Disposition':`attachment; filename="${id}-events.ndjson"`}});
      if(format==='csv') {
        const table=url.searchParams.get('table')||'moves',tables=flattenEvidence([exp]);assert(Object.hasOwn(tables,table),400,'INVALID_TABLE');
        return new Response(csv(tables[table]),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${id}-${table}.csv"`}});
      }
      throw new HttpError(400,'INVALID_EXPORT_FORMAT');
    }
  }
  throw new HttpError(404,'NOT_FOUND');
}
async function fetchHandler(request,env,ctx) {
  const started=performance.now();let response;
  try {response=await route(request,env);}
  catch(error) {
    const status=error.status||500;
    // Never serialize raw provider errors, URLs, SQL, tokens or arbitrary exception messages.
    response=json({error:error.code||(status===500?'INTERNAL_ERROR':'REQUEST_FAILED'),details:error instanceof HttpError?error.details:null},status);
    if(env.DB) {
      const p=countOperation(env,status===409?'conflict':status===429?'rate_limited':status===401?'unauthorized':status===403?'forbidden':status>=500?'server_error':'client_error').catch(()=>{});
      if(ctx?.waitUntil)ctx.waitUntil(p);else await p;
    }
    if(env.DEV_LOCAL==='1'&&status===500)console.error('LOCAL_ERROR',error.stack);
  }
  const secured=secureResponse(response);secured.headers.set('Server-Timing',`app;dur=${(performance.now()-started).toFixed(1)}`);
  return secured;
}
export async function scheduledHandler(event,env) {
  const expired=await rows(env,"SELECT id FROM matches WHERE (status='active' AND deadline_at<?) OR (status='thinking' AND json_extract(snapshot,'$.pending.expiresAt')<?) LIMIT 200",now(env),now(env));
  for(const m of expired){try{await expireMatch(env,await loadMatch(env,m.id));}catch(e){if(e.status!==409)await countOperation(env,'expiry_error');}}
  const cutoff=now(env)-Number(env.AUDIT_RETENTION_DAYS||90)*86400000;
  // Retain compact legal replay and result; explicitly mark deep audit evidence as pruned.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events WHERE match_id IN (SELECT id FROM matches WHERE finished_at<? AND status NOT IN ('active','thinking'))").bind(cutoff),
    env.DB.prepare("DELETE FROM client_metrics WHERE received_at<?").bind(now(env)-7*86400000),
    env.DB.prepare("UPDATE matches SET snapshot=json_set(snapshot,'$.diagnosticEvidence','pruned','$.lastDecision',NULL) WHERE finished_at<? AND status NOT IN ('active','thinking')").bind(cutoff),
    env.DB.prepare('DELETE FROM tickets WHERE expires_at<?').bind(now(env)-86400000),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now(env)),
    env.DB.prepare('DELETE FROM counters WHERE expires_at<?').bind(now(env)),
    env.DB.prepare('DELETE FROM context_grants WHERE expires_at<?').bind(now(env)),
    env.DB.prepare('DELETE FROM matches WHERE user_id IS NULL AND started_at<?').bind(cutoff)
  ]);
}
export default {fetch:fetchHandler,scheduled:scheduledHandler};
