/** Stress: main thread stays responsive during heavy constructs; deep zoom ladder never blanks. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  let p = path.join(dist, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!existsSync(p)) p = path.join(dist, 'index.html');
  res.setHeader('content-type', types[path.extname(p)] ?? 'application/octet-stream');
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(4211, r));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const idle = async (t = 420000) => {
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Construct'));
    return b !== undefined && !b.disabled;
  }, undefined, { timeout: t });
};

await page.goto('http://localhost:4211/');
await idle(30000);

// 1. Main-thread responsiveness DURING circular n=10 (was 6.8s frozen before).
await page.fill('input#statement', 'A & B & C & D & E & F & G & H & I & J');
const t0 = Date.now();
await page.click('button:has-text("Construct")');
const frames = await page.evaluate(async () => {
  // Count rAF ticks over 3 s while the worker constructs.
  return await new Promise((resolve) => {
    let n = 0;
    const start = performance.now();
    const tick = () => {
      n++;
      if (performance.now() - start < 3000) requestAnimationFrame(tick);
      else resolve(n);
    };
    requestAnimationFrame(tick);
  });
});
await idle();
const total = Date.now() - t0;
console.log(`n=10 circular: ${total}ms total; main thread rendered ${frames} frames in the first 3s (${(frames / 3).toFixed(0)} fps)`);
console.log(frames > 100 ? 'PASS  main thread stays interactive during heavy construct' : 'FAIL  main thread starved');

// 2. Deep zoom ladder: 5 rounds of wheel-in + settle; canvas must stay painted.
await page.fill('input#statement', 'A & B & C & D & E & F & G & H');
await page.click('button:has-text("Construct")');
await idle();
// Point the mouse at the CANVAS so wheel events hit the viewport.
const cbox = await page.locator('canvas').first().boundingBox();
await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
const dims = async () => {
  const t = await page.locator('span.font-mono', { hasText: '× ' }).first().textContent();
  const m = t.match(/(\d+)\s*×\s*(\d+)/);
  return { w: +m[1], h: +m[2] };
};
let last = await dims();
console.log(`start buffer: ${last.w}×${last.h}`);
for (let round = 0; round < 5; round++) {
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -160); await page.waitForTimeout(25); }
  await page.waitForTimeout(700);
  await idle();
  await page.waitForTimeout(500);
  await idle();
  const now = await dims();
  const painted = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return d[3] === 255;
  });
  console.log(`round ${round + 1}: buffer ${now.w}×${now.h} (${((now.w * now.h) / 1e6).toFixed(0)} Mpx), painted=${painted}`);
  if (!painted) { console.log('FAIL  canvas blanked at deep zoom'); process.exit(1); }
  last = now;
}
console.log('PASS  deep zoom ladder never blanks');
console.log(errors.length === 0 ? 'PASS  zero errors' : `FAIL  ${errors.join(' | ')}`);
await browser.close();
server.close();
process.exit(errors.length === 0 ? 0 : 1);
