/**
 * A 32-bit RGBA pixel buffer with the drawing primitives the original Java
 * code used on its `BufferedImage` (`Graphics2D.drawLine` / `drawRect` with a
 * 1-pixel stroke and no antialiasing on a TYPE_BYTE_INDEXED image), plus the
 * circular-mode primitives (circles, arcs, rounded rectangles and rounded
 * polygons) used by the organic rendering style.
 *
 * The buffer is a `Uint32Array` view over the same bytes an HTML5-canvas
 * `ImageData` uses, so it can be blitted to a canvas without copying and the
 * flood fill can run directly on 32-bit words. Every primitive draws an
 * 8-connected 1px stroke — which a 4-way flood fill can never leak through —
 * and records a vector op for the SVG export.
 */

/** True when this platform's typed arrays are little-endian (virtually always). */
export const IS_LITTLE_ENDIAN: boolean = (() => {
  const probe = new Uint32Array([0x000000ff]);
  return new Uint8Array(probe.buffer)[0] === 0xff;
})();

/** Packs r,g,b (0-255) into the Uint32 word matching ImageData byte order. */
export function packRGB(r: number, g: number, b: number): number {
  if (IS_LITTLE_ENDIAN) {
    return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  return ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;
}

/** Unpacks a Uint32 word back into [r, g, b]. */
export function unpackRGB(word: number): [number, number, number] {
  if (IS_LITTLE_ENDIAN) {
    return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff];
  }
  return [(word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff];
}

export function cssColor(word: number): string {
  const [r, g, b] = unpackRGB(word);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/* Java AWT color constants used by the original program (Classic style). */
export const WHITE = packRGB(255, 255, 255);
export const BLACK = packRGB(0, 0, 0);
export const RED = packRGB(255, 0, 0);
export const DARK_GREEN = packRGB(0, 128, 0); // new Color(0, 128, 0)
export const BLUE = packRGB(0, 0, 255);
export const PURPLE = packRGB(145, 44, 138); // new Color(145, 44, 138) = #912C8A
/** Classic fill color for true regions (CSS orange, per the port spec). */
export const ORANGE = packRGB(255, 165, 0);

/* ------------------------------- vector ops -------------------------------- */

export type DrawOp =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; color: number }
  | { kind: 'circle'; cx: number; cy: number; r: number; color: number }
  | { kind: 'arc'; cx: number; cy: number; r: number; a0: number; a1: number; color: number };

/**
 * Marker recording where the strokes of one set's shape begin inside `ops` —
 * powers the construction-replay animation (curve-by-curve reveal).
 */
export interface OpGroup {
  /** 0-based set index (0..2 = base squares/circles, 3+ = inductive curves). */
  set: number;
  color: number;
  /** Index into `ops` of this group's first stroke. */
  start: number;
}

interface Vec {
  x: number;
  y: number;
}

export class Raster {
  public readonly width: number;
  public readonly height: number;
  public readonly data: Uint32Array<ArrayBuffer>;
  public readonly bytes: Uint8ClampedArray<ArrayBuffer>;
  /** Vector log of every stroke drawn since the last `fillAll` — for SVG export. */
  public ops: DrawOp[] = [];
  /** Per-set stroke-group markers into `ops` — for the construction replay. */
  public opGroups: OpGroup[] = [];

  constructor(width: number, height: number, existing?: ArrayBuffer) {
    this.width = width;
    this.height = height;
    const buffer = existing ?? new ArrayBuffer(width * height * 4);
    if (buffer.byteLength !== width * height * 4) {
      throw new Error('Raster: buffer size mismatch.');
    }
    this.data = new Uint32Array(buffer);
    this.bytes = new Uint8ClampedArray(buffer);
  }

  /**
   * Wraps pixels transferred from the geometry worker (zero-copy) back into a
   * fully functional Raster — used by the main-thread mirror for rendering
   * and SVG export.
   */
  public static adopt(
    width: number,
    height: number,
    pixels: ArrayBuffer,
    ops: DrawOp[],
    opGroups: OpGroup[],
  ): Raster {
    const raster = new Raster(width, height, pixels);
    raster.ops = ops;
    raster.opGroups = opGroups;
    return raster;
  }

  /** Begins a new stroke group (one set's shape) at the current op index. */
  public markGroup(set: number, color: number): void {
    this.opGroups.push({ set, color, start: this.ops.length });
  }

  public fillAll(color: number): void {
    this.data.fill(color);
    this.ops = [];
    this.opGroups = [];
  }

  public getPixel(x: number, y: number): number {
    return this.data[y * this.width + x];
  }

  public setPixel(x: number, y: number, color: number): void {
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) {
      this.data[y * this.width + x] = color;
    }
  }

  /**
   * Bresenham line, inclusive of both endpoints — the classic algorithm used
   * by AWT for non-antialiased 1px strokes. Every line the Venn construction
   * draws is axis-aligned, for which this is exactly Java's output.
   */
  public drawLine(x1: number, y1: number, x2: number, y2: number, color: number): void {
    this.ops.push({ kind: 'line', x1, y1, x2, y2, color });
    this.plotLine(x1, y1, x2, y2, color);
  }

  private plotLine(x1: number, y1: number, x2: number, y2: number, color: number): void {
    let x = Math.round(x1);
    let y = Math.round(y1);
    const ex = Math.round(x2);
    const ey = Math.round(y2);
    const dx = Math.abs(ex - x);
    const sx = x < ex ? 1 : -1;
    const dy = -Math.abs(ey - y);
    const sy = y < ey ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.setPixel(x, y, color);
      if (x === ex && y === ey) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Java `Graphics.drawRect(x, y, w, h)` — outline from (x,y) to (x+w, y+h) inclusive. */
  public drawRect(x: number, y: number, w: number, h: number, color: number): void {
    this.drawLine(x, y, x + w, y, color);
    this.drawLine(x + w, y, x + w, y + h, color);
    this.drawLine(x + w, y + h, x, y + h, color);
    this.drawLine(x, y + h, x, y, color);
  }

  /** 1px circle outline (dense parametric plot — 8-connected, gap-free). */
  public drawCircle(cx: number, cy: number, r: number, color: number): void {
    this.ops.push({ kind: 'circle', cx, cy, r, color });
    this.plotArc(cx, cy, r, 0, Math.PI * 2, color);
  }

  /** 1px arc from angle a0 sweeping to a1 (radians). */
  public drawArc(cx: number, cy: number, r: number, a0: number, a1: number, color: number): void {
    this.ops.push({ kind: 'arc', cx, cy, r, a0, a1, color });
    this.plotArc(cx, cy, r, a0, a1, color);
  }

  private plotArc(cx: number, cy: number, r: number, a0: number, a1: number, color: number): void {
    const sweep = a1 - a0;
    const steps = Math.max(8, Math.ceil((Math.abs(sweep) * Math.max(1, r)) / 0.4));
    for (let s = 0; s <= steps; s++) {
      const a = a0 + (sweep * s) / steps;
      this.setPixel(Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a)), color);
    }
  }

  /** Rounded rectangle outline — a rounded polygon over the 4 corners. */
  public drawRoundedRect(x: number, y: number, w: number, h: number, radius: number, color: number): void {
    this.drawRoundedPolygon(
      [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
      radius,
      color,
    );
  }

  /**
   * Closed polygon with quarter-circle fillets on every 90° corner
   * (the circular rendering of the inductive Venn curves). Vertices must be
   * axis-aligned rectilinear (which every construction polygon is); collinear
   * or too-short corners fall back to sharp joins. Topology-safe: the stroke
   * stays a continuous 8-connected 1px curve, so 4-way flood fills cannot
   * leak, and the fillet never leaves the corner's inscribed square.
   */
  public drawRoundedPolygon(vertices: Vec[], radius: number, color: number): void {
    const m = vertices.length;
    if (m < 3) return;

    const unit = (from: Vec, to: Vec): Vec => {
      const dx = Math.sign(to.x - from.x);
      const dy = Math.sign(to.y - from.y);
      return { x: dx, y: dy };
    };
    const edgeLength = (from: Vec, to: Vec): number => Math.abs(to.x - from.x) + Math.abs(to.y - from.y);

    // Per-corner fillet size + integer tangent points.
    const tangents: { a: Vec; b: Vec; t: number }[] = new Array(m);
    for (let i = 0; i < m; i++) {
      const prev = vertices[(i - 1 + m) % m];
      const v = vertices[i];
      const next = vertices[(i + 1) % m];
      const uIn = unit(prev, v);
      const uOut = unit(v, next);
      const lenIn = edgeLength(prev, v);
      const lenOut = edgeLength(v, next);
      const isTurn = uIn.x * uOut.x + uIn.y * uOut.y === 0 && (uIn.x !== 0 || uIn.y !== 0) && (uOut.x !== 0 || uOut.y !== 0);
      let t = Math.min(radius, Math.floor(lenIn / 2) - 2, Math.floor(lenOut / 2) - 2);
      if (!isTurn || t < 2) t = 0; // collinear / degenerate / too tight: sharp corner
      tangents[i] = {
        a: { x: v.x - uIn.x * t, y: v.y - uIn.y * t },
        b: { x: v.x + uOut.x * t, y: v.y + uOut.y * t },
        t,
      };
    }

    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      // Straight run between corner i's out-tangent and corner j's in-tangent.
      this.drawLine(tangents[i].b.x, tangents[i].b.y, tangents[j].a.x, tangents[j].a.y, color);
      // Quarter-circle fillet at corner j.
      const { a, b, t } = tangents[j];
      if (t >= 2) {
        const v = vertices[j];
        // Center is offset t inward along both edges: c = a + (b - v) = b + (a - v).
        const cx = a.x + (b.x - v.x);
        const cy = a.y + (b.y - v.y);
        const a0 = Math.atan2(a.y - cy, a.x - cx);
        let a1 = Math.atan2(b.y - cy, b.x - cx);
        let delta = a1 - a0;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        a1 = a0 + delta;
        this.drawArc(cx, cy, t, a0, a1, color);
        // Anchor the arc endpoints exactly (parametric rounding safety).
        this.setPixel(Math.round(a.x), Math.round(a.y), color);
        this.setPixel(Math.round(b.x), Math.round(b.y), color);
      }
    }
  }
}
