import {localDatabase} from '../scripts/local-db.mjs';
import worker from '../server/worker.js';
import {randomToken,sha256,now} from '../server/util.js';
import {run} from '../server/db.js';
export function scoreResponse(request,preferred=3) {
  return {model:request.model,usage:{input_tokens:100,output_tokens:10},answers:Object.fromEntries(Object.entries(request.questions).map(([id,q])=>{
    const score=id.startsWith(`c${preferred}_`)?4:2;
    return [id,{type:'score',score,confidence:1,legend:Object.fromEntries(q.criteria.map((v,i)=>[String(i),v])),
      probabilities:Object.fromEntries(q.criteria.map((_,i)=>[String(i),i===score?1:0]))}];
  }))};
}
export function environment(overrides={}) {
  let time=1800000000000;
  const env={DB:localDatabase(),APP_ORIGIN:'http://localhost:8787',APP_SECRET:'test-secret-not-for-deployment-'.repeat(3),DEV_LOCAL:'1',
    CLOCK:()=>time,TYPESAFE_API_KEY:'test-only',JEV_MODEL:'jev-1.13.0',GUEST_DAILY_MATCH_LIMIT:'10000',USER_DAILY_MATCH_LIMIT:'10000',
    GLOBAL_DAILY_JEV_CALL_LIMIT:'10000',JEV_INPUT_USD_PER_MILLION:'0.042',
    ASSETS:{fetch:async()=>new Response('test asset')},FETCH:async(_url,init)=>Response.json(scoreResponse(JSON.parse(init.body))),...overrides};
  env.advance=ms=>{time+=ms;};
  return env;
}
export async function client(env,{user=false,discordId='123456789012345678',name='Test Player'}={}) {
  let cookie='',csrf='';
  async function call(path,method='GET',body,headers={}) {
    const req=new Request(env.APP_ORIGIN+path,{method,headers:{...(cookie?{cookie}:{}),
      ...(method==='GET'?{}:{origin:env.APP_ORIGIN,'x-csrf-token':csrf,'content-type':'application/json'}),...headers},
      ...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const tasks=[],response=await worker.fetch(req,env,{waitUntil:p=>tasks.push(p)});
    await Promise.all(tasks);
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    if(path==='/api/me'&&data.csrf)csrf=data.csrf;
    return {status:response.status,data,headers:response.headers};
  }
  await call('/api/me');
  if(user) {
    const id=crypto.randomUUID(),hash=await sha256(cookie.split('=')[1]);
    await run(env,'INSERT INTO users(id,discord_id,display_name,created_at,last_seen_at) VALUES(?,?,?,?,?)',id,discordId,name,now(env),now(env));
    await run(env,'UPDATE sessions SET user_id=? WHERE token_hash=?',id,hash);await call('/api/me');
  }
  return {call,get cookie(){return cookie;},get csrf(){return csrf;},
    start:(options={})=>call('/api/matches','POST',{difficulty:'normal',ranked:false,...options},{'Idempotency-Key':randomToken(12)}),
    async drop(m,column,key=randomToken(12)){return call(`/api/matches/${m.id}/commands`,'POST',{
      type:'drop',column,expectedRevision:m.revision,expectedStateHash:m.stateHash},{'Idempotency-Key':key});}};
}
