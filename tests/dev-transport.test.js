// scripts/dev.mjs request path: absolute-form targets with credentials are a 400, never a 500, and D9 host checks are unchanged.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import http from 'node:http';import net from 'node:net';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const freePort=()=>new Promise((ok,fail)=>{const s=net.createServer();s.on('error',fail);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>ok(port));});});
// Send the target verbatim (absolute-form allowed), so the server sees exactly what a raw client would send.
const raw=(port,target)=>new Promise((ok,fail)=>{const req=http.request({host:'127.0.0.1',port,path:target,method:'GET'},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>ok({status:res.statusCode,body}));});req.on('error',fail);req.end();});

test('dev server: userinfo request targets are refused with 400; canonical and legacy hosts still served',async t=>{
  const port=await freePort(),origin=`http://127.0.0.1:${port}`,legacy=`http://localhost:${port}`;
  const child=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,stdio:['ignore','pipe','pipe'],
    env:{...process.env,NODE_ENV:'development',PORT:String(port),APP_ORIGIN:origin,LEGACY_ORIGINS:legacy,TYPESAFE_API_KEY:'',DISCORD_CLIENT_ID:''}});
  let stderr='';child.stderr.on('data',c=>stderr+=c);
  t.after(()=>child.kill('SIGTERM'));
  let up=false;for(let i=0;i<100&&!up;i++){try{up=(await raw(port,'/api/health')).status===200;}catch{}if(!up)await new Promise(r=>setTimeout(r,100));}
  assert.ok(up,'dev server did not start');

  for(const target of ['https://user:pw@evil.example/api/health','https://:pw@evil.example/api/health',`http://user@127.0.0.1:${port}/api/health`]){
    const res=await raw(port,target);
    assert.equal(res.status,400,`${target}: ${res.status} ${res.body}`);
    assert.equal(JSON.parse(res.body).error,'BAD_REQUEST_TARGET');
  }
  // D9 behaviour unchanged: evil hosts are rejected by the Worker, canonical and real legacy hosts are served.
  for(const target of ['https://evil.example/api/health','http://evil.example/api/health']){
    const res=await raw(port,target);assert.equal(res.status,400,target);assert.equal(JSON.parse(res.body).error,'HOST_REJECTED');
  }
  assert.equal((await raw(port,'/api/health')).status,200);
  assert.equal((await raw(port,`${legacy}/api/health`)).status,200);
  assert.doesNotMatch(stderr,/Local transport error/);
});
