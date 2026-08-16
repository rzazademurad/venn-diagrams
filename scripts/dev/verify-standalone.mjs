import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(readFileSync(path.resolve('dist/venn-diagrams-standalone.html')));
});
await new Promise((r) => server.listen(4212, r));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:4212/');
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Construct'));
  return b !== undefined && !b.disabled;
}, undefined, { timeout: 30000 });
await page.fill('input#statement', 'A & B & C & D & E');
await page.click('button:has-text("Construct")');
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Construct'));
  return b !== undefined && !b.disabled;
}, undefined, { timeout: 60000 });
await page.waitForTimeout(400);
const painted = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  const d = c.getContext('2d').getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data;
  return [...d];
});
console.log('standalone painted:', JSON.stringify(painted), 'errors:', errors.length === 0 ? 'none' : errors.join('|'));
console.log(painted[3] === 255 && errors.length === 0 ? 'STANDALONE OK (inline worker works)' : 'STANDALONE FAILED');
await browser.close(); server.close();
process.exit(painted[3] === 255 && errors.length === 0 ? 0 : 1);
