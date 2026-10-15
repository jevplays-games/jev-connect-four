// Connect Four -> Choice Four rename: pre-rename identifiers, exports and hostnames keep working.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {environment,client} from './helpers.js';
import {auditExport,AUDIT_FORMAT} from '../server/audit.js';
import {GAME_ID,LEGACY_GAME_ID,choiceFour} from '../public/rules.js';
import {randomToken,utf8,now} from '../server/util.js';
import worker,{servedOrigins} from '../server/worker.js';
const legacyFixture=async()=>JSON.parse(await readFile(new URL('../examples/mock-provider-match-audit.json',import.meta.url),'utf8'));
const hex=bytes=>[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');

test('a pre-rename v1 audit export still verifies with its original replay hash',async()=>{
  const exp=await legacyFixture();
  assert.equal(exp.format,'jev-connect-four-audit/1');
  const result=await auditExport(exp);
  assert.equal(result.ok,true,JSON.stringify(result.errors));
  // Recorded from main at 2aa2d2c, before the rename. The v1 hash domain must never change.
  assert.equal(result.replayHash,'9f78dfb9bcf450fcf6e62b7ff32b72dd72413c41caf0a8c4fa8ce5141fac6b6f');
});

test('new exports use the Choice Four format; both names verify and other audit formats are refused',async t=>{
  const env=environment();t.after(()=>env.DB.close());const c=await client(env);
  let m=(await c.start()).data;m=(await c.drop(m,3)).data;
  const exp=(await c.call(`/api/matches/${m.id}/export`)).data;
  assert.equal(exp.format,AUDIT_FORMAT);assert.equal(AUDIT_FORMAT,'jev-choice-four-audit/1');
  assert.equal((await auditExport(exp)).ok,true);
  const legacy=await auditExport({...exp,format:'jev-connect-four-audit/1'});
  assert.equal(legacy.ok,true);assert.equal(legacy.replayHash,(await auditExport(exp)).replayHash);
  assert.deepEqual((await auditExport({...exp,format:'jev-other-game-audit/1'})).errors,['UNSUPPORTED_FORMAT']);
});

test('create-match accepts choice-four and the connect-four alias, and rejects other games',async t=>{
  assert.equal(choiceFour.id,GAME_ID);assert.equal(GAME_ID,'choice-four');assert.equal(LEGACY_GAME_ID,'connect-four');
  const env=environment();t.after(()=>env.DB.close());const c=await client(env);
  assert.equal((await c.start({gameId:'choice-four'})).status,201);
  const c2=await client(env);assert.equal((await c2.start({gameId:'connect-four'})).status,201);
  const c3=await client(env),r=await c3.start({gameId:'guess-who'});
  assert.equal(r.status,400);assert.equal(r.data.error,'UNSUPPORTED_GAME');
});

test('replays keep the jev-arcade-replay/1 format with the pre-rename game id',async t=>{
  const env=environment();t.after(()=>env.DB.close());const c=await client(env);
  const m=(await c.start()).data,r=(await c.call(`/api/matches/${m.id}/replay`)).data;
  assert.equal(r.format,'jev-arcade-replay/1');assert.equal(r.game,'connect-four');assert.equal(r.rulesVersion,1);
});

test('the legacy hostname is still served as itself; unknown hosts are refused',async t=>{
  const legacy='http://127.0.0.1:8787';
  const env=environment({LEGACY_ORIGINS:legacy,DISCORD_CLIENT_ID:'423456789012345678',DISCORD_CLIENT_SECRET:'test'});t.after(()=>env.DB.close());
  const send=(origin,path)=>worker.fetch(new Request(origin+path),env,{waitUntil(){}});
  assert.equal((await send(env.APP_ORIGIN,'/api/health')).status,200);
  assert.equal((await send(legacy,'/api/health')).status,200);
  const other=await send('http://[::1]:8787','/api/health');assert.equal(other.status,400);assert.equal((await other.json()).error,'HOST_REJECTED');
  // OAuth on the old host returns to the old host, where its cookie lives.
  const oauth=await send(legacy,'/api/auth/discord');assert.equal(oauth.status,302);
  assert.equal(new URL(oauth.headers.get('location')).searchParams.get('redirect_uri'),`${legacy}/api/auth/discord/callback`);
  // A guest on the old host can play: Origin and CSRF checks follow the host the request arrived on.
  const old=await client(env,{origin:legacy});const started=await old.start();
  assert.equal(started.status,201,JSON.stringify(started.data));
});

test('a malformed LEGACY_ORIGINS entry is ignored and logged instead of failing every request',async t=>{
  const legacy='http://127.0.0.1:8787',env=environment({LEGACY_ORIGINS:`not a url, javascript:alert(1) ,${legacy}`});t.after(()=>env.DB.close());
  const warned=[];t.mock.method(console,'warn',(...args)=>warned.push(args.join(' ')));
  const send=origin=>worker.fetch(new Request(origin+'/api/health'),env,{waitUntil(){}});
  assert.equal((await send(env.APP_ORIGIN)).status,200);
  assert.equal((await send(legacy)).status,200);
  const other=await send('http://[::1]:8787');assert.equal(other.status,400);assert.equal((await other.json()).error,'HOST_REJECTED');
  assert.ok(warned.some(w=>w.includes('LEGACY_ORIGIN_IGNORED')&&w.includes('not a url')),warned.join('\n'));
  assert.ok(warned.some(w=>w.includes('javascript:alert(1)')),warned.join('\n'));
});

test('D9: LEGACY_ORIGINS entries that are not a bare origin are refused, not normalised',async t=>{
  const legacy='http://127.0.0.1:8787';
  for(const bad of ['https://user:pw@evil.example','https://evil.example#@connect-four.jevplay.games','https://evil.example/path','https://evil.example?q=1','https://*.jevplay.games']){
    const env=environment({LEGACY_ORIGINS:`${bad},${legacy}`});t.after(()=>env.DB.close());
    const warned=[];const warn=t.mock.method(console,'warn',(...args)=>warned.push(args.join(' ')));
    const send=origin=>worker.fetch(new Request(origin+'/api/health'),env,{waitUntil(){}});
    assert.deepEqual(servedOrigins(env),[env.APP_ORIGIN,legacy],bad);
    for(const host of ['https://evil.example','https://x.jevplay.games']){
      const res=await send(host);assert.equal(res.status,400,`${bad} admitted ${host}`);assert.equal((await res.json()).error,'HOST_REJECTED');
    }
    assert.equal((await send(env.APP_ORIGIN)).status,200,bad);
    assert.equal((await send(legacy)).status,200,bad);
    assert.ok(warned.some(w=>w.includes('LEGACY_ORIGIN_IGNORED')&&w.includes(JSON.stringify({entry:bad}))),warned.join('\n'));
    warn.mock.restore();
  }
  // A bare origin, with or without one trailing slash, is still accepted.
  assert.deepEqual(servedOrigins({APP_ORIGIN:'https://choice-four.jevplay.games',LEGACY_ORIGINS:'https://connect-four.jevplay.games, https://connect-four.jevplay.games/'}),
    ['https://choice-four.jevplay.games','https://connect-four.jevplay.games','https://connect-four.jevplay.games']);
});

test('a Discord launch received on the legacy host links to the canonical Choice Four origin',async t=>{
  const legacy='http://127.0.0.1:8787',env=environment({LEGACY_ORIGINS:legacy});t.after(()=>env.DB.close());
  const keys=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
  env.DISCORD_PUBLIC_KEY=hex(await crypto.subtle.exportKey('raw',keys.publicKey));env.DISCORD_CLIENT_ID='423456789012345678';
  const raw=JSON.stringify({type:2,id:randomToken(8),application_id:env.DISCORD_CLIENT_ID,context:0,data:{name:'play',options:[{name:'game',value:'connect-four'}]},
    guild_id:'223456789012345678',channel_id:'323456789012345678',channel:{type:0},member:{user:{id:'123456789012345678'}},
    authorizing_integration_owners:{'0':'223456789012345678'}});
  const timestamp=String(Math.floor(now(env)/1000)),signature=hex(await crypto.subtle.sign('Ed25519',keys.privateKey,utf8(timestamp+raw)));
  const response=await worker.fetch(new Request(legacy+'/api/discord/interactions',{method:'POST',
    headers:{'content-type':'application/json','x-signature-timestamp':timestamp,'x-signature-ed25519':signature},body:raw}),env);
  const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));
  assert.match(data.data.content,/^Play Choice Four against Jev\./);
  const button=data.data.components[0].components[0];
  assert.equal(button.label,'Play Choice Four');assert.equal(new URL(button.url).origin,env.APP_ORIGIN);
});
