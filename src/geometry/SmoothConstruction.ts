/**
 * Smooth (arc-based) Venn construction for the circular style, N ≥ 4 —
 * the rendering John Venn's own figures use (cf. the classic "Venn's
 * construction for six sets" drawing): a 3-circle base, then each new set is
 * a smooth band that follows the previous curve on both sides and closes with
 * semicircular U-turn caps.
 *
 * Construction:
 *   - Sets 1–3: circles on an equilateral trefoil.
 *   - Set 4: a cut annulus hugging circle 3's circumference (its midline IS
 *     the circumference, minus a small angular gap at the "gateway"). Because
 *     circle 3's boundary borders every region of the 3-circle diagram, a
 *     thin band along it bisects all 8 regions — Venn's induction step.
 *   - Set k+1: the band of half the gap along set k's closed loop, cut at the
 *     gateway (its caps flank the previous cap), doubling the oscillation —
 *     the nested "hooks" of the classic figure.
 *
 * Region binding is analytic: membership of every pixel is computed from the
 * three circle equations plus even-odd containment in each polygonized loop,
 * giving the per-pixel region→row map and a seed pixel per region directly
 * (rows follow getBinaryFormat: bit i of the row is set i's membership,
 * MSB-first — row 2^n−1 is the all-true innermost region).
 */

import { Raster, WHITE, BLACK, RED, DARK_GREEN, BLUE, PURPLE } from '../renderer/Raster.ts';
import type { Pt } from './Mapper.ts';
import type { LabelAnchor } from './VennsConstruction.ts';

/** A directed arc: from angle a0 to a1 (signed sweep) around (cx, cy). */
interface Arc {
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
}

interface Vec {
  x: number;
  y: number;
}

const pointAt = (arc: Arc, a: number): Vec => ({
  x: arc.cx + arc.r * Math.cos(a),
  y: arc.cy + arc.r * Math.sin(a),
});

/** Unit tangent in the direction of travel at angle `a`. */
const tangentAt = (arc: Arc, a: number): Vec => {
  const s = Math.sign(arc.a1 - arc.a0) || 1;
  return { x: -s * Math.sin(a), y: s * Math.cos(a) };
};

/** Math-left normal of travel (toward the center when sweep is positive). */
const leftAt = (arc: Arc, a: number): Vec => {
  const s = Math.sign(arc.a1 - arc.a0) || 1;
  return { x: -s * Math.cos(a), y: -s * Math.sin(a) };
};

const reverseArc = (arc: Arc): Arc => ({ cx: arc.cx, cy: arc.cy, r: arc.r, a0: arc.a1, a1: arc.a0 });

/** Offset a whole chain to its travel-left (`+g`) or travel-right (`-g`). */
function offsetChain(chain: Arc[], g: number): Arc[] {
  return chain.map((arc) => {
    const s = Math.sign(arc.a1 - arc.a0) || 1;
    return { cx: arc.cx, cy: arc.cy, r: Math.max(0.5, arc.r - s * g), a0: arc.a0, a1: arc.a1 };
  });
}

function offsetChainRight(chain: Arc[], g: number): Arc[] {
  return offsetChain(chain, -g);
}

/** Semicircular cap centered at P, radius g, from direction `fromDir`, bulging through `throughDir`. */
function capArc(p: Vec, g: number, fromDir: Vec, throughDir: Vec): Arc {
  const a0 = Math.atan2(fromDir.y, fromDir.x);
  const cross = fromDir.x * throughDir.y - fromDir.y * throughDir.x;
  const sweep = cross > 0 ? Math.PI : -Math.PI;
  return { cx: p.x, cy: p.y, r: g, a0, a1: a0 + sweep };
}

/**
 * One induction step: the closed loop drawn around the open midline `chain`
 * at distance `g`, plus the next midline (the loop itself, cut at the start
 * cap — exactly the merged path2 + reversed path3 of the rectilinear engine).
 */
