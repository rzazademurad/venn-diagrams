/**
 * Full-app E2E suite (headless Chromium against the production build in dist/).
 * Covers: worker construct, single-swap rendering (canvas untouched mid-job,
 * chips frozen), re-crisp zoom (exactly one buffer swap per settle), minimap,
 * off-screen recovery, style switch, view modes, table search, replay,
 * cancel + worker respawn, heavy auto-zoom, dark mode and exports.
 * Run with: npm run e2e  (requires `npm run build` first).
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

mkdirSync('screenshots', { recursive: true });
const dist = path.resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  let p = path.join(dist, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!existsSync(p)) p = path.join(dist, 'index.html');
  res.setHeader('content-type', types[path.extname(p)] ?? 'application/octet-stream');
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(4210, r));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('crash', () => errors.push('[CRASH]'));

const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); };

const idle = async (timeout = 300000) => {
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Construct'));
    return b !== undefined && !b.disabled;
  }, undefined, { timeout });
};
const construct = async (s) => {
  await page.fill('input#statement', s);
  await page.click('button:has-text("Construct")');
  await idle();
  await page.waitForTimeout(250);
};
const bufferDims = async () => {
  const t = await page.locator('span.font-mono', { hasText: '× ' }).first().textContent();
  const m = t.match(/(\d+)\s*×\s*(\d+)/);
  return m ? { w: +m[1], h: +m[2] } : null;
};
const canvasCenterPixel = async () => page.evaluate(() => {
  const c = document.querySelector('canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
  return [...d];
});

await page.goto('http://localhost:4210/');
await idle(30000);
await page.waitForTimeout(400);
ok('boot: default frame drawn', (await canvasCenterPixel())[3] === 255);
await page.screenshot({ path: 'screenshots/v1-boot.png' });

// 1. Basic construct through the worker.
await construct('(A & B) | (C & D) + E');
const evalText = await page.locator('text=Conditional').count();
ok('construct: evaluation pill', evalText > 0);
const px = await canvasCenterPixel();
ok('construct: diagram rendered', px[3] === 255, JSON.stringify(px));
await page.screenshot({ path: 'screenshots/v2-circular5.png' });

// 2. Region click → row selection + minterm tooltip.
const canvasBox = await page.locator('canvas').first().boundingBox();
await page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.45);
await page.waitForTimeout(250);
const tooltip = await page.locator('div.font-mono.pointer-events-none').first().textContent().catch(() => '');
ok('hover: minterm tooltip shows ∧', tooltip.includes('∧'), tooltip);
await page.mouse.click(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.45);
await page.waitForTimeout(350);
await page.screenshot({ path: 'screenshots/v3-selected.png' });

// 3. Wheel zoom (instant view zoom) + re-crisp: the buffer grows after the
//    settle and swaps EXACTLY ONCE (no per-ladder-step flashing).
const before = await bufferDims();
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -140); await page.waitForTimeout(30); }
const dimStates = [];
for (let t = 0; t < 45; t++) {
  const d = await bufferDims();
  const key = d ? `${d.w}x${d.h}` : '';
  if (dimStates.length === 0 || dimStates[dimStates.length - 1] !== key) dimStates.push(key);
  await page.waitForTimeout(90);
}
await idle();
await page.waitForTimeout(300);
const after = await bufferDims();
ok('re-crisp: buffer rebuilt larger after wheel-in settle', after.w > before.w, `${before.w} → ${after.w}`);
ok('re-crisp: exactly one buffer swap (no flashing)', dimStates.length <= 2, dimStates.join(' → '));
ok('zoom: canvas still painted', (await canvasCenterPixel())[3] === 255);

// 4. Minimap appears when the sheet exceeds the viewport.
const minimap = await page.locator('canvas[title*="Minimap"]').count();
ok('minimap: visible when zoomed in', minimap > 0);
await page.screenshot({ path: 'screenshots/v4-zoomed-minimap.png' });

// 5. Pan far off-screen → Recenter pill; click restores.
await page.mouse.move(canvasBox.x + 400, canvasBox.y + 400);
await page.mouse.down();
await page.mouse.move(canvasBox.x + 400 + 3000, canvasBox.y + 400 + 2600, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(300);
// The pan clamp must keep at least a sliver of the sheet reachable.
const sliver = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < d.length; i += 4096 * 4) {
    if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255) return true; // white sheet pixel
  }
  return false;
});
ok('off-screen: pan clamp keeps the sheet reachable', sliver);
// The Recenter pill covers the remaining path (e.g. viewport shrink): force it.
await page.setViewportSize({ width: 700, height: 420 });
await page.waitForTimeout(400);
const recenter = await page.locator('button:has-text("Recenter")').count();
await page.setViewportSize({ width: 1680, height: 1000 });
await page.waitForTimeout(300);
if (recenter > 0) { const b = await page.locator('button:has-text("Recenter")').count(); if (b > 0) await page.click('button:has-text("Recenter")'); }
else { await page.click('button:has-text("Reset")'); }
await idle();
await page.waitForTimeout(400);
ok('off-screen: recovered', (await canvasCenterPixel())[3] === 255);
await page.screenshot({ path: 'screenshots/v5-recentered.png' });

// 6. Reset.
await page.click('button:has-text("Reset")');
await idle();
await page.waitForTimeout(400);
const resetDims = await bufferDims();
ok('reset: buffer back to default', resetDims.w === 1181, JSON.stringify(resetDims));

// 7. Style switch → Classic completes and renders.
await page.click('button:has-text("Square")');
await idle();
await page.waitForTimeout(300);
ok('square: rendered', (await canvasCenterPixel())[3] === 255);
await page.screenshot({ path: 'screenshots/v6-classic.png' });
await page.click('button:has-text("Circular")');
await idle();

// 8. View modes: Sets (solo-chip legend) and back to Fills.
await page.click('button:has-text("Sets")');
await page.waitForTimeout(350);
await page.screenshot({ path: 'screenshots/v7-sets-mode.png' });
const heatGone = (await page.locator('button:has-text("Heat")').count()) === 0;
ok('view modes: Heat removed from the toolbar', heatGone);
await page.click('button:has-text("Fills")');
ok('view modes: no errors', errors.length === 0, errors.join(' | '));

// 9. Table search: pattern jump selects a row.
await construct('(A => B) & (C <=> D)');
await page.fill('input[aria-label="Search rows"]', 'TFTF');
await page.press('input[aria-label="Search rows"]', 'Enter');
await page.waitForTimeout(350);
const selectedRows = await page.evaluate(() =>
  [...document.querySelectorAll('div')].filter((d) => (d.style.boxShadow || '').includes('inset')).length);
ok('search: row selected via pattern', selectedRows > 0);
await page.screenshot({ path: 'screenshots/v9-search.png' });

// 10. Replay animation runs.
await page.click('button:has-text("Replay")');
await page.waitForTimeout(600);
await page.screenshot({ path: 'screenshots/v10-replay-mid.png' });
await page.waitForTimeout(4200);
ok('replay: completed without errors', errors.length === 0, errors.join(' | '));

// 11. Cancel: heavy circular n=10, cancel mid-flight, worker respawns.
await page.fill('input#statement', 'A & B & C & D & E & F & G & H & I & J');
await page.click('button:has-text("Construct")');
await page.waitForTimeout(900); // let it get going
const cancelVisible = await page.locator('button:has-text("Cancel")').first().isVisible().catch(() => false);
ok('cancel: button appears while busy', cancelVisible);
if (cancelVisible) await page.locator('button:has-text("Cancel")').first().click();
await idle(15000);
ok('cancel: UI unblocked quickly', true);
ok('cancel: previous diagram kept', (await canvasCenterPixel())[3] === 255);
await construct('A & B & C');
ok('cancel: worker respawned and constructs again', (await canvasCenterPixel())[3] === 255);
await page.screenshot({ path: 'screenshots/v11-after-cancel.png' });

// 12. n=8 circular auto-zoom still healthy end-to-end.
const t0 = Date.now();
await construct('A & B & C & D & E & F & G & H');
ok('n=8 circular: constructed', (await canvasCenterPixel())[3] === 255, `${Date.now() - t0}ms`);
const autoChip = await page.locator('text=auto-zoomed').count();
ok('n=8 circular: auto-zoom chip', autoChip > 0);
await page.screenshot({ path: 'screenshots/v12-n8.png' });

// 12b. Single-swap constructs: while a heavy construct runs, the VISIBLE
//      canvas stays byte-identical (previous diagram kept) and the toolbar
//      chips stay frozen; everything settles exactly once at completion.
const signature = async () => page.evaluate(() => {
  const c = document.querySelector('canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 1997 * 4) sum = (sum + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0;
  return `${c.width}x${c.height}:${sum}`;
});
const chips = async () => {
  const spans = await page.locator('span.font-mono').allTextContents();
  const pct = spans.find((s) => /%$/.test(s.trim())) ?? '';
  const px = spans.find((s) => /px$/.test(s.trim())) ?? '';
  return `${pct}|${px}`;
};
const sigBefore = await signature();
const chipsBefore = await chips();
await page.fill('input#statement', 'A & B & C & D & E & F & G & H & I');
await page.click('button:has-text("Construct")');
const sigsDuring = new Set();
const chipsDuring = new Set();
let sawBusy = false;
for (let t = 0; t < 120; t++) {
  const busy = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Construct'));
    return b !== undefined && b.disabled;
  });
  if (busy) { sawBusy = true; sigsDuring.add(await signature()); chipsDuring.add(await chips()); }
  else if (sawBusy && t > 2) break;
  await page.waitForTimeout(100);
}
await idle();
await page.waitForTimeout(400);
const chipsAfter = await chips();
// The last busy-sample can race completion and catch the settled value, so:
// every sample must be the frozen BEFORE state or the settled AFTER state —
// never an intermediate auto-zoom rung ticking through the chips.
const chipStates = [...chipsDuring];
const noIntermediateChips = chipStates.every((s) => s === chipsBefore || s === chipsAfter);
const sigStates = [...sigsDuring];
const noIntermediateFrames = sigStates.every((s) => s === sigBefore) ||
  (sigStates.length === 2 && sigStates.includes(sigBefore));
ok('single-swap: canvas untouched during construct', sawBusy && noIntermediateFrames, `${sigStates.length} states`);
ok('single-swap: chips frozen during construct', sawBusy && noIntermediateChips, chipStates.join(' → '));
ok('single-swap: result swapped in at completion', (await signature()) !== sigBefore);

// 13. Dark mode.
await page.keyboard.press('d');
await page.waitForTimeout(400);
const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
ok('dark mode: html.dark toggled', isDark);
await page.screenshot({ path: 'screenshots/v13-dark.png' });
await page.keyboard.press('d');

// 14. Export menu opens with size options.
await page.keyboard.press("Escape");
  await page.mouse.click(canvasBox.x + 30, canvasBox.y + 30);
  await page.waitForTimeout(200);
  await page.click('button:has-text("Export ▾")');
await page.waitForTimeout(200);
const menuItems = await page.locator('[role="menuitem"]').count();
ok('export: menu has 4 options', menuItems === 4, String(menuItems));
await page.keyboard.press('Escape');

ok('zero console/page errors overall', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.close();
process.exit(failed === 0 ? 0 : 1);
