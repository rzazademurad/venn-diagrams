/**
 * High-performance canvas presentation layer.
 *
 * The diagram lives in a `Raster` (Uint32Array pixel buffer) produced by the
 * 1:1 ported drawing/fill algorithms. This module:
 *
 *   - blits the raster into a GRID OF ≤4096² TILES. Browsers silently blank
 *     any single canvas past their area cap (Chromium: 2^28 px ≈ 16384²;
 *     iOS Safari: far less), which is exactly how deep-zoomed diagrams used
 *     to vanish — tiles remove that ceiling entirely, and only the tiles
 *     intersecting the viewport are drawn each frame;
 *   - maintains a small downsampled THUMBNAIL of the whole diagram for the
 *     minimap;
 *   - renders the visible tiles into the viewport canvas with
 *     devicePixelRatio-crisp scaling, drag panning, light/dark workbench
 *     themes and optional overlay layers (view modes + region highlight);
 *   - produces PNG exports at a chosen resolution and SVG exports whose fill
 *     layer is itself tiled (a single <image> would hit the same canvas cap).
 */

import { Raster, WHITE, cssColor, unpackRGB } from './Raster.ts';
import type { DiagramLabel } from '../app/MainInterface.ts';

export interface Viewport {
  panX: number;
  panY: number;
  /** Extra view magnification applied on top of the buffer's own zoom. */
  scale: number;
}

export type CanvasTheme = 'light' | 'dark';

/** Maximum tile edge — safe on every engine (iOS Safari caps at ~4096²·1). */
const TILE = 4096;
/** Thumbnail longest side (backing pixels — crisp on high-dpr minimaps). */
const THUMB_MAX = 480;

const LABEL_FONT_PX = 14;

/** An overlay bitmap stretched over the whole diagram sheet (map-resolution). */
export interface OverlayLayer {
  canvas: HTMLCanvasElement;
}

const THEME = {
  light: {
    backdrop: '#f5f2f9',
    dots: 'rgba(102,0,153,0.10)',
    shadow: 'rgba(43,10,66,0.20)',
    ring: 'rgba(43,10,66,0.14)',
  },
  dark: {
    backdrop: '#140c1e',
    dots: 'rgba(184,140,222,0.12)',
    shadow: 'rgba(0,0,0,0.55)',
    ring: 'rgba(184,140,222,0.26)',
  },
} as const;

