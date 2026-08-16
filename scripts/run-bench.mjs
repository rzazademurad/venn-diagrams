/**
 * Benchmark runner: bundles `scripts/dev/bench.ts` (TypeScript, imports the
 * engine straight from src/) with esbuild and executes it under Node —
 * the same zero-extra-dependency approach as `run-tests.mjs`.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '.bench-bundle.mjs');

await build({
  entryPoints: [path.join(here, 'dev', 'bench.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile,
  logLevel: 'silent',
});

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
process.exit(result.status ?? 1);
