import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const inline=process.env.C4_INLINE_BROWSER==='1',port=process.env.C4_TEST_PORT||'8791',origin=`http://127.0.0.1:${port}`;
let server,browser;
test.before(async()=>{
  await mkdir(resolve(root,'test-results'),{recursive:true});
  if(!inline){server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:port,APP_ORIGIN:origin,TYPESAFE_API_KEY:'',DISCORD_CLIENT_ID:''},stdio:'pipe'});
    let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(origin+'/api/health');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw new Error('Browser test server did not start.');}
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
});
test.after(async()=>{await browser?.close();server?.kill('SIGTERM');});
async function openPage({width=1440,height=1100,reducedMotion='no-preference',setup,waitUntil='networkidle',hash=''}={}){
  const context=await browser.newContext({viewport:{width,height},reducedMotion});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(10000);
  await setup?.(page);
  if(inline){
    const get=name=>readFile(resolve(root,'public',name),'utf8');
    const bundle=async names=>(await Promise.all(names.map(get))).join('\n').replace(/^import .*?;\n/gm,'').replace(/\bexport (?=(?:const|function|async function|class))/g,'');
    const workerSource=await bundle(['rules.js','policy.js','fallback-worker.js']);
    let app=await bundle(['rules.js','policy.js','analytics.js','app.js']);
    app=app.replace("new Worker('/fallback-worker.js',{type:'module'})",`new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}],{type:'text/javascript'})))`);
    const mock=`const memoryStore=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:k=>memoryStore.get(k)??null,setItem:(k,v)=>memoryStore.set(k,String(v)),removeItem:k=>memoryStore.delete(k)}});
      window.fetch=async(path,init)=>{
      if(path==='/api/me')return Response.json({user:null,contexts:[],csrf:'offline-test',jevConfigured:false,discordConfigured:false,isAdmin:false});
      if(String(path).startsWith('/api/leaderboard'))return Response.json({rows:[],scope:'world',difficulty:'normal',humanDisc:1,opponentVersion:null,availableVersions:[],asOf:Date.now()});
      return Response.json({error:'OFFLINE_HARNESS'},{status:503});};`;
    const html=(await get('index.html')).replace('<script type="module" src="/app.js"></script>','')
      .replace('<script type="module" src="/brand/brand.js"></script>','')
      .replace('<link rel="stylesheet" href="/brand/brand.css">',`<style>${await get('brand/brand.css')}</style>`)
      .replace('<link rel="stylesheet" href="/game.css">',`<style>${await get('game.css')}</style>`);
    await page.setContent(html);await page.addScriptTag({content:mock+app});
    await page.addScriptTag({content:(await get('brand/brand.js')).replace(/\bexport (?=(?:const|function|async function|class))/g,'')});
  }else await page.goto(origin+hash,{waitUntil});
  await page.waitForFunction(()=>document.querySelector('#column-controls').children.length===7);
  return {page,context,errors};
}
test('desktop plays a local turn with real worker and shows decision evidence',async()=>{
  const {page,context,errors}=await openPage();await page.locator('#new-game').click();await page.locator('.column-button[data-column="3"]').click();
  await page.waitForFunction(()=>document.querySelector('#move-count').textContent==='02');
  assert.equal(await page.locator('#turn-label').textContent(),'Your turn');
  assert.match(await page.locator('#analysis-source').textContent(),/Local heuristic/);
  assert.equal(await page.locator('#candidate-chart .candidate-row').count(),7);
  assert.deepEqual(errors,[]);await page.screenshot({path:resolve(root,'test-results','desktop.png'),fullPage:true});await context.close();
});
test('keyboard interaction, board table and reduced motion',async()=>{
  const {page,context,errors}=await openPage({reducedMotion:'reduce'});await page.locator('#new-game').click();await page.locator('#game').focus();await page.keyboard.press('3');
  await page.waitForFunction(()=>document.querySelector('#move-count').textContent==='02');
  assert.equal(await page.locator('#board-table td').count(),42);
  assert.equal(await page.locator('#board .cell.last').evaluate(e=>getComputedStyle(e).animationName),'none');
  assert.deepEqual(errors,[]);await context.close();
});
test('mobile has no horizontal overflow and controls remain operable',async()=>{
  const {page,context,errors}=await openPage({width:390,height:844});await page.locator('#new-game').click();
  await page.locator('.column-button[data-column="0"]').click();await page.waitForFunction(()=>document.querySelector('#move-count').textContent==='02');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const controls=await page.locator('.column-button').first().boundingBox();assert.ok(controls.height>=44);
  assert.deepEqual(errors,[]);await page.screenshot({path:resolve(root,'test-results','mobile.png'),fullPage:true});await context.close();
});
test('analytics uses actual local observations, not invented model usage',async()=>{
  const {page,context,errors}=await openPage();await page.locator('#new-game').click();await page.locator('.column-button[data-column="3"]').click();
  await page.waitForFunction(()=>document.querySelector('#move-count').textContent==='02');await page.locator('[data-page="analytics"]').click();
  await page.waitForFunction(()=>document.querySelector('#analytics-kpis').children.length===4);
  assert.match(await page.locator('#analytics-coverage').textContent(),/Local practice measurements/);
  assert.match(await page.locator('#audit-badge').textContent(),/NOT VERIFIED/);
  assert.equal(await page.locator('#heatmap .heat-cell').count(),42);
  assert.deepEqual(errors,[]);await page.screenshot({path:resolve(root,'test-results','analytics.png'),fullPage:true});await context.close();
});
test('replay slider reconstructs prior positions without changing match',async()=>{
  const {page,context,errors}=await openPage();await page.locator('#new-game').click();await page.locator('.column-button[data-column="1"]').click();
  await page.waitForFunction(()=>document.querySelector('#move-count').textContent==='02');await page.locator('#inspect-replay').click();
  await page.locator('#replay-slider').fill('0');await page.locator('#replay-slider').dispatchEvent('input');
  assert.equal(await page.locator('#replay-board .disc-human,#replay-board .disc-jev').count(),0);
  await page.locator('[data-close="replay-dialog"]').click();assert.equal(await page.locator('#move-count').textContent(),'02');
  assert.deepEqual(errors,[]);await context.close();
});
test('local opponent first works at Hard difficulty; analysis toggle hides panel',async()=>{
  const {page,context,errors}=await openPage();await page.locator('#difficulty').selectOption('hard');await page.locator('#human-disc').selectOption('2');await page.locator('#new-game').click();
  await page.waitForFunction(()=>document.querySelector('#move-count').textContent==='01'&&document.querySelector('#turn-label').textContent==='Your turn');
  await page.locator('#show-analysis').uncheck();assert.equal(await page.locator('#analysis-body').isVisible(),false);
  assert.deepEqual(errors,[]);await context.close();
});

