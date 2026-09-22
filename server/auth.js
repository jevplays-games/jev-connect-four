import {one,rows,run,countOperation,consumeQuota} from './db.js';
import {assert,randomToken,sha256,hmac,equal,now,json,HttpError,utf8,readText} from './util.js';
const WEEK=7*86400000;
export function localMode(env) {
  return env.DEV_LOCAL==='1'&&['localhost','127.0.0.1','[::1]'].includes(new URL(env.APP_ORIGIN).hostname);
}
export function cookieName(env) {return localMode(env)?'jev-local':'__Host-jev-session';}
export function sessionCookie(env,token,age=WEEK/1000) {
  return `${cookieName(env)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${localMode(env)?'':'; Secure'}`;
}
function cookieToken(request,env) {
  const entries=(request.headers.get('cookie')||'').split(';').map(p=>p.trim().split('='));
  const found=entries.find(([k])=>k===cookieName(env))?.[1];
  return /^[0-9a-f]{64}$/.test(found||'')?found:null;
}
export async function getSession(request,env,create=false) {
  const token=cookieToken(request,env),hash=token?await sha256(token):null;
  const found=hash?await one(env,'SELECT * FROM sessions WHERE token_hash=? AND expires_at>?',hash,now(env)):null;
  if(found)return {...found,setCookie:null};
  if(!create)throw new HttpError(401,'SESSION_REQUIRED');
  const timestamp=now(env),day=new Date(timestamp).toISOString().slice(0,10);
  const address=request.headers.get('cf-connecting-ip')||request.headers.get('x-local-address')||'unavailable';
  await consumeQuota(env,await hmac(env.APP_SECRET,`session:${day}:${address}`),'new_session',500,timestamp+2*86400000);
  const raw=randomToken(),token_hash=await sha256(raw);
  await run(env,'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,NULL,?,?)',token_hash,timestamp,timestamp+WEEK);
  return {token_hash,user_id:null,created_at:timestamp,expires_at:timestamp+WEEK,pending_launch:null,setCookie:sessionCookie(env,raw)};
}
export async function csrfFor(session,env) {return hmac(env.APP_SECRET,`csrf:${session.token_hash}`);}
export async function checkMutation(request,env,session) {
  assert(request.headers.get('origin')===new URL(env.APP_ORIGIN).origin,403,'ORIGIN_REJECTED');
  assert(equal(request.headers.get('x-csrf-token'),await csrfFor(session,env)),403,'CSRF_REJECTED');
}
export async function userFor(env,session) {return session.user_id?one(env,'SELECT * FROM users WHERE id=?',session.user_id):null;}
export async function contextFor(env,session,id) {
  assert(session.user_id,401,'DISCORD_LOGIN_REQUIRED');
  const context=await one(env,'SELECT * FROM context_grants WHERE id=? AND user_id=? AND session_hash=? AND expires_at>?',
    id,session.user_id,session.token_hash,now(env));
  assert(context,403,'CONTEXT_EXPIRED_OR_INVALID');return context;
}
export async function me(request,env) {
  const session=await getSession(request,env,true),user=await userFor(env,session);
  const contexts=user?await rows(env,'SELECT id,guild_id,channel_id,verified_at,expires_at FROM context_grants WHERE user_id=? AND session_hash=? AND expires_at>? ORDER BY verified_at DESC',user.id,session.token_hash,now(env)):[];
  const active=await one(env,`SELECT id FROM matches WHERE ${user?'user_id':'guest_session'}=? AND status IN ('active','thinking','interrupted') ORDER BY started_at DESC LIMIT 1`,user?.id||session.token_hash);
  const adminIds=(env.ADMIN_DISCORD_IDS||'').split(',').map(x=>x.trim());
  return json({user:user?{id:user.id,displayName:user.display_name}:null,csrf:await csrfFor(session,env),contexts,
    activeMatchId:active?.id??null,jevConfigured:!!env.TYPESAFE_API_KEY,discordConfigured:!!(env.DISCORD_CLIENT_ID&&env.DISCORD_CLIENT_SECRET),
    model:env.JEV_MODEL||'jev-1.13.0',isAdmin:!!user&&adminIds.includes(user.discord_id),
    privacy:{clientTelemetry:'opt-in',auditRetentionDays:Number(env.AUDIT_RETENTION_DAYS||90)}},200,
    session.setCookie?{'Set-Cookie':session.setCookie}:{});
}
export async function startOAuth(request,env) {
  assert(env.DISCORD_CLIENT_ID&&env.DISCORD_CLIENT_SECRET,503,'DISCORD_NOT_CONFIGURED');
  const s=await getSession(request,env,true),state=randomToken();
  await run(env,'INSERT INTO tickets(token_hash,kind,session_hash,issued_at,expires_at) VALUES(?,?,?,?,?)',
    await sha256(state),'oauth',s.token_hash,now(env),now(env)+600000);
  const url=new URL('https://discord.com/oauth2/authorize');
  for(const [k,v] of Object.entries({client_id:env.DISCORD_CLIENT_ID,response_type:'code',scope:'identify',
    redirect_uri:`${env.APP_ORIGIN}/api/auth/discord/callback`,state}))url.searchParams.set(k,v);
  await countOperation(env,'oauth_started');
  return new Response(null,{status:302,headers:{Location:url.toString(),...(s.setCookie?{'Set-Cookie':s.setCookie}:{})}});
}
export async function callbackOAuth(request,env) {
  const url=new URL(request.url),s=await getSession(request,env),state=url.searchParams.get('state');
  assert(state&&/^[0-9a-f]{64}$/.test(state),400,'OAUTH_STATE_INVALID');
  const ticket=await one(env,"SELECT * FROM tickets WHERE token_hash=? AND kind='oauth' AND session_hash=? AND consumed_at IS NULL AND expires_at>?",await sha256(state),s.token_hash,now(env));
  assert(ticket,400,'OAUTH_STATE_INVALID');
  const claimed=await run(env,'UPDATE tickets SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL',now(env),ticket.token_hash);
  assert(claimed.meta.changes===1,400,'OAUTH_STATE_REUSED');
  if(url.searchParams.has('error'))return new Response(null,{status:302,headers:{Location:`${env.APP_ORIGIN}/?auth=denied`}});
  const code=url.searchParams.get('code');assert(code&&code.length<1024,400,'OAUTH_CODE_MISSING');
  const fetcher=env.FETCH||fetch;
  const response=await fetcher('https://discord.com/api/oauth2/token',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
      client_id:env.DISCORD_CLIENT_ID,client_secret:env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',
      code,redirect_uri:`${env.APP_ORIGIN}/api/auth/discord/callback`}),signal:AbortSignal.timeout(5000)});
  assert(response.ok,502,'DISCORD_TOKEN_EXCHANGE_FAILED');
  const tokens=await response.json();assert(typeof tokens.access_token==='string',502,'DISCORD_TOKEN_INVALID');
  const profileResponse=await fetcher('https://discord.com/api/v10/users/@me',{
    headers:{Authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(5000)});
  assert(profileResponse.ok,502,'DISCORD_IDENTITY_FAILED');
  const user=await profileResponse.json();
  assert(typeof user.id==='string'&&/^\d{15,22}$/.test(user.id),502,'DISCORD_IDENTITY_INVALID');
  const display=String(user.global_name||user.username||'Player').slice(0,80),timestamp=now(env);
  await run(env,`INSERT INTO users(id,discord_id,display_name,created_at,last_seen_at) VALUES(?,?,?,?,?)
    ON CONFLICT(discord_id) DO UPDATE SET display_name=excluded.display_name,last_seen_at=excluded.last_seen_at`,
    crypto.randomUUID(),user.id,display,timestamp,timestamp);
  const stored=await one(env,'SELECT * FROM users WHERE discord_id=?',user.id);
  const raw=randomToken(),hash=await sha256(raw);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions(token_hash,user_id,pending_launch,created_at,expires_at) VALUES(?,?,?,?,?)')
      .bind(hash,stored.id,s.pending_launch??null,timestamp,timestamp+WEEK),
    env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(s.token_hash)
  ]);
  if(s.pending_launch) {
    try {await redeemLaunch(env,{token_hash:hash,user_id:stored.id},null,s.pending_launch);}
    catch { /* Expired/wrong-user launch does not invalidate a successful identity login. */ }
  }
  await countOperation(env,'oauth_completed');
  return new Response(null,{status:302,headers:{Location:`${env.APP_ORIGIN}/`,'Set-Cookie':sessionCookie(env,raw)}});
}
export async function redeemLaunch(env,session,raw,knownHash=null) {
  if(!knownHash)assert(typeof raw==='string'&&/^[0-9a-f]{64}$/.test(raw),400,'LAUNCH_TICKET_INVALID');
  const hash=knownHash||await sha256(raw),timestamp=now(env);
  const ticket=await one(env,"SELECT * FROM tickets WHERE token_hash=? AND kind='launch' AND consumed_at IS NULL AND expires_at>?",hash,timestamp);
  assert(ticket,403,'LAUNCH_TICKET_EXPIRED_OR_USED');
  if(!session.user_id) {
    await run(env,'UPDATE sessions SET pending_launch=? WHERE token_hash=?',hash,session.token_hash);
    return {requiresLogin:true};
  }
  const user=await userFor(env,session);assert(user.discord_id===ticket.discord_id,403,'LAUNCH_WRONG_DISCORD_USER');
  const marker=randomToken(16),id=crypto.randomUUID();
  const result=await env.DB.batch([
    env.DB.prepare('UPDATE tickets SET consumed_at=?,session_hash=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?')
      .bind(timestamp,marker,hash,timestamp),
    env.DB.prepare(`INSERT INTO context_grants(id,user_id,session_hash,guild_id,channel_id,verified_at,expires_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tickets WHERE token_hash=? AND session_hash=?)`)
      .bind(id,user.id,session.token_hash,ticket.guild_id,ticket.channel_id,ticket.issued_at,ticket.expires_at,hash,marker),
    env.DB.prepare('UPDATE sessions SET pending_launch=NULL WHERE token_hash=?').bind(session.token_hash)
  ]);
  assert(result[0].meta.changes===1,409,'LAUNCH_TICKET_ALREADY_USED');
  return {requiresLogin:false,id,guildId:ticket.guild_id,channelId:ticket.channel_id,expiresAt:ticket.expires_at};
}
function unhex(s) { return Uint8Array.from(s.match(/.{2}/g)||[],x=>parseInt(x,16)); }
export async function verifyDiscordSignature(raw,signature,timestamp,publicKey,clock=Date.now()) {
  if(!/^[0-9a-fA-F]{128}$/.test(signature||'')||!/^\d{10,13}$/.test(timestamp||'')||!/^([0-9a-fA-F]{64})$/.test(publicKey||''))return false;
  const age=clock-Number(timestamp)*1000;if(age>300000||age< -10000)return false;
  try {const key=await crypto.subtle.importKey('raw',unhex(publicKey),{name:'Ed25519'},false,['verify']);
    return await crypto.subtle.verify('Ed25519',key,unhex(signature),utf8(timestamp+raw));}catch{return false;}
}
export async function discordInteraction(request,env) {
  assert(env.DISCORD_PUBLIC_KEY&&env.DISCORD_CLIENT_ID,503,'DISCORD_NOT_CONFIGURED');
  const raw=await readText(request,65536);
  assert(await verifyDiscordSignature(raw,request.headers.get('x-signature-ed25519'),request.headers.get('x-signature-timestamp'),env.DISCORD_PUBLIC_KEY,now(env)),401,'DISCORD_SIGNATURE_INVALID');
  let i;try{i=JSON.parse(raw);}catch{throw new HttpError(400,'INVALID_JSON');}
  if(i.type===1)return json({type:1});
  assert(i.application_id===env.DISCORD_CLIENT_ID,403,'WRONG_DISCORD_APPLICATION');
  const message=content=>json({type:4,data:{flags:64,content}});
  if(i.type!==2||i.data?.name!=='play')return message('Use /play to launch Connect Four.');
  if(i.context!==0||!i.guild_id||!i.channel_id||i.channel?.type!==0||!i.member?.user?.id||i.authorizing_integration_owners?.['0']!==i.guild_id)
    return message('Launch from a regular text channel in a server where this application is installed.');
  const rawTicket=randomToken(),timestamp=now(env);
  try {await run(env,`INSERT INTO tickets(token_hash,kind,discord_id,guild_id,channel_id,interaction_id,issued_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?)`,await sha256(rawTicket),'launch',i.member.user.id,i.guild_id,i.channel_id,i.id,timestamp,timestamp+600000);}
  catch(e){if(/UNIQUE/i.test(e.message))return message('This launch was already handled. Run /play again for a fresh link.');throw e;}
  return json({type:4,data:{flags:64,content:'Play Connect Four against JEV. Sign in with the same Discord account. This community link expires in 10 minutes.',
    components:[{type:1,components:[{type:2,style:5,label:'Play Connect Four',url:`${env.APP_ORIGIN}/#launch=${rawTicket}`}]}]}});
}
