import test from 'node:test';import assert from 'node:assert/strict';
import {environment,client,scoreResponse} from './helpers.js';
import {sha256,utf8,now} from '../server/util.js';
import {rows,one} from '../server/db.js';
import {verifyDiscordSignature} from '../server/auth.js';
import worker from '../server/worker.js';
const hex=bytes=>[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
async function signedLaunch(env,userId='123456789012345678',channelId='323456789012345678') {
  const keys=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
  env.DISCORD_PUBLIC_KEY=hex(await crypto.subtle.exportKey('raw',keys.publicKey));env.DISCORD_CLIENT_ID='423456789012345678';
  const payload={type:2,id:crypto.randomUUID(),application_id:env.DISCORD_CLIENT_ID,context:0,data:{name:'play'},
    guild_id:'223456789012345678',channel_id:channelId,channel:{type:0},member:{user:{id:userId}},
    authorizing_integration_owners:{'0':'223456789012345678'}};
  const raw=JSON.stringify(payload),timestamp=String(Math.floor(now(env)/1000));
  const signature=hex(await crypto.subtle.sign('Ed25519',keys.privateKey,utf8(timestamp+raw)));
  const response=await worker.fetch(new Request(env.APP_ORIGIN+'/api/discord/interactions',{method:'POST',
    headers:{'content-type':'application/json','x-signature-timestamp':timestamp,'x-signature-ed25519':signature},body:raw}),env);
  const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));
  const url=new URL(data.data.components[0].components[0].url);return {ticket:new URLSearchParams(url.hash.slice(1)).get('launch'),raw,timestamp,signature,payload,keys};
}
test('Ed25519 rejects modified body, invalid signature and old timestamp',async t=>{const env=environment();t.after(()=>env.DB.close());const x=await signedLaunch(env);
 assert.equal(await verifyDiscordSignature(x.raw,x.signature,x.timestamp,env.DISCORD_PUBLIC_KEY,now(env)),true);
 assert.equal(await verifyDiscordSignature(x.raw+' ',x.signature,x.timestamp,env.DISCORD_PUBLIC_KEY,now(env)),false);
 assert.equal(await verifyDiscordSignature(x.raw,'0'.repeat(128),x.timestamp,env.DISCORD_PUBLIC_KEY,now(env)),false);
 assert.equal(await verifyDiscordSignature(x.raw,x.signature,x.timestamp,env.DISCORD_PUBLIC_KEY,now(env)+301000),false);
});
test('Discord PING also requires a valid signature',async t=>{const env=environment({DISCORD_PUBLIC_KEY:'0'.repeat(64),DISCORD_CLIENT_ID:'id'});t.after(()=>env.DB.close());
 const r=await worker.fetch(new Request(env.APP_ORIGIN+'/api/discord/interactions',{method:'POST',body:'{"type":1}'}),env);assert.equal(r.status,401);
});
test('launch ticket requires same authenticated Discord identity and is single-use',async t=>{const env=environment();t.after(()=>env.DB.close());const x=await signedLaunch(env),wrong=await client(env,{user:true,discordId:'523456789012345678'}),right=await client(env,{user:true});
 assert.equal((await wrong.call('/api/context/redeem','POST',{ticket:x.ticket})).status,403);
 const granted=await right.call('/api/context/redeem','POST',{ticket:x.ticket});assert.equal(granted.status,200);
 assert.equal((await right.call('/api/context/redeem','POST',{ticket:x.ticket})).status,403);
 assert.equal((await right.call('/api/me')).data.contexts.length,1);
 assert.equal((await wrong.call(`/api/leaderboard?scope=channel&contextId=${granted.data.id}`)).status,403);
});
test('context expiry cannot be renewed by editing a browser ID',async t=>{const env=environment();t.after(()=>env.DB.close());const x=await signedLaunch(env),c=await client(env,{user:true});const g=(await c.call('/api/context/redeem','POST',{ticket:x.ticket})).data;env.advance(600001);assert.equal((await c.call(`/api/leaderboard?scope=server&contextId=${g.id}`)).status,403);assert.equal((await c.start({contextId:g.id})).status,403);});
test('OAuth state is session-bound, single-use and expired states fail',async t=>{const env=environment({DISCORD_CLIENT_ID:'client',DISCORD_CLIENT_SECRET:'test'});t.after(()=>env.DB.close());const a=await client(env),b=await client(env);const start=await a.call('/api/auth/discord'),state=new URL(start.headers.get('location')).searchParams.get('state');
 assert.equal(new URL(start.headers.get('location')).searchParams.get('scope'),'identify');
 assert.equal((await b.call(`/api/auth/discord/callback?state=${state}&code=code`)).status,400);
 assert.equal((await a.call(`/api/auth/discord/callback?state=${state}&error=access_denied`)).status,302);
 assert.equal((await a.call(`/api/auth/discord/callback?state=${state}&error=access_denied`)).status,400);
 const again=await a.call('/api/auth/discord'),old=new URL(again.headers.get('location')).searchParams.get('state');env.advance(600001);assert.equal((await a.call(`/api/auth/discord/callback?state=${old}&code=code`)).status,400);
});
test('OAuth rotates session and completes a staged community launch without persisting tokens',async t=>{const env=environment({DISCORD_CLIENT_SECRET:'test-secret'});t.after(()=>env.DB.close());const x=await signedLaunch(env),c=await client(env);
 assert.equal((await c.call('/api/context/redeem','POST',{ticket:x.ticket})).data.requiresLogin,true);
 const oldCookie=c.cookie,start=await c.call('/api/auth/discord'),state=new URL(start.headers.get('location')).searchParams.get('state');
 env.FETCH=async(url,init)=>{
   if(url.endsWith('/oauth2/token')) {assert.equal(init.headers['Content-Type'],'application/x-www-form-urlencoded');return Response.json({access_token:'sensitive-access-token',refresh_token:'sensitive-refresh-token'});}
   if(url.endsWith('/users/@me'))return Response.json({id:'123456789012345678',global_name:'A <script>name</script>'});
   return Response.json(scoreResponse(JSON.parse(init.body)));
 };
 const callback=await c.call(`/api/auth/discord/callback?state=${state}&code=the-code`);assert.equal(callback.status,302);
 assert.notEqual(c.cookie,oldCookie);const me=(await c.call('/api/me')).data;assert.equal(me.user.displayName,'A <script>name</script>');assert.equal(me.contexts.length,1);
 const dump=JSON.stringify(await rows(env,'SELECT * FROM sessions'))+JSON.stringify(await rows(env,'SELECT * FROM users'));
 assert.ok(!dump.includes('sensitive-access-token'));assert.ok(!dump.includes('sensitive-refresh-token'));
 assert.equal(await one(env,'SELECT * FROM sessions WHERE token_hash=?',await sha256(oldCookie.split('=')[1])),null);
});
test('server/channel leaderboards require fresh matching context',async t=>{const env=environment();t.after(()=>env.DB.close());const x=await signedLaunch(env),c=await client(env,{user:true}),g=(await c.call('/api/context/redeem','POST',{ticket:x.ticket})).data;
 const m=(await c.start({ranked:true,contextId:g.id})).data;await c.call(`/api/matches/${m.id}/commands`,'POST',{type:'resign',expectedRevision:m.revision,expectedStateHash:m.stateHash},{'Idempotency-Key':'ctx-resign-123'});
 const q=`humanDisc=${m.humanDisc}&opponentVersion=${m.opponentVersion}`;
 assert.equal((await c.call(`/api/leaderboard?scope=channel&contextId=${g.id}&${q}`)).data.rows.length,1);
 const other=await signedLaunch(env,'123456789012345678','623456789012345678'),g2=(await c.call('/api/context/redeem','POST',{ticket:other.ticket})).data;
 assert.equal((await c.call(`/api/leaderboard?scope=channel&contextId=${g2.id}&${q}`)).data.rows.length,0);
 assert.equal((await c.call(`/api/leaderboard?scope=server&contextId=${g2.id}&${q}`)).data.rows.length,1);
});
