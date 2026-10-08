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
async function openPage({width=1440,height=1100,reducedMotion='no-preference',setup,waitUntil='networkidle'}={}){
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
  }else await page.goto(origin,{waitUntil});
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
  return {log,handle,close:()=>env.DB.close(),starts:()=>log.filter(entry=>entry.method==='POST'&&entry.path==='/api/matches')};
}
async function fixturePage(initial,options={}){
  let release;const hold=options.hold?new Promise(resolveHold=>{release=resolveHold;}):null;
  const shaped=options.serverShaped?await serverShaped(options.serverShaped.user):null;
  const fixture={me:initial,posts:[],auth:0,meGets:0,release:()=>release?.(),shaped};
  const opened=await openPage({...options,waitUntil:hold?'load':'networkidle',setup:async page=>{
    await page.route('**/api/me',route=>{if(route.request().method()!=='GET')return route.continue();fixture.meGets++;return route.fulfill({json:fixture.me});});
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
  const drop=shaped.log.findLast(entry=>entry.path.endsWith('/commands'));
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