/** Draws set labels (thesis §5.2) with a white halo for readability. */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  labels: DiagramLabel[],
  toScreenX: (x: number) => number,
  toScreenY: (y: number) => number,
  fontPx: number,
): void {
  ctx.font = `700 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textBaseline = 'alphabetic';
  for (const label of labels) {
    ctx.textAlign = label.align === 'right' ? 'right' : 'left';
    const sx = toScreenX(label.x);
    const sy = toScreenY(label.y);
    ctx.lineWidth = Math.max(2, fontPx / 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineJoin = 'round';
    ctx.strokeText(label.text, sx, sy);
    ctx.fillStyle = cssColor(label.color);
    ctx.fillText(label.text, sx, sy);
  }
}

interface Tile {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  x: number; // content-space origin
  y: number;
  w: number;
  h: number;
}

export class CanvasRenderer {
  private tiles: Tile[] = [];
  private cols = 0;
  private rows = 0;
  private thumb: HTMLCanvasElement | null = null;
  private thumbScale = 0;
  private lastRevision = -1;
  private lastW = -1;
  private lastH = -1;

  /** Uploads the raster into the tile grid (and thumbnail) if it changed. */
  public sync(raster: Raster, revision: number): void {
    if (this.lastW !== raster.width || this.lastH !== raster.height) {
      this.allocateTiles(raster.width, raster.height);
      this.lastW = raster.width;
      this.lastH = raster.height;
      this.lastRevision = -1;
    }
    if (revision === this.lastRevision) return;
    this.lastRevision = revision;

    const src = raster.data;
    const width = raster.width;
    for (const tile of this.tiles) {
      const dst = new Uint32Array(tile.image.data.buffer);
      for (let row = 0; row < tile.h; row++) {
        const srcStart = (tile.y + row) * width + tile.x;
        dst.set(src.subarray(srcStart, srcStart + tile.w), row * tile.w);
      }
      tile.ctx.putImageData(tile.image, 0, 0);
    }
    this.rebuildThumb();
  }

  private allocateTiles(width: number, height: number): void {
    this.cols = Math.ceil(width / TILE);
    this.rows = Math.ceil(height / TILE);
    this.tiles = [];
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const x = tx * TILE;
        const y = ty * TILE;
        const w = Math.min(TILE, width - x);
        const h = Math.min(TILE, height - y);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        this.tiles.push({ canvas, ctx, image: ctx.createImageData(w, h), x, y, w, h });
      }
    }
  }

  private rebuildThumb(): void {
    if (this.lastW <= 0 || this.lastH <= 0) return;
    const scale = Math.min(1, THUMB_MAX / Math.max(this.lastW, this.lastH));
    const tw = Math.max(1, Math.round(this.lastW * scale));
    const th = Math.max(1, Math.round(this.lastH * scale));
    if (this.thumb === null) this.thumb = document.createElement('canvas');
    this.thumb.width = tw;
    this.thumb.height = th;
    this.thumbScale = scale;
    const ctx = this.thumb.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tw, th);
    for (const tile of this.tiles) {
      ctx.drawImage(tile.canvas, tile.x * scale, tile.y * scale, tile.w * scale, tile.h * scale);
    }
  }

  /** The whole-diagram thumbnail (for the minimap), or null before first sync. */
  public getThumb(): { canvas: HTMLCanvasElement; scale: number } | null {
    return this.thumb !== null && this.thumbScale > 0 ? { canvas: this.thumb, scale: this.thumbScale } : null;
  }

  /**
   * Draws the synced tiles into the visible canvas.
   * `cssWidth`/`cssHeight` are the canvas CSS pixel dimensions; the canvas
   * backing store is resized to devicePixelRatio for crisp output.
   */
  public render(
    canvas: HTMLCanvasElement,
    cssWidth: number,
    cssHeight: number,
    viewport: Viewport,
    labels: DiagramLabel[] = [],
    highlight: HTMLCanvasElement | null = null,
    overlay: HTMLCanvasElement | null = null,
    theme: CanvasTheme = 'light',
  ): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const bw = Math.max(1, Math.round(cssWidth * dpr));
    const bh = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    if (ctx === null || this.lastW <= 0) return;
    const colors = THEME[theme];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Workbench backdrop: a faint dot grid (screen space).
    ctx.fillStyle = colors.backdrop;
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = colors.dots;
    ctx.beginPath();
    for (let y = 9; y < cssHeight; y += 18) {
      for (let x = 9; x < cssWidth; x += 18) {
        ctx.moveTo(x + 1, y);
        ctx.arc(x, y, 1, 0, Math.PI * 2);
      }
    }
    ctx.fill();

    ctx.translate(viewport.panX, viewport.panY);
    ctx.scale(viewport.scale, viewport.scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const sheetW = this.lastW;
    const sheetH = this.lastH;
    const radius = Math.min(12 / viewport.scale, sheetW / 8, sheetH / 8);
    const sheetPath = (): void => {
      ctx.beginPath();
      ctx.moveTo(radius, 0);
      ctx.lineTo(sheetW - radius, 0);
      ctx.arcTo(sheetW, 0, sheetW, radius, radius);
      ctx.lineTo(sheetW, sheetH - radius);
      ctx.arcTo(sheetW, sheetH, sheetW - radius, sheetH, radius);
      ctx.lineTo(radius, sheetH);
      ctx.arcTo(0, sheetH, 0, sheetH - radius, radius);
      ctx.lineTo(0, radius);
      ctx.arcTo(0, 0, radius, 0, radius);
      ctx.closePath();
    };
    // Soft page shadow behind the rounded diagram sheet.
    ctx.save();
    ctx.shadowColor = colors.shadow;
    ctx.shadowBlur = 16 / viewport.scale;
    ctx.shadowOffsetY = 3 / viewport.scale;
    ctx.fillStyle = '#ffffff';
    sheetPath();
    ctx.fill();
    ctx.restore();
    // Diagram tiles + overlays, clipped to the rounded sheet. Only the tiles
    // that intersect the visible content rectangle are drawn.
    ctx.save();
    sheetPath();
    ctx.clip();
    const visX0 = -viewport.panX / viewport.scale;
    const visY0 = -viewport.panY / viewport.scale;
    const visX1 = visX0 + cssWidth / viewport.scale;
    const visY1 = visY0 + cssHeight / viewport.scale;
    for (const tile of this.tiles) {
      if (tile.x > visX1 || tile.y > visY1 || tile.x + tile.w < visX0 || tile.y + tile.h < visY0) continue;
      ctx.drawImage(tile.canvas, tile.x, tile.y);
    }
    if (overlay !== null) {
      ctx.drawImage(overlay, 0, 0, sheetW, sheetH);
    }
    if (highlight !== null) {
      ctx.drawImage(highlight, 0, 0, sheetW, sheetH);
    }
    ctx.restore();
    // Hairline ring.
    sheetPath();
    ctx.strokeStyle = colors.ring;
    ctx.lineWidth = 1 / viewport.scale;
    ctx.stroke();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Labels are drawn in screen space at a constant size so they stay crisp
    // and readable at any view scale (they never touch the pixel buffer,
    // so they can never act as flood-fill barriers).
    if (labels.length > 0) {
      drawLabels(
        ctx,
        labels,
        (x) => viewport.panX + x * viewport.scale,
        (y) => viewport.panY + y * viewport.scale,
        LABEL_FONT_PX,
      );
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * PNG export composed from the tiles. `targetLongSide` picks the output
   * resolution (null = 1:1 buffer pixels, automatically reduced if the buffer
   * exceeds the export-canvas safety budget).
   */
  public toPNGBlob(labels: DiagramLabel[] = [], targetLongSide: number | null = null): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (this.lastW <= 0) {
        reject(new Error('Nothing to export yet.'));
        return;
      }
      const SAFE_AREA = 230_000_000; // stays under Chromium's 2^28 with margin
      const SAFE_SIDE = 16_000;
      let scale = 1;
      if (targetLongSide !== null) {
        scale = Math.min(1, targetLongSide / Math.max(this.lastW, this.lastH));
      }
      const clampArea = Math.sqrt(SAFE_AREA / (this.lastW * this.lastH));
      const clampSide = SAFE_SIDE / Math.max(this.lastW, this.lastH);
      scale = Math.min(scale, clampArea, clampSide, 1);
      const outW = Math.max(1, Math.round(this.lastW * scale));
      const outH = Math.max(1, Math.round(this.lastH * scale));
      const out = document.createElement('canvas');
      out.width = outW;
      out.height = outH;
      const ctx = out.getContext('2d')!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outW, outH);
      for (const tile of this.tiles) {
        ctx.drawImage(tile.canvas, tile.x * scale, tile.y * scale, tile.w * scale, tile.h * scale);
      }
      if (labels.length > 0) {
        drawLabels(ctx, labels, (x) => x * scale, (y) => y * scale, LABEL_FONT_PX + 2);
      }
      out.toBlob((blob) => {
        if (blob === null) reject(new Error('PNG encoding failed.'));
        else resolve(blob);
      }, 'image/png');
    });
  }
}

/* --------------------------- region highlight ----------------------------- */

/**
 * Builds a translucent overlay canvas tinting every pixel whose region-map
 * entry equals `row` — used to spotlight the truth-table row's region in the
 * diagram. Works at the (possibly downsampled) region-map resolution; the
 * renderer stretches it over the sheet. Returns null when there is nothing
 * to highlight.
 */
export interface HighlightTint {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function buildRegionHighlightCanvas(
  regionMap: Int32Array | null,
  width: number,
  height: number,
  row: number | null,
  tint: HighlightTint = { r: 102, g: 0, b: 153, a: 96 },
): HTMLCanvasElement | null {
  if (regionMap === null || row === null || width <= 0 || height <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;
  let found = false;
  // Interior: translucent tint (keeps the fill color readable underneath).
  // Rim: a solid 2px band just inside the region boundary, so the selection
  // reads as a crisp blue outline over ANY underlying fill.
  for (let i = 0; i < regionMap.length; i++) {
    if (regionMap[i] === row) {
      const o = i * 4;
      out[o] = tint.r;
      out[o + 1] = tint.g;
      out[o + 2] = tint.b;
      out[o + 3] = tint.a;
      found = true;
    }
  }
  if (!found) return null;
  const isRow = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && regionMap[y * width + x] === row;
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      if (regionMap[base + x] !== row) continue;
      // Any 4-neighbour outside the region (or off-buffer) → boundary pixel.
      if (!isRow(x - 1, y) || !isRow(x + 1, y) || !isRow(x, y - 1) || !isRow(x, y + 1)) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (isRow(nx, ny)) {
              const o = (ny * width + nx) * 4;
              out[o] = tint.r;
              out[o + 1] = tint.g;
              out[o + 2] = tint.b;
              out[o + 3] = 255;
            }
          }
        }
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/* -------------------------------- SVG export ------------------------------ */

/**
 * Builds an SVG document for the current diagram:
 *   - raster `<image>` TILES containing ONLY the flood-filled pixels
 *     (the fills are inherently raster regions in this algorithm; tiling
 *     keeps every canvas used for encoding under the browser's area cap);
 *   - every recorded stroke re-emitted as a crisp vector rect/line/arc.
 */
export function buildSVG(raster: Raster, labels: DiagramLabel[] = []): string {
  const { width, height } = raster;
  const SVG_TILE = 2048;

  const strokeColors = new Set<number>(raster.ops.map((op) => op.color));
  const src = raster.data;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);

  // Fill layer, tiled: everything that is neither white nor a stroke color.
  const tileCanvas = document.createElement('canvas');
  for (let ty = 0; ty < height; ty += SVG_TILE) {
    const th = Math.min(SVG_TILE, height - ty);
    for (let tx = 0; tx < width; tx += SVG_TILE) {
      const tw = Math.min(SVG_TILE, width - tx);
      tileCanvas.width = tw;
      tileCanvas.height = th;
      const tileCtx = tileCanvas.getContext('2d')!;
      const imageData = tileCtx.createImageData(tw, th);
      const out = new Uint32Array(imageData.data.buffer);
      let hasFills = false;
      for (let y = 0; y < th; y++) {
        const srcBase = (ty + y) * width + tx;
        const outBase = y * tw;
        for (let x = 0; x < tw; x++) {
          const p = src[srcBase + x];
          if (p !== WHITE && !strokeColors.has(p)) {
            out[outBase + x] = p;
            hasFills = true;
          }
        }
      }
      if (!hasFills) continue;
      tileCtx.putImageData(imageData, 0, 0);
      parts.push(
        `<image x="${tx}" y="${ty}" width="${tw}" height="${th}" ` +
          `style="image-rendering:pixelated" xlink:href="${tileCanvas.toDataURL('image/png')}"/>`,
      );
    }
  }

  parts.push(`<g shape-rendering="crispEdges">`);
  for (const op of raster.ops) {
    if (op.kind === 'line') {
      const x = Math.min(op.x1, op.x2);
      const y = Math.min(op.y1, op.y2);
      const w = Math.abs(op.x2 - op.x1) + 1;
      const h = Math.abs(op.y2 - op.y1) + 1;
      if (w === 1 || h === 1) {
        // Axis-aligned 1px stroke -> exact pixel-cover rectangle.
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${cssColor(op.color)}"/>`);
      } else {
        const [r, g, b] = unpackRGB(op.color);
        parts.push(
          `<line x1="${op.x1 + 0.5}" y1="${op.y1 + 0.5}" x2="${op.x2 + 0.5}" y2="${op.y2 + 0.5}" ` +
            `stroke="rgb(${r},${g},${b})" stroke-width="1"/>`,
        );
      }
    } else if (op.kind === 'circle') {
      parts.push(
        `<circle cx="${op.cx + 0.5}" cy="${op.cy + 0.5}" r="${op.r}" fill="none" ` +
          `stroke="${cssColor(op.color)}" stroke-width="1.4" shape-rendering="geometricPrecision"/>`,
      );
    } else {
      // Quarter-circle fillet arc.
      const x0 = op.cx + op.r * Math.cos(op.a0);
      const y0 = op.cy + op.r * Math.sin(op.a0);
      const x1 = op.cx + op.r * Math.cos(op.a1);
      const y1 = op.cy + op.r * Math.sin(op.a1);
      const sweepFlag = op.a1 > op.a0 ? 1 : 0;
      const large = Math.abs(op.a1 - op.a0) > Math.PI ? 1 : 0;
      parts.push(
        `<path d="M ${(x0 + 0.5).toFixed(2)} ${(y0 + 0.5).toFixed(2)} ` +
          `A ${op.r} ${op.r} 0 ${large} ${sweepFlag} ${(x1 + 0.5).toFixed(2)} ${(y1 + 0.5).toFixed(2)}" ` +
          `fill="none" stroke="${cssColor(op.color)}" stroke-width="1.4" shape-rendering="geometricPrecision"/>`,
      );
    }
  }
  parts.push(`</g>`);
  if (labels.length > 0) {
    parts.push(`<g font-family="ui-monospace, Menlo, Consolas, monospace" font-size="16" font-weight="700">`);
    for (const label of labels) {
      const anchor = label.align === 'right' ? 'end' : 'start';
      const text = label.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      parts.push(
        `<text x="${label.x}" y="${label.y}" text-anchor="${anchor}" fill="${cssColor(label.color)}" ` +
          `stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${text}</text>`,
      );
    }
    parts.push(`</g>`);
  }
  parts.push(`</svg>`);
  return parts.join('\n');
}
