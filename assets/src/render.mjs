import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { palettePNG } from './palette-png.mjs';
const source=await readFile(new URL('./social.html',import.meta.url),'utf8');
assert(source.includes('jevplay.games'));
assert(!/jevplays|\bJEV\b|Arcade|Connect/.test(source));
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:1280,height:420},deviceScaleFactor:2});
  await page.goto(new URL('./banner.html',import.meta.url).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({path:fileURLToPath(new URL('../banner.png',import.meta.url))});
  await page.close();
  for(const [width,height,path] of [[1200,630,'../../public/brand/og.png'],[1280,640,'../social-preview.png']]){
    const social=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
    await social.goto(new URL(`./social.html?size=${width}x${height}`,import.meta.url).href);
    await social.evaluate(()=>document.fonts.ready);
    const bounds=await social.evaluate(()=>({fonts:document.fonts.check('700 120px Inter')&&document.fonts.check('26px VT323'),windows:[...document.querySelectorAll('.window')].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}}),title:document.querySelector('h1').getBoundingClientRect().right,choice:document.querySelector('.choice').getBoundingClientRect().left}));
    assert(bounds.fonts);assert(bounds.title<bounds.choice);for(const r of bounds.windows)assert(r.x>23&&r.y>23&&r.right+3<width-23&&r.bottom+3<height-23);
    const shot=await social.screenshot();
    const rgba=await social.evaluate(async b64=>{const img=new Image();img.src='data:image/png;base64,'+b64;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;let s='';for(let i=0;i<data.length;i+=8192)s+=String.fromCharCode(...data.subarray(i,i+8192));return btoa(s);},shot.toString('base64'));
    const png=palettePNG(Buffer.from(rgba,'base64'),width,height);
    if(width===1200)assert(png.length<120000,`OG too large: ${png.length}`);
    await writeFile(new URL(path,import.meta.url),png);console.log(`${width}x${height}: ${png.length} bytes; fonts and layout verified`);await social.close();
  }
} finally { await browser.close(); }
