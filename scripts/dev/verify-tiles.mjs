/** Proves the tiled renderer survives a buffer PAST the single-canvas cap. */
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundle = await build({
  stdin: {
    contents: `
      import { Raster } from './src/renderer/Raster.ts';
      import { CanvasRenderer } from './src/renderer/CanvasRenderer.ts';
      window.runTileTest = (W, H) => {
        const raster = new Raster(W, H);
        raster.fillAll(0xffffffff);
        // Orange center block + red frame so we can sample recognizable pixels.
        const ORANGE = (0xff << 24) | (0x00 << 16) | (0xa5 << 8) | 0xff; // little-endian ABGR for #FFA500
        for (let y = Math.floor(H*0.4); y < Math.floor(H*0.6); y++) {
          raster.data.fill(ORANGE >>> 0, y*W + Math.floor(W*0.4), y*W + Math.floor(W*0.6));
        }
        const renderer = new CanvasRenderer();
        renderer.sync(raster, 1);
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);
        const scale = Math.min(760 / W, 560 / H);
        renderer.render(canvas, 800, 600, { panX: 20, panY: 20, scale }, [], null, null, 'light');
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const center = ctx.getImageData(Math.round((20 + W*scale/2)*dpr), Math.round((20 + H*scale/2)*dpr), 1, 1).data;
        const corner = ctx.getImageData(Math.round((20 + 8)*dpr), Math.round((20 + 8)*dpr), 1, 1).data;
        const thumb = renderer.getThumb();
        return {
          center: [...center], corner: [...corner],
          thumb: thumb ? { w: thumb.canvas.width, h: thumb.canvas.height } : null,
        };
      };
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true, format: 'iife', write: false, target: 'es2022', logLevel: 'silent',
});
const js = bundle.outputFiles[0].text;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ content: js });

// 16500×16300 = 268.95 Mpx — PAST Chromium's 2^28 single-canvas cap.
const overCap = await page.evaluate(() => window.runTileTest(16500, 16300));
console.log('over-cap (16500×16300 = 269 Mpx):', JSON.stringify(overCap));
const small = await page.evaluate(() => window.runTileTest(1181, 919));
console.log('default  (1181×919):', JSON.stringify(small));

const okOver = overCap.center[0] === 255 && overCap.center[1] > 140 && overCap.center[1] < 190 && overCap.corner[0] === 255 && overCap.corner[1] === 255;
const okSmall = small.center[0] === 255 && small.center[1] > 140 && small.center[1] < 190;
console.log(okOver && okSmall && errors.length === 0 ? 'TILES OK — over-cap buffer renders (center=orange, sheet=white)' : `TILES FAILED ${errors}`);
await browser.close();
process.exit(okOver && okSmall && errors.length === 0 ? 0 : 1);
