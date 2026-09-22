import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const inline=process.env.C4_INLINE_BROWSER==='1',origin='http://127.0.0.1:8791';
let server,browser;
test.before(async()=>{
  await mkdir(resolve(root,'test-results'),{recursive:true});
  if(!inline){server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:'8791',APP_ORIGIN:origin,TYPESAFE_API_KEY:'',DISCORD_CLIENT_ID:''},stdio:'pipe'});
    let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(origin+'/api/health');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw new Error('Browser test server did not start.');}
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
});
test.after(async()=>{await browser?.close();server?.kill('SIGTERM');});
async function openPage({width=1440,height=1100,reducedMotion='no-preference'}={}){
  const context=await browser.newContext({viewport:{width,height},reducedMotion});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(10000);
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
  }else await page.goto(origin,{waitUntil:'networkidle'});
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