function bandAround(chain: Arc[], g: number): { loop: Arc[]; nextChain: Arc[] } {
  const first = chain[0];
  const last = chain[chain.length - 1];
  const startPoint = pointAt(first, first.a0);
  const endPoint = pointAt(last, last.a1);
  const startTangent = tangentAt(first, first.a0);
  const endTangent = tangentAt(last, last.a1);
  const startLeft = leftAt(first, first.a0);
  const endLeft = leftAt(last, last.a1);

  const railLeft = offsetChain(chain, g);
  const railRight = offsetChainRight(chain, g);
  const railRightReversed = railRight.map(reverseArc).reverse();

  const endCap = capArc(endPoint, g, endLeft, endTangent);
  const startCap = capArc(
    startPoint,
    g,
    { x: -startLeft.x, y: -startLeft.y },
    { x: -startTangent.x, y: -startTangent.y },
  );

  // Drawn closed loop: left rail out, U-turn at the far end, right rail back,
  // U-turn at the near end.
  const loop = [...railLeft, endCap, ...railRightReversed, startCap];
  // Next midline: the loop WITHOUT the start cap — its endpoints (the start
  // cap's two feet) are where the next curve's own caps will sit.
  const nextChain = [...railLeft, endCap, ...railRightReversed];
  return { loop, nextChain };
}

/** Samples a closed loop of arcs into a polygon (~1.5px steps). */
function polygonizeLoop(loop: Arc[]): Vec[] {
  const points: Vec[] = [];
  for (const arc of loop) {
    const sweep = arc.a1 - arc.a0;
    const steps = Math.max(4, Math.ceil((Math.abs(sweep) * Math.max(1, arc.r)) / 1.5));
    for (let s = 0; s < steps; s++) {
      const a = arc.a0 + (sweep * s) / steps;
      points.push(pointAt(arc, a));
    }
  }
  return points;
}

/**
 * Even-odd scanline fill of a polygon, OR-ing `bit` into `map` for every
 * interior pixel. Edge crossings are bucketed per scanline first (an edge
 * table), so the cost is O(edges + interior area) instead of the naive
 * O(scanlines × edges) — the difference between milliseconds and minutes on
 * the long late-stage loops of a zoomed 7–8-set diagram. Pixel selection is
 * identical to the classic centre-sampling rule (`scanY = y + 0.5`,
 * crossing iff scanY ∈ [min(y1,y2), max(y1,y2))).
 */
function orPolygonBit(map: Int32Array, width: number, height: number, points: Vec[], bit: number): void {
  const m = points.length;
  if (m < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(height - 1, Math.ceil(maxY));
  if (yEnd < yStart) return;
  const buckets: (number[] | undefined)[] = new Array<number[] | undefined>(yEnd - yStart + 1);
  for (let i = 0; i < m; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % m];
    if (p1.y === p2.y) continue; // horizontal edges never cross a scanline centre
    const lo = Math.min(p1.y, p2.y);
    const hi = Math.max(p1.y, p2.y);
    // scanY = y + 0.5 crosses this edge iff lo <= scanY < hi.
    let yFirst = Math.ceil(lo - 0.5);
    let yLast = Math.ceil(hi - 0.5) - 1;
    if (yFirst < yStart) yFirst = yStart;
    if (yLast > yEnd) yLast = yEnd;
    if (yLast < yFirst) continue;
    const slope = (p2.x - p1.x) / (p2.y - p1.y);
    for (let y = yFirst; y <= yLast; y++) {
      const x = p1.x + (y + 0.5 - p1.y) * slope;
      const idx = y - yStart;
      const bucket = buckets[idx];
      if (bucket === undefined) buckets[idx] = [x];
      else bucket.push(x);
    }
  }
  for (let idx = 0; idx < buckets.length; idx++) {
    const xs = buckets[idx];
    if (xs === undefined || xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const rowBase = (yStart + idx) * width;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let x0 = Math.ceil(xs[k] - 0.5);
      let x1 = Math.floor(xs[k + 1] - 0.5);
      if (x0 < 0) x0 = 0;
      if (x1 > width - 1) x1 = width - 1;
      for (let x = x0; x <= x1; x++) {
        map[rowBase + x] |= bit;
      }
    }
  }
}

/** Curve colors, exactly the reference figure's order (red, green, blue, purple…). */
const CURVE_CYCLE: number[] = [RED, DARK_GREEN, BLUE, PURPLE];

export interface SmoothResult {
  /** Seeds in `values` order (index 0 = all-true row); {-1,-1} = unresolvable. */
  seedsInValuesOrder: Pt[];
  /** Per-pixel region→row map (−1 on strokes / unresolved). */
  regionMap: Int32Array;
  labelAnchors: LabelAnchor[];
}

/**
 * Draws the smooth construction for `n >= 4` sets into `raster` and returns
 * the seeds + analytic region map. `displacement` = ⌊bufferWidth/8⌋, exactly
 * like every other part of the engine, so the original zoom model applies.
 */
