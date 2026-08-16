/** Quick engine benchmark: circular constructs and zoom steps. */
import { MainInterface } from '../../src/app/MainInterface.ts';
import { TruthValue } from '../../src/logic/TruthValue.ts';

function letters(n: number): string {
  return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i)).join(' & ');
}

for (const n of [5, 6, 8, 10]) {
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  app.venn.style = 'circular';
  app.venn.update();
  const t0 = performance.now();
  const r = app.processCommand(letters(n));
  const t1 = performance.now();
  const auto = r.ok ? r.autoZoomSteps : -1;
  const blocked = r.ok ? r.blockedRegions : -1;
  const t2 = performance.now();
  app.zoomAction('in');
  const t3 = performance.now();
  console.log(
    `circular n=${n}: construct ${(t1 - t0).toFixed(0)}ms (auto-zoom ×${auto}, blocked ${blocked}, ` +
      `${app.venn.width}×${app.venn.length}) · one wheel zoom step ${(t3 - t2).toFixed(0)}ms`,
  );
}

for (const n of [5, 8, 10]) {
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  app.venn.style = 'classic';
  app.venn.update();
  const t0 = performance.now();
  app.processCommand(letters(n));
  const t1 = performance.now();
  const t2 = performance.now();
  app.zoomAction('in');
  const t3 = performance.now();
  console.log(
    `classic  n=${n}: construct ${(t1 - t0).toFixed(0)}ms (${app.venn.width}×${app.venn.length}) · ` +
      `one wheel zoom step ${(t3 - t2).toFixed(0)}ms`,
  );
}
