/**
 * Generates the app logo — the user's own figure (grey trefoil circles +
 * rainbow arc bands) — by RUNNING the ported smooth construction and emitting
 * its recorded vector ops as a standalone SVG React component + favicon.
 */
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundle = await build({
  stdin: {
    contents: `
      import { Raster } from './src/renderer/Raster.ts';
      import { drawSmooth } from './src/geometry/SmoothConstruction.ts';
      const W = 2560, H = 2020, d = Math.trunc(W / 8);
      const raster = new Raster(W, H);
      raster.fillAll(0xffffffff);
      drawSmooth(raster, 7, d); // 3 circles + 4 nested bands (sets 4..7)
      console.log(JSON.stringify({ ops: raster.ops, groups: raster.opGroups }));
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  target: 'es2022',
  logLevel: 'silent',
});
writeFileSync('/tmp/logo-run.mjs', bundle.outputFiles[0].text);
const { ops, groups } = JSON.parse(execSync('node /tmp/logo-run.mjs', { maxBuffer: 64 * 1024 * 1024 }).toString());

// Rainbow band palette, outermost (last set) violet like the figure.
// The program's own curve cycle: red -> dark green -> blue -> purple.
const BAND_COLORS = ['#e03131', '#2f9e44', '#1971c2', '#9c36b5'];

// Group ops by set.
const bySet = new Map();
for (let g = 0; g < groups.length; g++) {
  const from = groups[g].start;
  const to = groups[g + 1]?.start ?? ops.length;
  bySet.set(groups[g].set, ops.slice(from, to));
}

// Bounding box over all geometry.
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
const grow = (x, y) => {
  minX = Math.min(minX, x);
  minY = Math.min(minY, y);
  maxX = Math.max(maxX, x);
  maxY = Math.max(maxY, y);
};
for (const op of ops) {
  if (op.kind === 'circle') {
    grow(op.cx - op.r, op.cy - op.r);
    grow(op.cx + op.r, op.cy + op.r);
  } else if (op.kind === 'arc') {
    for (let s = 0; s <= 24; s++) {
      const a = op.a0 + ((op.a1 - op.a0) * s) / 24;
      grow(op.cx + op.r * Math.cos(a), op.cy + op.r * Math.sin(a));
    }
  }
}
const pad = 30;
const vb = [Math.floor(minX - pad), Math.floor(minY - pad), Math.ceil(maxX - minX + 2 * pad), Math.ceil(maxY - minY + 2 * pad)];

const arcPath = (op) => {
  const x0 = op.cx + op.r * Math.cos(op.a0);
  const y0 = op.cy + op.r * Math.sin(op.a0);
  const x1 = op.cx + op.r * Math.cos(op.a1);
  const y1 = op.cy + op.r * Math.sin(op.a1);
  const sweep = op.a1 - op.a0;
  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  const sf = sweep > 0 ? 1 : 0;
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${op.r.toFixed(1)} ${op.r.toFixed(1)} 0 ${large} ${sf} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
};

const parts = [];
// Grey-filled trefoil circles (overlaps darken via stacked opacity) + outline.
for (const set of [0, 1, 2]) {
  const c = bySet.get(set)[0];
  parts.push(
    `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="#26203a" fillOpacity="0.10" stroke="#241f38" strokeWidth="9" />`,
  );
}
// Rainbow bands: one <path> per band (all its arcs concatenated).
for (const set of [...bySet.keys()].filter((s) => s >= 3).sort((a, b) => a - b)) {
  const color = BAND_COLORS[(set - 3) % BAND_COLORS.length];
  const d = bySet
    .get(set)
    .filter((op) => op.kind === 'arc')
    .map(arcPath)
    .join(' ');
  parts.push(`<path d="${d}" fill="none" stroke="${color}" strokeWidth="6" strokeLinecap="round" />`);
}

const component = `/**
 * The application logo — the project's own figure: John Venn's smooth
 * construction (3 grey circles + nested rainbow bands, sets 4…8), generated
 * by RUNNING the ported \`drawSmooth\` engine and emitting its recorded
 * vector ops (see scripts/dev/gen-logo.mjs). It is not artwork — it is the
 * thesis algorithm's actual output.
 */

export function LogoMark(props: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="${vb.join(' ')}" className={props.className} aria-hidden="true">
      ${parts.join('\n      ')}
    </svg>
  );
}
`;
writeFileSync(path.join(root, 'src/components/LogoMark.tsx'), component);

// Favicon: the same figure as a standalone SVG.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}">${parts
  .join('')
  .replaceAll('fillOpacity', 'fill-opacity')
  .replaceAll('strokeWidth', 'stroke-width')
  .replaceAll('strokeLinecap', 'stroke-linecap')}</svg>`;
writeFileSync(path.join(root, 'favicon-src.svg'), svg);
console.log('LogoMark.tsx written; viewBox', vb.join(' '), '; favicon bytes', svg.length);
