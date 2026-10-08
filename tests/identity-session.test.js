import test from 'node:test';import assert from 'node:assert/strict';
import {environment} from './helpers.js';
import worker from '../server/worker.js';
import {randomToken} from '../server/util.js';
// A cookie-less /api/me creates its own guest session and Set-Cookie, and the CSRF token belongs to that session. The page therefore
// must never have two /api/me requests in flight at once: whichever Set-Cookie lands last is the cookie the browser keeps.
// Real Worker handler, in-memory database, offline stub provider; the cookie jar below models a browser. No tokens are printed.
const call=async(env,path,{method='GET',cookie='',csrf='',body,key}={})=>{
  const request=new Request(env.APP_ORIGIN+path,{method,headers:{...(cookie?{cookie}:{}),...(method==='GET'?{}:{origin:env.APP_ORIGIN,'x-csrf-token':csrf,'content-type':'application/json'}),...(key?{'idempotency-key':key}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const tasks=[],response=await worker.fetch(request,env,{waitUntil:p=>tasks.push(p)});await Promise.all(tasks);
  const set=response.headers.get('set-cookie'),data=await response.json();
  return {status:response.status,data,cookie:set?set.split(';')[0]:null};
};
const unranked=(env,jar,csrf)=>call(env,'/api/matches',{method:'POST',cookie:jar,csrf,key:randomToken(12),body:{difficulty:'normal',ranked:false,humanDisc:1}});
test('two overlapping cold /api/me requests create two sessions, and the older Set-Cookie landing last breaks the newest CSRF token',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  const [older,newer]=await Promise.all([call(env,'/api/me'),call(env,'/api/me')]);
  assert.ok(older.cookie&&newer.cookie,'each cold request received a Set-Cookie');
  assert.ok(older.cookie!==newer.cookie,'the two requests were given different sessions');
  assert.ok(older.data.csrf!==newer.data.csrf,'and different CSRF tokens');
  const jar=older.cookie;// the newest answer arrived first, the older one last
  const refused=await unranked(env,jar,newer.data.csrf);
  assert.equal(refused.status,403);assert.equal(refused.data.error,'CSRF_REJECTED');
  const coherent=await unranked(env,jar,older.data.csrf);
  assert.equal(coherent.status,201,'the same cookie with its own session CSRF token is accepted');
});
test('serialized cold /api/me requests share one session, so cookie and CSRF token agree whatever the page does next',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  const first=await call(env,'/api/me');assert.ok(first.cookie);
  const second=await call(env,'/api/me',{cookie:first.cookie});
  assert.equal(second.cookie,null,'the second request carried the cookie, so no new session was created');
  assert.ok(second.data.csrf===first.data.csrf,'and it reports the same CSRF token');
  const started=await unranked(env,first.cookie,second.data.csrf);
  assert.equal(started.status,201);assert.equal(started.data.ranked,false);
});
test('after sign-out the cookie is cleared and the next /api/me is cold again',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  const first=await call(env,'/api/me');
  const out=await call(env,'/api/logout',{method:'POST',cookie:first.cookie,csrf:first.data.csrf});
  assert.equal(out.status,200);assert.equal(out.cookie,'jev-local=','the browser is told to drop the session cookie');
  const again=await call(env,'/api/me');
  assert.ok(again.cookie&&again.cookie!==first.cookie,'a fresh guest session is issued');
});