// ---- Ranked match availability (issue #11) ----
// "real server" tests load the page from the actual dev server with no TypeSafe key and no Discord credentials.
// "fixture" tests serve the same page but answer /api/me, /api/matches and /api/logout from the test, to reach the
// configured and signed-in states without secrets or a provider. They prove the page's behaviour; they are not
// evidence of a live JEV or Discord flow.
// "server-shaped" fixtures go one step further: /api/matches requests from the page are answered by the repository's real
// Worker handler (server/worker.js) running in this Node process on an in-memory database with the offline stub provider
// from tests/helpers.js. The response bodies are therefore the server's own, but the signed-in user is a database row
// created by the test: this is still offline fixture evidence, not Discord OAuth, a typed JEV call or the deployed server.
const real=inline?{skip:'needs the served page and a real server'}:{};
const meFixture=(extra={})=>({user:null,contexts:[],csrf:'fixture-csrf',activeMatchId:null,jevConfigured:true,discordConfigured:true,isAdmin:false,model:'jev-1.13.0',privacy:{clientTelemetry:'opt-in',auditRetentionDays:90},...extra});
const player={id:'fixture-user',displayName:'Fixture Player'};
async function serverShaped(user){
  const {environment,client}=await import('./helpers.js');
  const env=environment(),actor=await client(env,{user,name:player.displayName}),log=[];
  const handle=async route=>{const request=route.request(),url=new URL(request.url()),body=request.postData()?JSON.parse(request.postData()):undefined;
    const key=request.headers()['idempotency-key'];
    const result=await actor.call(url.pathname+url.search,request.method(),body,key?{'Idempotency-Key':key}:{});
    log.push({method:request.method(),path:url.pathname,status:result.status,requested:body,data:result.data});
    return route.fulfill({status:result.status,json:result.data});};
  const create=async options=>(await actor.start({difficulty:'normal',humanDisc:1,...options})).data;
  return {log,handle,create,close:()=>env.DB.close(),starts:()=>log.filter(entry=>entry.method==='POST'&&entry.path==='/api/matches')};
}
async function fixturePage(initial,options={}){
  let release;const hold=options.hold?new Promise(resolveHold=>{release=resolveHold;}):null;
  const shaped=options.serverShaped?await serverShaped(options.serverShaped.user):null;
  const fixture={me:initial,posts:[],auth:0,meGets:0,heldMe:{},redeems:[],release:()=>release?.(),releaseMe:(n,body,status)=>fixture.heldMe[n]({body,status}),shaped};
  const opened=await openPage({...options,waitUntil:hold||options.holdMe?'load':'networkidle',setup:async page=>{
    await page.route('**/api/me',async route=>{if(route.request().method()!=='GET')return route.continue();const n=++fixture.meGets;
      if(n<=(options.holdMe||0)){const answer=await new Promise(resolveMe=>{fixture.heldMe[n]=resolveMe;});return route.fulfill({status:answer.status||200,json:answer.body});}
      return route.fulfill({json:fixture.me});});
    await page.route('**/api/context/redeem',route=>{fixture.redeems.push({csrf:route.request().headers()['x-csrf-token'],meGets:fixture.meGets});return route.fulfill({json:{requiresLogin:false}});});
    await page.route(/\/api\/matches(\/|\?|$)/,async route=>{const request=route.request(),path=new URL(request.url()).pathname;
      if(shaped){if(request.method()==='POST'&&path==='/api/matches')fixture.posts.push(request.postDataJSON());return shaped.handle(route);}
      if(request.method()!=='POST'||path!=='/api/matches')return route.continue();
      fixture.posts.push(request.postDataJSON());if(fixture.posts.length===1&&hold)await hold;return route.fulfill({status:503,json:{error:'JEV_NOT_CONFIGURED'}});});
    await page.route('**/api/logout',route=>{fixture.me=meFixture({user:null,jevConfigured:fixture.me.jevConfigured,discordConfigured:fixture.me.discordConfigured});return route.fulfill({json:{ok:true}});});
    await page.route('**/api/auth/discord',route=>{fixture.auth++;return route.fulfill({contentType:'text/html',body:'<!doctype html><title>discord</title>'});});
  }});
  return {...opened,fixture};
}
const settled=async(page,fixture,posts=1)=>{
  for(const until=Date.now()+8000;fixture.posts.length<posts;){if(Date.now()>until)throw new Error('page did not finish starting');await page.waitForTimeout(50);}
  await page.waitForFunction(()=>!document.getElementById('new-game').disabled);
};
const ranked=page=>page.evaluate(()=>{const box=document.getElementById('ranked'),action=document.getElementById('ranked-action');
  return {label:box.closest('label').textContent.trim(),ariaDisabled:box.getAttribute('aria-disabled'),checked:box.checked,note:document.getElementById('ranked-note').textContent,
    action:action.hidden?null:action.textContent,describedBy:box.getAttribute('aria-describedby'),starting:document.getElementById('human-disc').disabled};});
