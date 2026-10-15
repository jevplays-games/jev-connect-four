// Rasterise the native 32x32 favicon source 1:1 (no scaling), so every source pixel is one output pixel.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const svg = await readFile(new URL('./favicon-32.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 32, height: 32 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
  await page.screenshot({ path: fileURLToPath(new URL('../../public/brand/favicon-32.png', import.meta.url)), omitBackground: true, clip: { x: 0, y: 0, width: 32, height: 32 } });
} finally { await browser.close(); }