export function drawSmooth(raster: Raster, n: number, displacement: number): SmoothResult {
  const labelAnchors: LabelAnchor[] = [];
  const { width, height } = raster;

  // Trefoil arranged exactly like the reference figure: circle 1 (A) on the
  // LEFT, circle 2 (B) on the TOP-RIGHT, circle 3 (C) on the BOTTOM-RIGHT —
  // vertices of an equilateral triangle at 180°, 300° and 60° — with black
  // strokes like the reference. This also matches the original program's
  // convention (first letter = left shape, second = top, third = bottom).
  const cx = 70 + Math.round(3.6 * displacement);
  const cy = 80 + Math.round(2.7 * displacement);
  const r = Math.round(1.45 * displacement);
  const triangleRadius = Math.round(0.837 * displacement); // side ≈ r
  const vertex = (angle: number): Vec => ({
    x: cx + Math.round(triangleRadius * Math.cos(angle)),
    y: cy + Math.round(triangleRadius * Math.sin(angle)),
  });
  const c1: Vec = vertex(Math.PI); // A — left
  const c2: Vec = vertex(-Math.PI / 3); // B — top-right
  const c3: Vec = vertex(Math.PI / 3); // C — bottom-right
  const centers = [c1, c2, c3];

  for (let i = 0; i < 3; i++) {
    raster.markGroup(i, BLACK);
    raster.drawCircle(centers[i].x, centers[i].y, r, BLACK);
  }
  // Circle labels sit inside each circle's exclusive zone.
  const G: Vec = { x: cx, y: cy };
  for (let i = 0; i < 3; i++) {
    const dx = centers[i].x - G.x;
    const dy = centers[i].y - G.y;
    const dist = Math.hypot(dx, dy) || 1;
    labelAnchors.push({
      set: i,
      x: Math.round(centers[i].x + (dx / dist) * r * 0.66),
      y: Math.round(centers[i].y + (dy / dist) * r * 0.66),
      color: BLACK,
      align: i === 0 ? 'right' : 'left',
    });
  }

  // Band gaps halve per level (the displacement law of the original engine).
  const gaps: number[] = [];
  let g = Math.max(1, Math.round(displacement * 0.3));
  for (let k = 4; k <= n; k++) {
    gaps.push(g);
    g = Math.max(1, Math.trunc(g / 2));
  }

  // Midline of set 4, exactly like the reference figure: an arc of circle
  // C's boundary that STARTS inside circle A (just past the lower C∩A
  // crossing), sweeps over the top (through the A, A∩B and B zones) and ENDS
  // in the outside zone (just past the C∩B crossing on the lower right).
  // The omitted bottom arc of C is the gateway; because each end stub sits
  // beyond a boundary junction, no region's band coverage is ever bisected —
  // the left hooks nest inside A, the right hooks outside, as in the figure.
  const g4 = gaps[0];
  const margin = Math.asin(Math.min(0.9, (2.6 * g4) / r));
  const insideCircle = (p: Vec, c: Vec): boolean => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 <= r * r;
  const pointOnC3 = (angle: number): Vec => ({
    x: c3.x + r * Math.cos(angle),
    y: c3.y + r * Math.sin(angle),
  });
  /** Crossing of circle 3 with `other`, choosing the one farther from `avoid`. */
  const crossingAngle = (other: Vec, avoid: Vec): number => {
    const d = Math.hypot(other.x - c3.x, other.y - c3.y);
    const chord = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
    const mid: Vec = { x: (other.x + c3.x) / 2, y: (other.y + c3.y) / 2 };
    const perp: Vec = { x: -(other.y - c3.y) / d, y: (other.x - c3.x) / d };
    const p1: Vec = { x: mid.x + chord * perp.x, y: mid.y + chord * perp.y };
    const p2: Vec = { x: mid.x - chord * perp.x, y: mid.y - chord * perp.y };
    const pick = Math.hypot(p1.x - avoid.x, p1.y - avoid.y) > Math.hypot(p2.x - avoid.x, p2.y - avoid.y) ? p1 : p2;
    return Math.atan2(pick.y - c3.y, pick.x - c3.x);
  };
  const aCrossA = crossingAngle(c1, c2); // lower-left C∩A crossing
  const aCrossB = crossingAngle(c2, c1); // right-side C∩B crossing
  // Start: past the C∩A crossing INTO circle A.
  const startAngle = insideCircle(pointOnC3(aCrossA + margin), c1) ? aCrossA + margin : aCrossA - margin;
  // End: past the C∩B crossing OUT of circle B (and outside A).
  const endCandidatePlus = pointOnC3(aCrossB + 1.6 * margin);
  const endAngle =
    !insideCircle(endCandidatePlus, c2) && !insideCircle(endCandidatePlus, c1)
      ? aCrossB + 1.6 * margin
      : aCrossB - 1.6 * margin;
  // Sweep from start to end the way that passes over the top (nearest B).
  const norm = (a: number): number => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const sweepCCW = norm(endAngle - startAngle);
  const midCCW = pointOnC3(startAngle + sweepCCW / 2);
  const midCW = pointOnC3(startAngle + (sweepCCW - Math.PI * 2) / 2);
  const distB = (p: Vec): number => Math.hypot(p.x - c2.x, p.y - c2.y);
  const sweep = distB(midCCW) <= distB(midCW) ? sweepCCW : sweepCCW - Math.PI * 2;
  let chain: Arc[] = [{ cx: c3.x, cy: c3.y, r, a0: startAngle, a1: startAngle + sweep }];

  // Analytic region map, built incrementally: 3 circle bits OR-ed in by
  // per-row span arithmetic, then one bit per band loop OR-ed in by the
  // edge-table polygon fill, and finally stroke pixels forced to −1.
  const numberOfLines = Math.pow(2, n);
  const regionMap = new Int32Array(width * height);
  const r2 = r * r;
  const orCircleBit = (c: Vec, bit: number): void => {
    const yTop = Math.max(0, Math.ceil(c.y - r));
    const yBottom = Math.min(height - 1, Math.floor(c.y + r));
    for (let y = yTop; y <= yBottom; y++) {
      const dy = y - c.y;
      const half = Math.sqrt(r2 - dy * dy); // inside iff |x − cx| ≤ half
      let x0 = Math.ceil(c.x - half);
      let x1 = Math.floor(c.x + half);
      if (x0 < 0) x0 = 0;
      if (x1 > width - 1) x1 = width - 1;
      const rowBase = y * width;
      for (let x = x0; x <= x1; x++) {
        regionMap[rowBase + x] |= bit;
      }
    }
  };
  orCircleBit(c1, 1 << (n - 1));
  orCircleBit(c2, 1 << (n - 2));
  orCircleBit(c3, 1 << (n - 3));

  for (let k = 4; k <= n; k++) {
    const gk = gaps[k - 4];
    const color = CURVE_CYCLE[(k - 4) % CURVE_CYCLE.length];
    const { loop, nextChain } = bandAround(chain, gk);
    raster.markGroup(k - 1, color);
    for (const arc of loop) {
      raster.drawArc(arc.cx, arc.cy, arc.r, arc.a0, arc.a1, color);
    }
    orPolygonBit(regionMap, width, height, polygonizeLoop(loop), 1 << (n - k));
    // Label at the gateway, just outside the chain's start.
    const first = chain[0];
    const startPoint = pointAt(first, first.a0);
    const startTangent = tangentAt(first, first.a0);
    labelAnchors.push({
      set: k - 1,
      x: Math.round(startPoint.x - startTangent.x * (gk + 14)),
      y: Math.round(startPoint.y - startTangent.y * (gk + 14) + 5),
      color,
      align: 'left',
    });
    chain = nextChain;
  }

  // Stroke pixels are region boundaries, not region members.
  const data = raster.data;
  for (let index = 0; index < data.length; index++) {
    if (data[index] !== WHITE) regionMap[index] = -1;
  }

  // One interior seed per region: a white pixel whose 4-neighbours share its
  // row (so the flood fill starts strictly inside the region).
  const seedForRow: Pt[] = new Array<Pt>(numberOfLines).fill({ x: -1, y: -1 });
  const found = new Uint8Array(numberOfLines);
  let remaining = numberOfLines;
  for (let y = 1; y < height - 1 && remaining > 0; y++) {
    const rowBase = y * width;
    for (let x = 1; x < width - 1; x++) {
      const index = rowBase + x;
      const row = regionMap[index];
      if (row < 0 || found[row] === 1) continue;
      if (
        regionMap[index - 1] === row &&
        regionMap[index + 1] === row &&
        regionMap[index - width] === row &&
        regionMap[index + width] === row
      ) {
        found[row] = 1;
        seedForRow[row] = { x, y };
        remaining--;
      }
    }
  }

  // values order: index i ↔ row (2^n − 1 − i).
  const seedsInValuesOrder: Pt[] = new Array<Pt>(numberOfLines);
  for (let i = 0; i < numberOfLines; i++) {
    seedsInValuesOrder[i] = seedForRow[numberOfLines - 1 - i];
  }
  return { seedsInValuesOrder, regionMap, labelAnchors };
}
