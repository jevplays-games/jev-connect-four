import test from 'node:test';import assert from 'node:assert/strict';
import {environment,client} from './helpers.js';
import {rows} from '../server/db.js';
// The page decides what to show for "Ranked match" from /api/me; the server decides what is allowed. Both are pinned here.
const matchCount=async env=>(await rows(env,'SELECT id FROM matches')).length;
test('/api/me reports the facts the Ranked match control is built from',async t=>{
  const configured=environment({DISCORD_CLIENT_ID:'client',DISCORD_CLIENT_SECRET:'secret'});t.after(()=>configured.DB.close());
  const guest=(await (await client(configured)).call('/api/me')).data;
  assert.deepEqual([guest.user,guest.jevConfigured,guest.discordConfigured],[null,true,true]);
  const signedIn=(await (await client(configured,{user:true,name:'Ranked Player'})).call('/api/me')).data;
  assert.equal(signedIn.user.displayName,'Ranked Player');assert.equal(signedIn.jevConfigured,true);
  const bare=environment({TYPESAFE_API_KEY:''});t.after(()=>bare.DB.close());
  const unconfigured=(await (await client(bare)).call('/api/me')).data;
  assert.deepEqual([unconfigured.jevConfigured,unconfigured.discordConfigured],[false,false]);
});
test('a ranked start still requires a Discord account, whatever the page shows',async t=>{
  const env=environment();t.after(()=>env.DB.close());const guest=await client(env);
  const refused=await guest.start({ranked:true});
  assert.equal(refused.status,401);assert.equal(refused.data.error,'DISCORD_LOGIN_REQUIRED');assert.equal(await matchCount(env),0);
  const unranked=await guest.start({ranked:false});assert.equal(unranked.status,201);assert.equal(unranked.data.ranked,false);
});
test('a signed-in player can start a ranked match; without the JEV key nobody can',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  const ranked=await (await client(env,{user:true})).start({ranked:true});
  assert.equal(ranked.status,201);assert.equal(ranked.data.ranked,true);
  const bare=environment({TYPESAFE_API_KEY:''});t.after(()=>bare.DB.close());
  const refused=await (await client(bare,{user:true})).start({ranked:true});
  assert.equal(refused.status,503);assert.equal(refused.data.error,'JEV_NOT_CONFIGURED');assert.equal(await matchCount(bare),0);
});
