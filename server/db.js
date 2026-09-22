import {canonical,sha256,randomToken,now,HttpError} from './util.js';
export async function one(env,sql,...args) { return env.DB.prepare(sql).bind(...args).first(); }
export async function rows(env,sql,...args) { return (await env.DB.prepare(sql).bind(...args).all()).results; }
export async function run(env,sql,...args) { return env.DB.prepare(sql).bind(...args).run(); }
export const GENESIS = '0'.repeat(64);
export async function loadMatch(env,id) {
  const row=await one(env,'SELECT * FROM matches WHERE id=?',id);
  if(!row) throw new HttpError(404,'MATCH_NOT_FOUND');
  return {...row,data:JSON.parse(row.snapshot)};
}
export async function loadEvents(env,id) {
  return (await rows(env,'SELECT body,hash FROM events WHERE match_id=? ORDER BY seq',id))
    .map(row=>({...JSON.parse(row.body),hash:row.hash}));
}
export async function chainEvents(matchId,seq,head,inputs,timestamp) {
  const out=[];
  for(const input of inputs) {
    const body={schemaVersion:1,matchId,seq:++seq,type:input.type,utcMs:timestamp,
      source:'server',prevHash:head,payload:input.payload??{}};
    head=await sha256(canonical(body)); out.push({...body,hash:head});
  }
  return {events:out,seq,head};
}
const eventInsert = (env,event,guard=null) => {
  const {hash,...body}=event;
  if(!guard) return env.DB.prepare('INSERT INTO events(match_id,seq,event_type,utc_ms,prev_hash,hash,body) VALUES(?,?,?,?,?,?,?)')
    .bind(event.matchId,event.seq,event.type,event.utcMs,event.prevHash,hash,canonical(body));
  return env.DB.prepare(`INSERT INTO events(match_id,seq,event_type,utc_ms,prev_hash,hash,body)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM matches WHERE id=? AND last_write=?)`)
    .bind(event.matchId,event.seq,event.type,event.utcMs,event.prevHash,hash,canonical(body),event.matchId,guard);
};
export async function insertMatch(env,data,createKey,createHash) {
  const chain=await chainEvents(data.id,0,GENESIS,[{type:'match.started',payload:{manifest:data.manifest,
    humanDisc:data.humanDisc,ranked:data.ranked,createdState:data.state}}],now(env));
  const tag=randomToken(16);
  const statement=env.DB.prepare(`INSERT INTO matches(id,user_id,guest_session,create_key,create_hash,difficulty,opponent_version,
    human_disc,ranked,eligible,guild_id,channel_id,status,result,started_at,finished_at,deadline_at,
    version,event_seq,event_head,last_write,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(data.id,data.userId,data.guestSession,createKey,createHash,data.difficulty,data.opponentVersion,
      data.humanDisc,data.ranked?1:0,0,data.guildId,data.channelId,data.status,null,data.startedAt,null,data.deadlineAt,
      0,chain.seq,chain.head,tag,JSON.stringify(data));
  await env.DB.batch([statement,...chain.events.map(e=>eventInsert(env,e))]);
  return loadMatch(env,data.id);
}
/** All dependent writes are guarded by a unique CAS marker; a zero-row CAS cannot append events. */
export async function commitMatch(env,current,data,eventInputs,command=null) {
  const tag=randomToken(16), version=current.version+1;
  const chain=await chainEvents(current.id,current.event_seq,current.event_head,eventInputs,now(env));
  const update=env.DB.prepare(`UPDATE matches SET status=?,result=?,eligible=?,finished_at=?,version=?,event_seq=?,event_head=?,
      last_write=?,snapshot=? WHERE id=? AND version=?`)
    .bind(data.status,data.result??null,data.eligible?1:0,data.finishedAt??null,version,chain.seq,chain.head,tag,JSON.stringify(data),current.id,current.version);
  const batch=[update,...chain.events.map(e=>eventInsert(env,e,tag))];
  if(command) batch.push(env.DB.prepare(`INSERT INTO commands(match_id,command_key,request_hash,accepted_version)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM matches WHERE id=? AND last_write=?)`)
    .bind(current.id,command.key,command.hash,version,current.id,tag));
  const results=await env.DB.batch(batch);
  if(results[0].meta.changes!==1) throw new HttpError(409,'STALE_MATCH');
  return loadMatch(env,current.id);
}
/** Atomic fixed-window quota. Keys are HMAC buckets, never raw addresses. */
export async function consumeQuota(env,bucket,name,limit,expiresAt) {
  const row=await env.DB.prepare(`INSERT INTO counters(bucket,name,value,expires_at) VALUES(?,?,1,?)
    ON CONFLICT(bucket,name) DO UPDATE SET value=value+1,expires_at=excluded.expires_at
    WHERE counters.value < ? RETURNING value`).bind(bucket,name,expiresAt,limit).first();
  if(!row) throw new HttpError(429,'RATE_LIMITED'); return row.value;
}
export async function countOperation(env,name) {
  // Call sites supply fixed, bounded labels; never interpolate URLs or exception messages.
  const date=new Date(now(env)).toISOString().slice(0,10);
  await run(env,`INSERT INTO counters(bucket,name,value,expires_at) VALUES(?,?,1,?)
    ON CONFLICT(bucket,name) DO UPDATE SET value=value+1`,date,`op:${name}`,now(env)+30*86400000);
}
