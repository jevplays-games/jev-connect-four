// Discord Activity support. Discord loads the game in an iframe on <application id>.discordsays.com, where a
// SameSite cookie is not sent, so the game signs the player in through the Embedded App SDK and then keeps a
// bearer session token in memory. Nothing here changes the normal browser sign-in.
import {assert,randomToken,sha256,hmac,json,readJSON,now} from './util.js';
import {run,consumeQuota} from './db.js';
import {activityOrigin,csrfFor,discordIdentity,upsertDiscordUser} from './auth.js';

const DAY=86400000;
export function activityConfig(env) {
  assert(env.DISCORD_CLIENT_ID&&env.DISCORD_CLIENT_SECRET,503,'DISCORD_NOT_CONFIGURED');
  return json({clientId:env.DISCORD_CLIENT_ID});
}
export async function createActivitySession(request,env) {
  assert(env.DISCORD_CLIENT_ID&&env.DISCORD_CLIENT_SECRET,503,'DISCORD_NOT_CONFIGURED');
  const origin=request.headers.get('origin');
  assert(origin&&(origin===activityOrigin(env)||origin===new URL(env.APP_ORIGIN).origin),403,'ORIGIN_REJECTED');
  const timestamp=now(env),day=new Date(timestamp).toISOString().slice(0,10);
  const address=request.headers.get('cf-connecting-ip')||request.headers.get('x-local-address')||'unavailable';
  await consumeQuota(env,await hmac(env.APP_SECRET,`activity-session:${day}:${address}`),'new_session',500,timestamp+2*DAY);
  const {code}=await readJSON(request);
  assert(typeof code==='string'&&code.length>0&&code.length<2048,400,'ACTIVITY_CODE_INVALID');
  // An SDK authorization code is exchanged without a redirect URI.
  const {identity,accessToken}=await discordIdentity(env,code,null);
  const user=await upsertDiscordUser(env,identity),raw=randomToken(),hash=await sha256(raw);
  await run(env,'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)',hash,user.id,timestamp,timestamp+DAY);
  // The Discord access token is returned once so the SDK can authenticate; it is never stored or logged.
  return json({token:raw,csrf:await csrfFor({token_hash:hash},env),accessToken,user:{id:user.id,displayName:user.display_name}});
}