test('real server: the ranked control is labelled Ranked match and says why it is unavailable',real,async()=>{
  const {page,context,errors}=await openPage();
  await page.waitForFunction(()=>document.getElementById('ranked-note').textContent.includes('no JEV connection configured'));
  const state=await ranked(page);
  assert.equal(state.label,'Ranked match');assert.equal(state.ariaDisabled,'true');assert.equal(state.checked,false);assert.equal(state.action,null);
  assert.equal(state.describedBy,'ranked-note');assert.match(state.note,/no JEV connection configured/);assert.match(state.note,/operator/);
  assert.doesNotMatch(await page.evaluate(()=>document.body.textContent),/official/i,'no Official wording left on the page');
  await page.locator('#ranked').focus();assert.equal(await page.evaluate(()=>document.activeElement.id),'ranked','unavailable control stays keyboard-focusable');
  await page.keyboard.press('Space');assert.equal(await page.locator('#ranked').isChecked(),false);
  assert.match(await page.locator('#notice').textContent(),/Ranked match is unavailable/);
  assert.deepEqual(errors,[]);await context.close();
});
test('fixture: JEV configured, guest, local practice offers Switch to JEV, then Connect Discord',real,async()=>{
  const {page,context,fixture,errors}=await fixturePage(meFixture());await settled(page,fixture);
  assert.equal(fixture.posts[0].ranked,false,'the automatic first game is never ranked');
  await page.selectOption('#mode','local');
  let state=await ranked(page);
  assert.equal(state.ariaDisabled,'true');assert.match(state.note,/needs the JEV opponent and a Discord account/);assert.equal(state.action,'Switch to JEV');
  await page.locator('#ranked-action').focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('#mode').inputValue(),'jev');
  state=await ranked(page);
  assert.match(state.note,/needs a Discord account/);assert.equal(state.action,'Connect Discord');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'ranked');
  await page.locator('#ranked-action').click();await page.waitForURL('**/api/auth/discord');assert.equal(fixture.auth,1);
  assert.deepEqual(errors,[]);await context.close();
});
test('fixture: Discord not configured gives an operator-facing reason and no dead button',real,async()=>{
  const {page,context,fixture,errors}=await fixturePage(meFixture({discordConfigured:false}));await settled(page,fixture);
  const state=await ranked(page);
  assert.equal(state.ariaDisabled,'true');assert.equal(state.action,null);assert.match(state.note,/no Discord sign-in configured/);assert.match(state.note,/Unranked JEV practice works/);
  assert.deepEqual(errors,[]);await context.close();
});
test('fixture: JEV not configured, even for a signed-in player, is explained as an operator setting',real,async()=>{
  const {page,context,fixture,errors}=await fixturePage(meFixture({user:player,jevConfigured:false}));
  await page.waitForFunction(()=>!document.getElementById('new-game').disabled);await page.waitForFunction(()=>document.getElementById('identity').textContent==='Fixture Player');
  const state=await ranked(page);
  assert.equal(state.ariaDisabled,'true');assert.equal(state.action,null);assert.match(state.note,/no JEV connection configured/);
  assert.equal(fixture.posts.length,0,'local mode never calls the match API');assert.deepEqual(errors,[]);await context.close();
});
test('fixture: a signed-in JEV player chooses ranked before starting, with keyboard alone',real,async()=>{
  const {page,context,fixture,errors}=await fixturePage(meFixture({user:player}));await settled(page,fixture);
  assert.equal(fixture.posts[0].ranked,false,'signing in does not start a ranked match by itself');
  let state=await ranked(page);
  assert.equal(state.ariaDisabled,'false');assert.equal(state.checked,false);assert.equal(state.action,null);assert.match(state.note,/Tick Ranked match before New game/);
  await page.locator('#ranked').focus();await page.keyboard.press('Space');
  state=await ranked(page);
  assert.equal(state.checked,true);assert.equal(state.starting,true,'ranked assigns the starting side');assert.match(state.note,/counts toward the leaderboard.*no undo.*24-hour deadline.*resignation is a loss/);
  await page.locator('#new-game').focus();await page.keyboard.press('Enter');
  await settled(page,fixture,2);assert.equal(fixture.posts[1].ranked,true);assert.equal(fixture.posts[1].difficulty,'jev');
  assert.deepEqual(errors,[]);await context.close();
});
test('fixture: the control refreshes on mode change, sign-out and returning to the tab',real,async()=>{
  const {page,context,fixture,errors}=await fixturePage(meFixture({user:player}));await settled(page,fixture);
  await page.check('#ranked');assert.equal((await ranked(page)).checked,true);
  await page.selectOption('#mode','local');
  let state=await ranked(page);
  assert.equal(state.ariaDisabled,'true');assert.equal(state.checked,false,'leaving JEV clears the tick');assert.equal(state.starting,false);assert.equal(state.action,'Switch to JEV');
  await page.selectOption('#mode','jev');state=await ranked(page);
  assert.equal(state.ariaDisabled,'false');assert.equal(state.checked,false,'the tick does not come back by itself');
  await page.check('#ranked');
  await page.evaluate(()=>document.getElementById('logout').click());
  await page.waitForFunction(()=>document.getElementById('ranked').getAttribute('aria-disabled')==='true');
  state=await ranked(page);
  assert.equal(state.checked,false,'sign-out clears a ranked tick');assert.match(state.note,/needs a Discord account/);assert.equal(state.action,'Connect Discord');
  await page.locator('#new-game').click();await settled(page,fixture,2);assert.equal(fixture.posts[1].ranked,false,'a stale tick is never sent after sign-out');
  fixture.me=meFixture({user:player});
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(()=>document.getElementById('ranked').getAttribute('aria-disabled')==='false');
  assert.deepEqual(errors,[]);await context.close();
});
test('fixture: ranked guidance fits a phone and a short landscape frame without overflow',real,async()=>{
  for(const [width,height] of [[320,568],[844,390]]){
    const {page,context,fixture,errors}=await fixturePage(meFixture(),{width,height});await settled(page,fixture);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`${width}x${height} has no horizontal overflow`);
    const box=await page.locator('#ranked-note').boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+1,`${width}x${height}: guidance stays on screen`);
    const target=await page.locator('#ranked-action').boundingBox();assert.ok(target.height>=43.5,'action is a full-size touch target');
    assert.deepEqual(errors,[]);await context.close();
  }
});
test('fixture: short landscape (844x390) keeps the ranked explanation and action next to the checkbox',real,async()=>{
  const {page,context,fixture,errors}=await fixturePage(meFixture(),{width:844,height:390});await settled(page,fixture);
  const shown=async()=>page.evaluate(()=>['ranked','ranked-note','ranked-action'].map(id=>{const el=document.getElementById(id);return [id,!el.hidden&&el.getClientRects().length>0];}));
  assert.deepEqual(await shown(),[['ranked',true],['ranked-note',true],['ranked-action',true]],'guest: checkbox, reason and Connect Discord are all visible');
  assert.match(await page.locator('#ranked-note').textContent(),/needs a Discord account/);
  await page.screenshot({path:resolve(root,'test-results','ranked-844x390-guest.png'),fullPage:true});
  await page.selectOption('#mode','local');
  assert.equal(await page.locator('#ranked-action').textContent(),'Switch to JEV');assert.equal(await page.locator('#ranked-action').isVisible(),true);
  await page.locator('#ranked-action').focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('#mode').inputValue(),'jev','the visible action works from the keyboard at 844x390');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.deepEqual(errors,[]);await context.close();
  const eligible=await fixturePage(meFixture({user:player}),{width:844,height:390});await settled(eligible.page,eligible.fixture);
  assert.equal(await eligible.page.locator('#ranked-note').isVisible(),true);assert.match(await eligible.page.locator('#ranked-note').textContent(),/Tick Ranked match before New game/);
  await eligible.page.locator('#ranked').focus();await eligible.page.keyboard.press('Space');
  assert.equal(await eligible.page.locator('#ranked-note').isVisible(),true);
  assert.match(await eligible.page.locator('#ranked-note').textContent(),/counts toward the leaderboard.*no undo.*24-hour deadline.*resignation is a loss/);
  await eligible.page.screenshot({path:resolve(root,'test-results','ranked-844x390-eligible.png'),fullPage:true});
  assert.deepEqual(eligible.errors,[]);await eligible.context.close();
});
test('fixture: picture-in-picture still hides the ranked control and its guidance together',real,async()=>{
  const {page,context,fixture,errors}=await fixturePage(meFixture({user:player}),{width:480,height:270});await settled(page,fixture);
  assert.equal(await page.locator('#ranked').isVisible(),false);assert.equal(await page.locator('#ranked-note').isVisible(),false);
  assert.deepEqual(errors,[]);await context.close();
});
test('fixture: a tab return while a game request is pending refreshes once it settles, without resending the game request',real,async()=>{
  const {page,context,fixture,errors}=await fixturePage(meFixture({user:player}),{hold:true});
  for(const until=Date.now()+8000;fixture.posts.length<1;){if(Date.now()>until)throw new Error('the held game request never arrived');await page.waitForTimeout(50);}
  assert.equal(await page.locator('#new-game').isDisabled(),true,'the page is busy while the request is held');
  assert.equal((await ranked(page)).ariaDisabled,'false');
  fixture.me=meFixture({user:null});const before=fixture.meGets;
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(300);
  assert.equal(fixture.meGets,before,'no identity request is made in the middle of the pending operation');
  assert.equal((await ranked(page)).ariaDisabled,'false','the control still shows the last known state while busy');
  fixture.release();
  await page.waitForFunction(()=>document.getElementById('ranked').getAttribute('aria-disabled')==='true');
  const state=await ranked(page);
  assert.equal(state.checked,false);assert.match(state.note,/needs a Discord account/);assert.equal(state.action,'Connect Discord');
  assert.equal(await page.evaluate(()=>document.getElementById('identity').textContent),'Guest');
  assert.equal(fixture.meGets,before+1,'exactly one deferred refresh, with no second visibility event');
  assert.equal(fixture.posts.length,1,'the game request is not retried');
  assert.deepEqual(errors,[]);await context.close();
});
test('fixture: configuration lost and restored, and a restored (bfcache) page, refresh the control',real,async()=>{
  const {page,context,fixture,errors}=await fixturePage(meFixture({user:player}));await settled(page,fixture);
  assert.equal((await ranked(page)).ariaDisabled,'false');
  const restored=()=>page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await page.check('#ranked');
  fixture.me=meFixture({user:player,jevConfigured:false});await restored();
  await page.waitForFunction(()=>document.getElementById('ranked-note').textContent.includes('no JEV connection configured'));
  let state=await ranked(page);assert.equal(state.ariaDisabled,'true');assert.equal(state.checked,false,'a tick cannot survive lost configuration');
  fixture.me=meFixture({user:player});await restored();
  await page.waitForFunction(()=>document.getElementById('ranked').getAttribute('aria-disabled')==='false');
  state=await ranked(page);assert.equal(state.checked,false,'restoring configuration does not re-tick the box');
  const gets=fixture.meGets;await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:false})));await page.waitForTimeout(200);
  assert.equal(fixture.meGets,gets,'an ordinary pageshow does not refetch');
  assert.deepEqual(errors,[]);await context.close();
});
const columnsEnabled=page=>page.evaluate(()=>[...document.querySelectorAll('.column-button')].filter(b=>!b.disabled).length);
const moveCount=page=>page.evaluate(()=>Number(document.getElementById('move-count').textContent));
async function playsOneMove(page,shaped){
  const before=await moveCount(page);
  await page.locator('.column-button[data-column="3"]').click();
  await page.waitForFunction(was=>Number(document.getElementById('move-count').textContent)>was,before);
  // The count rises optimistically, before the server has answered, so wait for the handler's own response.
  let drop;for(const until=Date.now()+8000;!(drop=shaped.log.findLast(entry=>entry.path.endsWith('/commands')));){if(Date.now()>until)break;await page.waitForTimeout(50);}
  assert.ok(drop&&drop.status>=200&&drop.status<300,'the server accepted the move');
  await page.waitForFunction(()=>!document.getElementById('new-game').disabled);
}
test('fixture (server-shaped): a signed-in player ticks Ranked match, and the real handler\'s ranked response is shown as a playable ranked game',real,async()=>{
  const {page,context,fixture,errors}=await fixturePage(meFixture({user:player}),{serverShaped:{user:true}});await settled(page,fixture);
  const shaped=fixture.shaped;
  assert.equal(shaped.starts()[0].status,201);assert.equal(shaped.starts()[0].requested.ranked,false);assert.equal(shaped.starts()[0].data.ranked,false,'the automatic first game is unranked');
  assert.equal(await page.locator('#verification-badge').textContent(),'SERVER PRACTICE');
  await page.locator('#ranked').focus();await page.keyboard.press('Space');
  await page.locator('#new-game').focus();await page.keyboard.press('Enter');
  await settled(page,fixture,2);
  const [, start]=shaped.starts();
  assert.equal(start.requested.ranked,true,'the page posted ranked:true');assert.equal(start.status,201);
  assert.equal(start.data.ranked,true);assert.equal(start.data.status,'active');assert.equal(start.data.pending,null);assert.equal(start.data.eligible,false,'not eligible until the server finalizes it');
  assert.ok([1,2].includes(start.data.humanDisc),'the server, not the page, assigned the side');
  await page.waitForFunction(()=>document.getElementById('verification-badge').textContent==='RANKED · IN PROGRESS');
  assert.equal(await page.locator('#resign').isDisabled(),false,'a ranked match in progress can be resigned');
  assert.equal(start.data.state.toMove,start.data.humanDisc,'the server left the player to move');
  assert.equal(await page.locator('#turn-label').textContent(),'Your turn');assert.ok(await columnsEnabled(page)>0,'the board is playable');
  assert.equal(await moveCount(page),start.data.state.ply);
  await playsOneMove(page,shaped);
  await page.locator('#new-game').click();
  assert.match(await page.locator('#notice').textContent(),/ranked match is still active/i,'a second start is refused while the ranked match runs');
  assert.equal(shaped.starts().length,2,'and no second request was sent');
  assert.deepEqual(errors,[]);await context.close();shaped.close();
});
test('fixture (server-shaped): an ordinary unranked start succeeds for a guest and the ranked box stays unavailable',real,async()=>{
  const {page,context,fixture,errors}=await fixturePage(meFixture(),{serverShaped:{user:false}});await settled(page,fixture);
  const shaped=fixture.shaped,[start]=shaped.starts();
  assert.equal(start.requested.ranked,false);assert.equal(start.status,201);assert.equal(start.data.ranked,false);assert.equal(start.data.status,'active');
  assert.equal(await page.locator('#verification-badge').textContent(),'SERVER PRACTICE');
  const state=await ranked(page);assert.equal(state.ariaDisabled,'true');assert.equal(state.checked,false);assert.equal(state.action,'Connect Discord');
  assert.equal(await page.locator('#turn-label').textContent(),'Your turn');assert.ok(await columnsEnabled(page)>0);
  await playsOneMove(page,shaped);
  assert.deepEqual(errors,[]);await context.close();shaped.close();
});
// F3 (Astra c4-review-02): the first /api/me is held while the tab is returned to. /api/me is never in flight twice (a cookie-less request makes the server
// create a session with its own Set-Cookie and CSRF token), so the second request is sent only after the first is answered, and startup waits for the newest one.
// Offline fixture evidence: /api/me and the signed-in user are fixtures; /api/matches is answered by the real Worker handler.
const arrived=async(page,fixture,n,within=8000)=>{for(const until=Date.now()+within;fixture.meGets<n;){if(Date.now()>until)throw new Error(`identity request ${n} never arrived`);await page.waitForTimeout(50);}};
const visibleReturn=page=>page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
const named=(displayName,extra={})=>meFixture({user:{...player,displayName},...extra});
async function heldBootstrap(options={}){
  const opened=await fixturePage(meFixture(),{serverShaped:options.shaped===false?undefined:{user:true},holdMe:2,hash:options.hash});
  const {page,fixture}=opened;await arrived(page,fixture,1);
  const match=fixture.shaped?await fixture.shaped.create({ranked:true}):null;
  for(let i=0;i<(options.returns||1);i++)await visibleReturn(page);
  await page.waitForTimeout(400);
  assert.equal(fixture.meGets,1,'the tab return waits: no second identity request while the first is unanswered');
  return {...opened,match,older:id=>named('Older Player',{activeMatchId:id,csrf:'csrf-older'}),newer:id=>named('Newer Player',{activeMatchId:id,csrf:'csrf-newer'})};
}
const matchReads=(shaped,id)=>shaped.log.filter(entry=>entry.method==='GET'&&entry.path===`/api/matches/${id}`);
async function assertResumedOnce({page,fixture,match,errors}){
  await page.waitForFunction(()=>document.getElementById('verification-badge').textContent==='RANKED · IN PROGRESS');
  await page.waitForTimeout(300);
  assert.equal(matchReads(fixture.shaped,match.id).length,1,'the existing server match is read exactly once');
  assert.equal(fixture.shaped.starts().length,0,'no match was created');assert.equal(fixture.posts.length,0);
  assert.equal(await page.locator('#mode').inputValue(),'jev','JEV mode, not the default local fallback');
  assert.equal((await ranked(page)).ariaDisabled,'false','ranked is available to the signed-in player');
  assert.equal(await page.locator('#identity').textContent(),'Newer Player','the newest identity wins');
  assert.equal(await page.locator('#resign').isDisabled(),false);
  assert.deepEqual(errors,[]);
}
test('fixture (server-shaped): a tab return during the first identity request is sent after it, and startup waits for that newest identity before resuming the match',real,async()=>{
  const boot=await heldBootstrap(),{page,fixture,match}=boot;
  fixture.releaseMe(1,boot.older(match.id));await arrived(page,fixture,2);await page.waitForTimeout(400);
  assert.equal(fixture.shaped.log.length,0,'nothing was read or created before the newest identity arrived');assert.equal(fixture.posts.length,0);
  fixture.releaseMe(2,boot.newer(match.id));
  await assertResumedOnce(boot);assert.equal(fixture.meGets,2);await boot.context.close();fixture.shaped.close();
});
test('fixture (server-shaped): several tab returns during the first identity request share one trailing request, and the resumed match is read once',real,async()=>{
  const boot=await heldBootstrap({returns:3}),{page,fixture,match}=boot;
  fixture.releaseMe(1,boot.older(match.id));await arrived(page,fixture,2);await page.waitForTimeout(400);
  assert.equal(fixture.meGets,2,'the three tab returns were coalesced into one request');
  assert.equal(fixture.shaped.log.length,0,'startup still waits');
  fixture.releaseMe(2,boot.newer(match.id));
  await assertResumedOnce(boot);assert.equal(fixture.meGets,2);await boot.context.close();fixture.shaped.close();
});
test('fixture (server-shaped): a failed first identity request follows the newer one instead of falling back to local practice',real,async()=>{
  const boot=await heldBootstrap(),{page,fixture,match}=boot;
  fixture.releaseMe(1,{error:'UNAVAILABLE'},503);await arrived(page,fixture,2);await page.waitForTimeout(400);
  assert.equal(fixture.shaped.log.length,0);assert.equal(fixture.posts.length,0);
  assert.equal(await page.locator('#notice').isHidden(),true,'no local-practice fallback notice while the newer request is pending');
  fixture.releaseMe(2,boot.newer(match.id));
  await assertResumedOnce(boot);await boot.context.close();fixture.shaped.close();
});
test('fixture: a launch ticket is redeemed once, and only with the newest identity CSRF token',real,async()=>{
  const boot=await heldBootstrap({shaped:false,hash:'#launch=ticket-1'}),{page,fixture,errors}=boot;
  fixture.me=boot.newer(null);
  fixture.releaseMe(1,boot.older(null));await arrived(page,fixture,2);await page.waitForTimeout(400);
  assert.equal(fixture.redeems.length,0,'no redemption while only a superseded identity has arrived');
  fixture.releaseMe(2,boot.newer(null));
  for(const until=Date.now()+8000;fixture.redeems.length<1;){if(Date.now()>until)throw new Error('the launch ticket was never redeemed');await page.waitForTimeout(50);}
  await settled(page,fixture);
  assert.equal(fixture.redeems.length,1);assert.equal(fixture.redeems[0].csrf,'csrf-newer');assert.equal(fixture.redeems[0].meGets,2);
  assert.deepEqual(errors,[]);await boot.context.close();
});
// Cold guest (Sol's source-inspection concern): with no session cookie every /api/me makes the real handler create a guest session and answer with its own Set-Cookie and
// CSRF token. /api/me AND /api/matches are both answered by the real Worker handler (in-memory database, offline stub provider, no network, no key), and the handler
// verifies the CSRF token the page actually sends against the cookie it is given. If the page sent two cold requests and the older answer landed last, the page would hold
// the newest CSRF token with the older session's cookie and the game POST would be CSRF_REJECTED. Two evidence classes, kept apart:
//  - browser cookies: Chromium itself stores the handler's Set-Cookie (it is passed through route.fulfill) and the Cookie header handed to the handler is read from
//    Chromium's own jar (context.cookies) when the request is made. The test keeps no jar and never calls addCookies.
//  - modelled jar: a jar owned by this test stands in for the browser (Set-Cookie is applied on delivery, the jar is sent on request). NOT browser cookie evidence.
// In both, the handler sees the browser's x-csrf-token; the Origin header is the browser's when Playwright reports one and the handler's own origin otherwise (originFromBrowser
// is recorded). Raw cookie and CSRF values are never logged or put in an assertion message.
async function coldGuest({browserCookies=false}={}){
  const {environment}=await import('./helpers.js');
  const worker=(await import('../server/worker.js')).default,{rows}=await import('../server/db.js');
  const env=environment({APP_ORIGIN:origin}),log=[],gates={};
  const state={jar:'',context:null,issued:[],meGets:0,inFlight:0,maxInFlight:0};
  const gate=n=>gates[n]??=(()=>{let open;const promise=new Promise(resolveGate=>{open=resolveGate;});return {promise,open};})();
  const sessionCookies=async()=>(await state.context.cookies(origin)).filter(cookie=>cookie.name==='jev-local');
  const handle=async route=>{
    const request=route.request(),url=new URL(request.url()),headers=request.headers();
    const isMe=url.pathname==='/api/me'&&request.method()==='GET',n=isMe?++state.meGets:0;
    if(isMe){state.inFlight++;state.maxInFlight=Math.max(state.maxInFlight,state.inFlight);}
    const sent=browserCookies?(await sessionCookies()).map(cookie=>`${cookie.name}=${cookie.value}`).join('; '):state.jar;
    const init={method:request.method(),headers:{...(sent?{cookie:sent}:{}),...(request.method()==='GET'?{}:{origin:headers.origin||env.APP_ORIGIN,'x-csrf-token':headers['x-csrf-token']||'','content-type':'application/json',...(headers['idempotency-key']?{'idempotency-key':headers['idempotency-key']}:{})})},...(request.postData()?{body:request.postData()}:{})};
    const tasks=[],response=await worker.fetch(new Request(env.APP_ORIGIN+url.pathname+url.search,init),env,{waitUntil:p=>tasks.push(p)});await Promise.all(tasks);
    const set=response.headers.get('set-cookie'),text=await response.text();let data;try{data=JSON.parse(text);}catch{data={};}
    if(isMe&&n<=2)await gate(n).promise;
    if(set&&!/Max-Age=0/i.test(set))state.issued.push(set.split(';')[0]);
    if(set&&!browserCookies)state.jar=/Max-Age=0/i.test(set)?'':set.split(';')[0];
    if(isMe)state.inFlight--;
    log.push({method:request.method(),path:url.pathname,status:response.status,sentCookie:!!sent,issuedCookie:!!set,originFromBrowser:!!headers.origin,error:data.error,requested:request.postData()?JSON.parse(request.postData()):undefined,data});
    return route.fulfill({status:response.status,headers:{'content-type':'application/json',...(browserCookies&&set?{'set-cookie':set}:{})},body:text});};
  return {log,state,handle,sessionCookies,release:n=>gate(n).open(),close:()=>env.DB.close(),matchCount:async()=>(await rows(env,'SELECT id FROM matches')).length,starts:()=>log.filter(entry=>entry.method==='POST'&&entry.path==='/api/matches')};
}
async function coldGuestScenario({browserCookies}){
  const cold=await coldGuest({browserCookies});
  const {page,context,errors}=await openPage({waitUntil:'load',setup:p=>{cold.state.context=p.context();return p.route(/\/api\/(me|matches)(\/|\?|$)/,cold.handle);}});
  for(const until=Date.now()+8000;cold.state.meGets<1;){if(Date.now()>until)throw new Error('the first identity request never arrived');await page.waitForTimeout(50);}
  await visibleReturn(page);await page.waitForTimeout(400);
  // A page that overlapped its requests would have two in flight now; release the newest answer first, the order that breaks cookie and CSRF agreement.
  if(cold.state.meGets>1){cold.release(2);cold.release(1);}else{cold.release(1);cold.release(2);}
  for(const until=Date.now()+8000;!cold.starts().length;){if(Date.now()>until)throw new Error('the page never started a game');await page.waitForTimeout(50);}
  const [start]=cold.starts();
  assert.equal(start.status,201,`the game start was accepted (error: ${start.error})`);assert.equal(start.requested.ranked,false);assert.equal(start.data.ranked,false);
  assert.equal(cold.log.filter(entry=>entry.error==='CSRF_REJECTED').length,0,'the handler never rejected the page\'s CSRF token');
  assert.equal(cold.log.filter(entry=>entry.issuedCookie).length,1,'exactly one guest session was created');
  assert.deepEqual(cold.log.filter(entry=>entry.path==='/api/me').map(entry=>entry.sentCookie),[false,true],'the second identity request carried the first one\'s cookie');
  assert.equal(cold.state.meGets,2,'the tab return became one trailing identity request');assert.equal(cold.state.maxInFlight,1,'/api/me was never in flight twice');
  await page.waitForFunction(()=>!document.getElementById('new-game').disabled);
  assert.equal(await page.locator('#verification-badge').textContent(),'SERVER PRACTICE','a server game, not a local replacement');
  assert.equal(await page.locator('#mode').inputValue(),'jev');
  assert.equal(cold.starts().length,1,'one start request');assert.equal(await cold.matchCount(),1,'one server match exists: no extra allocation');
  assert.equal(await page.locator('#turn-label').textContent(),'Your turn');assert.ok(await columnsEnabled(page)>0);
  if(browserCookies){
    const held=await cold.sessionCookies();
    assert.equal(held.length,1,'Chromium holds exactly one session cookie');assert.ok(held[0].httpOnly,'it is the HttpOnly cookie the handler set');
    assert.ok(`${held[0].name}=${held[0].value}`===cold.state.issued[0],'and it is the one the handler issued');
  }
  await playsOneMove(page,cold);
  assert.equal(cold.log.filter(entry=>entry.error==='CSRF_REJECTED').length,0,'nor was the move rejected');
  assert.deepEqual(errors,[]);await context.close();cold.close();
}
test('fixture (real handler, BROWSER cookies: Chromium applies the handler\'s Set-Cookie and supplies the Cookie header): a cold guest who returns to the tab during the first /api/me keeps one session and starts an ordinary unranked game',real,()=>coldGuestScenario({browserCookies:true}));
test('fixture (real handler, MODELLED cookie jar owned by the test, not browser cookie evidence): the same cold-guest ordering keeps one session and starts an ordinary unranked game',real,()=>coldGuestScenario({browserCookies:false}));
// Identity read deadline (10 s, only the read-only /api/me GET). A stalled read fails, it never leaves a later refresh blocked, and startup still waits for an accepted identity.
// Offline fixture evidence: /api/me is a route that is never answered; /api/matches is the real Worker handler. The two cases each wait out the real 10 s deadline.
const DEADLINE_WAIT=20000;
test('fixture (server-shaped): a stalled first identity read times out, and startup follows the queued read and still waits for an accepted identity',real,async()=>{
  const boot=await heldBootstrap(),{page,fixture,match}=boot;
  await arrived(page,fixture,2,DEADLINE_WAIT);// request 1 is never answered; the deadline fails it and the queued read goes out
  await page.waitForTimeout(400);
  assert.equal(fixture.shaped.log.length,0,'nothing was read or created before an identity was accepted');assert.equal(fixture.posts.length,0);
  assert.equal(await page.locator('#identity').textContent(),'Guest','the stalled read installed nothing');
  fixture.releaseMe(2,boot.newer(match.id));
  await assertResumedOnce(boot);assert.equal(fixture.meGets,2);await boot.context.close();fixture.shaped.close();
});
test('fixture: a stalled identity read with nothing queued says the status is unknown, continues in local practice, and a later refresh still goes out',real,async()=>{
  const {page,context,fixture,errors}=await fixturePage(meFixture(),{holdMe:1});// read 1 is never answered, later reads are
  for(const until=Date.now()+DEADLINE_WAIT;!(await ranked(page)).note.includes('status is unknown');){if(Date.now()>until)throw new Error('the deadline never produced the unknown state');await page.waitForTimeout(100);}
  let state=await ranked(page);assert.equal(state.ariaDisabled,'true');assert.equal(state.action,'Check again');assert.doesNotMatch(state.note,/no JEV connection/,'a failed read is not reported as a missing JEV key');
  assert.equal(fixture.meGets,1);assert.equal(await page.locator('#verification-badge').textContent(),'LOCAL PRACTICE');assert.equal(await page.locator('#turn-label').textContent(),'Your turn','a local game started')
  assert.ok(await columnsEnabled(page)>0,'local practice is playable');assert.equal(fixture.posts.length,0,'no server game was requested on an unknown identity');
  await page.locator('#ranked-action').focus();await page.keyboard.press('Enter');// keyboard-operable retry
  await arrived(page,fixture,2);
  await page.waitForFunction(()=>!document.getElementById('ranked-note').textContent.includes('status is unknown'));
  state=await ranked(page);assert.equal(state.action,'Switch to JEV','the accepted identity replaced the unknown state');
  await visibleReturn(page);await arrived(page,fixture,3);// a tab return refreshes as usual afterwards
  assert.deepEqual(errors,[]);await context.close();
});
