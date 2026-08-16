/**
 * Post-build step: inlines the built JS + CSS assets into dist/index.html and
 * writes a fully self-contained `dist/venn-diagrams-standalone.html` that can
 * be opened directly from disk (no server, no external files).
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const assetsDir = path.join(dist, 'assets');

let html = readFileSync(path.join(dist, 'index.html'), 'utf8');

for (const file of readdirSync(assetsDir)) {
  const content = readFileSync(path.join(assetsDir, file), 'utf8');
  if (file.endsWith('.js')) {
    const escaped = content.replace(/<\/script>/g, '<\\/script>');
    html = html.replace(
      new RegExp(`<script type="module"[^>]*src="[^"]*${file}"[^>]*></script>`),
      () => `<script type="module">\n${escaped}\n</script>`,
    );
  } else if (file.endsWith('.css')) {
    html = html.replace(
      new RegExp(`<link rel="stylesheet"[^>]*href="[^"]*${file}"[^>]*>`),
      () => `<style>\n${content}\n</style>`,
    );
  }
}

const out = path.join(dist, 'venn-diagrams-standalone.html');
writeFileSync(out, html);
console.log(`Wrote ${out} (${(html.length / 1024).toFixed(0)} kB)`);
