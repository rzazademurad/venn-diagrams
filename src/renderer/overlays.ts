/**
 * View-mode overlay built from the region→row map:
 *
 *   - 'sets': every region is tinted by blending the hues of the sets it
 *     belongs to (golden-angle palette) — set structure independent of the
 *     formula's true/false fills. A `soloSet` highlights ONLY that set.
 *
 * The row index encodes membership directly: set j is a member of row r iff
 * bit (n−1−j) of r is set (row 2^n−1 is the all-true innermost region — the
 * same convention as `getBinaryFormat` and the smooth construction's map).
 *
 * Overlays are presentation-layer canvases — the pixel buffer, fills and the
 * 1:1 algorithms are untouched. Built at (possibly further downsampled)
 * region-map resolution and stretched over the sheet by the renderer.
 */

export type ViewMode = 'fills' | 'sets';

/** Overlays above this many pixels are stride-downsampled (translucent tint —
 *  slight softness at extreme zoom is invisible at practical view scales). */
const MAX_OVERLAY_PIXELS = 16_000_000;

/** Golden-angle set palette — visually distinct for any practical N. */
export function setColor(index: number): { r: number; g: number; b: number; css: string } {
  const hue = (index * 137.508) % 360;
  const { r, g, b } = hslToRgb(hue, 0.68, 0.5);
  return { r, g, b, css: `hsl(${Math.round(hue)} 68% 50%)` };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

function popcount(v: number): number {
  let n = v - ((v >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  return (((n + (n >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

/**
 * Builds the overlay canvas for `mode`, or null for the plain fills view.
 * `n` is the number of sets; rows range over [0, 2^n).
 * In 'sets' mode, `soloSet` (0-based) highlights ONLY that set's regions —
 * the fastest way to find one set's band among many.
 */
export function buildViewOverlayCanvas(
  regionMap: Int32Array | null,
  mapWidth: number,
  mapHeight: number,
  mode: ViewMode,
  n: number,
  soloSet: number | null = null,
): HTMLCanvasElement | null {
  if (mode !== 'sets' || regionMap === null || n < 1 || mapWidth <= 0 || mapHeight <= 0) return null;

  // Extra stride so the per-pixel pass stays fast on huge maps.
  let stride = 1;
  while ((Math.ceil(mapWidth / stride) * Math.ceil(mapHeight / stride)) > MAX_OVERLAY_PIXELS) {
    stride *= 2;
  }
  const w = Math.ceil(mapWidth / stride);
  const h = Math.ceil(mapHeight / stride);

  // Precompute row → RGBA (there are at most 2^16 rows).
  const rows = 1 << n;
  const lut = new Uint8ClampedArray(rows * 4);
  for (let row = 0; row < rows; row++) {
    const members = popcount(row);
    const o = row * 4;
    if (soloSet !== null) {
      // Solo: tint ONLY the chosen set's regions in its own color.
      if (((row >> (n - 1 - soloSet)) & 1) === 1) {
        const c = setColor(soloSet);
        lut[o] = c.r;
        lut[o + 1] = c.g;
        lut[o + 2] = c.b;
        lut[o + 3] = Math.round(255 * 0.5);
      }
      continue;
    }
    if (members === 0) continue; // universe stays untinted
    let r = 0;
    let g = 0;
    let b = 0;
    for (let j = 0; j < n; j++) {
      if (((row >> (n - 1 - j)) & 1) === 1) {
        const c = setColor(j);
        r += c.r;
        g += c.g;
        b += c.b;
      }
    }
    lut[o] = Math.round(r / members);
    lut[o + 1] = Math.round(g / members);
    lut[o + 2] = Math.round(b / members);
    lut[o + 3] = Math.round(255 * Math.min(0.46, 0.18 + 0.06 * (members - 1)));
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(w, h);
  const out = imageData.data;
  for (let y = 0; y < h; y++) {
    const srcBase = Math.min(mapHeight - 1, y * stride) * mapWidth;
    const outBase = y * w * 4;
    for (let x = 0; x < w; x++) {
      const row = regionMap[srcBase + Math.min(mapWidth - 1, x * stride)];
      if (row < 0) continue; // strokes / unmapped
      const src = row * 4;
      const dst = outBase + x * 4;
      out[dst] = lut[src];
      out[dst + 1] = lut[src + 1];
      out[dst + 2] = lut[src + 2];
      out[dst + 3] = lut[src + 3];
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}
