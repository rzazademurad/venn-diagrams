/**
 * Port of the algorithmic core of `constructingVennDiagram/MainInterface.java`
 * (the Swing plumbing is replaced by React components; everything that decides
 * WHAT gets computed and filled is preserved 1:1):
 *
 *   - `processCommand()`  : Scanner -> reformat -> Parser -> TruthTable ->
 *                           evaluation -> `loop(values)` (the logic front half
 *                           lives in `analyze.ts` so the UI thread can build
 *                           the table instantly while the geometry runs in a
 *                           worker)
 *   - `computeValuesForPainting()` (from TruthTablePanel): the main-column
 *     value of every row concatenated in REVERSE row order, so index 0 of the
 *     string is the all-true row
 *   - `loop(values)`      : draws the N-set diagram and fills regions directly
 *                           (N < 4) or through the Mapper (N >= 4)
 *   - `construct(path, values)`: point-pair extraction in alternating
 *     directions, quadrant lists, matrix folding, final seed list, flood fill
 *   - the evaluation runner mirroring `MainInterface.run()` including the
 *     row/second statistics
 *
 * The instance is DOM-free, so the app runs it inside a Web Worker (see
 * `src/worker/vennWorker.ts`) — the optional `onProgress` hook reports coarse
 * milestones ('drawing', 'drawn', 'mapping', 'filling', 'auto-zoom') without
 * altering any computed pixel.
 */

import { TruthTable } from '../logic/TruthTable.ts';
import { VennsConstruction } from '../geometry/VennsConstruction.ts';
import { MapList, type Pt } from '../geometry/Mapper.ts';
import { WHITE } from '../renderer/Raster.ts';
import {
  analyzeStatement,
  computeValuesForPainting,
  evaluateTable,
  isTrueChar,
  MAX_PROPOSITIONS,
  type StatementError,
  type EvaluationResult,
} from './analyze.ts';

export type { StatementError, EvaluationResult };
export { MAX_PROPOSITIONS };

/** A rendered set label (thesis §5.2 labeling feature). */
export interface DiagramLabel {
  text: string;
  x: number;
  y: number;
  color: number;
  align: 'left' | 'right';
}

export interface ConstructSuccess {
  ok: true;
  /** The reformatted statement (`scanner.getStatement()`). */
  statement: string;
  truthTable: TruthTable;
  /** TruthTablePanel.values — reversed main-column string driving the fills. */
  values: string;
  evaluation: EvaluationResult;
  numberOfPropositions: number;
  /** Thesis §4.1: automatic zoom-in steps applied so every region is fillable. */
  autoZoomSteps: number;
  /** Regions still unfillable after auto-zoom (0 unless the diagram is extreme). */
  blockedRegions: number;
}

export interface ConstructFailure {
  ok: false;
  error: StatementError;
}

export type ConstructResult = ConstructSuccess | ConstructFailure;

/**
 * Upper bound on the automatic zoom-in steps used to resolve the thesis §4.1
 * bug ("no pixels left between the curves"). Each step is the original
 * `zoomin()` (width += ZOOM; ZOOM += ZOOMFACTOR++), so the buffer grows fast.
 */
export const MAX_AUTO_ZOOM_STEPS = 16;

/** Coarse progress milestone reporter (label, done, total). */
export type ProgressHook = (label: string, done: number, total: number) => void;

export class MainInterface {
  public readonly venn: VennsConstruction;
  public truthTable: TruthTable | null = null;
  public lastStatement = '';
  public lastValues = '';
  public outputMode: number; // TruthValue.TRUE_FALSE | ZERO_ONE
  public alphabetizePropositions = false;
  /** Set labels for the current diagram (thesis §5.2 labeling feature). */
  public lastLabels: DiagramLabel[] = [];
  /**
   * Proposition names bound to sets 0..n−1 for labeling. Set by
   * `processCommand` from the truth table, or directly by the worker's
   * `restore` message (which re-arms zoom redraws without re-parsing).
   */
  public labelNames: string[] = [];

  /** Optional coarse progress reporter (used by the worker). */
  public onProgress: ProgressHook | null = null;

  /**
   * Per-pixel region→row map for the current diagram: `regionMap[y*w + x]`
   * holds the ABSOLUTE truth-table row whose region contains that pixel, or
   * -1 for stroke pixels / unmapped areas. Built from the strokes-only buffer
   * before any fill, so it is independent of which regions end up orange.
   * Powers the region ↔ truth-table-row linking (thesis §2.2.4 made tangible).
   */
  public regionMap: Int32Array | null = null;
  public regionMapWidth = 0;
  public regionMapHeight = 0;
  /** Seed point of every row's region (absolute row index), when known. */
  public seedForRow: (Pt | null)[] = [];

  constructor(outputMode: number) {
    this.outputMode = outputMode;
    this.venn = new VennsConstruction();
  }

  /**
   * Java: `MainInterface.processCommand(String statement, boolean updateFields)`.
   * Returns a structured result instead of showing dialogs.
   */
  public processCommand(statementInput: string): ConstructResult {
    const analysis = analyzeStatement(statementInput, this.outputMode, this.alphabetizePropositions);
    if (!analysis.ok) {
      return analysis;
    }
    const { statement, truthTable, values, evaluation } = analysis;

    this.truthTable = truthTable;
    this.lastStatement = statement;
    this.lastValues = values;
    this.labelNames = analysis.propositionNames;

    // MainInterface.processCommand tail: loop(truthTablePanel.values)
    this.loop(values);

    // Thesis §4.1 known bug + its documented remedy, automated: when the
    // displacement collapses and some regions have no pixels left between
    // the curves, zoom in (rebuilding vectors at a larger displacement and
    // re-running every fill) until all regions are fillable. The zoom-in is
    // additionally bounded by the browser-safe buffer budget (`canZoomIn`),
    // which is Infinity in the pure engine/tests.
    let autoZoomSteps = 0;
    while (this.venn.blockedFills > 0 && autoZoomSteps < MAX_AUTO_ZOOM_STEPS && this.venn.canZoomIn()) {
      this.venn.zoomin(false); // loop() below draws AND fills — one construction per step
      autoZoomSteps++;
      this.onProgress?.('auto-zoom', autoZoomSteps, MAX_AUTO_ZOOM_STEPS);
      this.loop(values);
    }

    return {
      ok: true,
      statement,
      truthTable,
      values,
      evaluation,
      numberOfPropositions: truthTable.getNumberOfPropositions(),
      autoZoomSteps,
      blockedRegions: this.venn.blockedFills,
    };
  }

  /**
   * Redraw the diagram (and its fills) after a zoom operation, reusing the
   * already-computed truth table — the pixels are identical to the Java flow
   * (zoom -> update() -> processCommand -> loop) without re-parsing.
   */
  public redraw(): void {
    if (this.lastValues.length > 0) {
      this.loop(this.lastValues);
    }
  }

  /**
   * UI zoom entry point: applies the original zoom arithmetic WITHOUT the
   * intermediate strokes-only draw (`redraw = false`), then re-runs `loop`
   * once — a single construction + fill pass per zoom action instead of two.
   * Pixels are identical to `zoomin(); redraw();`, at half the cost.
   * Returns false when a zoom-in was denied by the buffer budget.
   */
  public zoomAction(action: 'in' | 'out' | 'reset'): boolean {
    const hasDiagram = this.lastValues.length > 0;
    if (action === 'in') {
      this.venn.zoomin(!hasDiagram);
      if (this.venn.zoomDenied) return false;
    } else if (action === 'out') this.venn.zoomout(!hasDiagram);
    else this.venn.reset(!hasDiagram);
    if (hasDiagram) this.loop(this.lastValues);
    return true;
  }

  /**
   * Java: `TruthTablePanel.computeValuesForPainting()` — delegated to
   * `analyze.ts` (kept as a static for API/parity-test compatibility).
   */
  public static computeValuesForPainting(truthTable: TruthTable): string {
    return computeValuesForPainting(truthTable);
  }

  /** Port of `MainInterface.run()` — delegated to `analyze.ts`. */
  public static evaluate(truthTable: TruthTable): EvaluationResult {
    return evaluateTable(truthTable);
  }

  /**
   * Java: `MainInterface.loop(String values)` — Mapper to identify regions to fill.
   */
  public loop(values: string): void {
    // first get n as input values amount - n = Log2(2^NumberOfTruthTableLines)
    const n = 31 - Math.clz32(values.length); // exact log2 for a power of two
    this.onProgress?.('drawing', 0, 1);
    // draw venn diagram of corresponding value number
    this.venn.draw(n);
    // Thesis §5.2 labeling: bind each square/curve anchor to its proposition.
    const names = this.labelNames;
    this.lastLabels = this.venn.labelAnchors.map((a) => ({
      text: names[a.set] ?? String.fromCharCode(65 + a.set),
      x: a.x,
      y: a.y,
      color: a.color,
      align: a.align,
    }));
    // Strokes are complete (milestone only — nothing is shown until done).
    this.onProgress?.('drawn', 1, 1);
    // Region ↔ row map, computed on the strokes-only buffer BEFORE any fill.
    this.onProgress?.('mapping', 0, 1);
    this.buildRegionMap(values.length, n);
    // now check if n is either 1,2,3 or greater than them all
    // (the circular smooth construction returns direct seeds for every n)
    if (n < 4 || this.venn.style === 'circular') {
      // in this case we just fill the boxes as instructed
      if (this.venn.path === null) return; // n < 1 (no propositions): nothing to fill
      for (let i = 0; i < values.length; i++) {
        if (isTrueChar(values.charAt(i))) {
          const seed = this.venn.path[i];
          if (seed.x < 0 || seed.y < 0) {
            // Smooth style: this region has no interior pixels at this zoom.
            this.venn.blockedFills++;
            continue;
          }
          this.venn.fillPoint(seed);
        }
        if ((i & 31) === 31 || i === values.length - 1) {
          this.onProgress?.('filling', i + 1, values.length);
        }
      }
    } else {
      // in this case we use mapper function and get all points and use them
      this.construct(this.venn.path, values);
    }
  }

  /**
   * Seed corner offset for the current style. Classic: 1 (exact Java).
   * Circular: slides each corner seed diagonally past the largest possible
   * fillet cut at the innermost curve, staying well inside the band clearance.
   */
  private cornerOffset(path: Pt[]): number {
    if (this.venn.style !== 'circular') return 1;
    // n from the boundary path: |path| = 2^(n-1)
    const n = 31 - Math.clz32(path.length) + 1;
    let fd = Math.trunc(this.venn.width / 8);
    for (let I = 4; I <= n; I++) {
      fd = Math.trunc(fd / 2);
    }
    const filletCap = Math.trunc((fd * 3) / 5);
    const tLast = Math.min(Math.trunc(fd / 2), 48, filletCap);
    if (tLast < 2) return 1; // fillets fall back to sharp corners at this scale
    return Math.max(1, Math.min(Math.ceil(tLast * 0.42) + 2, Math.max(1, fd - 2)));
  }

  /**
   * Computes the seed point of EVERY region in `values` order (index i of the
   * values string → seed of that region). This is exactly the point-pair
   * extraction + matrix folding of `construct(...)`, performed on deep copies
   * of the boundary points and without the truth-value filter.
   */
  public static computeSeedsInValuesOrder(orignal: Pt[], cornerOffset = 1): Pt[] {
    const copy: Pt[] = orignal.map((p) => ({ x: p.x, y: p.y }));
    // Classic style: cornerOffset = 1, the exact Java arithmetic (seeds sit in
    // the pixel quadrants diagonal to each boundary vertex). Circular style
    // passes a larger offset: the same diagonal directions, slid far enough
    // from the vertex that the quarter-circle fillet arcs (which cut off the
    // corner tips) can never separate a seed from its region.
    const k = cornerOffset;
    const list1 = new MapList();
    const list2 = new MapList();
    const list3 = new MapList();
    const list4 = new MapList();

    let org1: Pt, org2: Pt, org3: Pt, org4: Pt, newA: Pt, newB: Pt;
    let avg: Pt;
    let direction = true;
    for (let i = 0; i < copy.length; ) {
      if (direction) {
        org1 = copy[i++];
        org2 = copy[i++];
        org3 = copy[i++];
        org4 = copy[i++];
        void org4;
        direction = !direction;
        avg = { x: Math.trunc((org2.x + org3.x) / 2), y: org2.y };
        org1.y -= k;
        org2.y += k;
        org3.y += k;
        newA = { x: org1.x + k, y: org1.y };
        newB = { x: org1.x - k, y: org1.y };
        list2.add(newA, newB);

        newA = { x: org2.x + k, y: org2.y };
        newB = { x: org2.x - k, y: org2.y };
        list1.add(newA, newB);

        newA = { x: avg.x, y: avg.y + 1 };
        newB = { x: avg.x, y: avg.y - 1 };
        list3.add(newA, newB);

        newA = { x: org3.x - k, y: org3.y };
        newB = { x: org3.x + k, y: org3.y };
        list4.add(newA, newB);
      } else {
        org4 = copy[i++];
        void org4;
        org3 = copy[i++];
        org2 = copy[i++];
        org1 = copy[i++];
        direction = !direction;
        avg = { x: Math.trunc((org2.x + org3.x) / 2), y: org2.y };

        org1.y -= k;
        org2.y += k;
        org3.y += k;

        newA = { x: org1.x + k, y: org1.y };
        newB = { x: org1.x - k, y: org1.y };
        list2.add(newB, newA);

        newA = { x: org2.x + k, y: org2.y };
        newB = { x: org2.x - k, y: org2.y };
        list1.add(newB, newA);

        newA = { x: avg.x, y: avg.y + 1 };
        newB = { x: avg.x, y: avg.y - 1 };
        list3.add(newB, newA);

        newA = { x: org3.x - k, y: org3.y };
        newB = { x: org3.x + k, y: org3.y };
        list4.add(newB, newA);
      }
    }
    const fList1 = list1.map();
    const fList2 = list2.map();
    const fList3 = list3.map();
    const fList4 = list4.map();
    return [...fList1, ...fList2, ...fList3, ...fList4];
  }

  /** Builds `regionMap`/`seedForRow` from the strokes-only buffer. */
  private buildRegionMap(numberOfLines: number, n: number): void {
    this.regionMap = null;
    this.seedForRow = [];
    this.regionMapWidth = 0;
    this.regionMapHeight = 0;
    const path = this.venn.path;
    if (n < 1 || path === null) return;

    // Smooth style (circular, n >= 4): the construction computed the map
    // analytically (circle equations + arc-loop containment) — adopt it.
    if (this.venn.smoothRegionMap !== null && this.venn.style === 'circular' && n >= 4) {
      this.regionMap = this.venn.smoothRegionMap;
      this.regionMapWidth = this.venn.buffer.width;
      this.regionMapHeight = this.venn.buffer.height;
      const seedForRow: (Pt | null)[] = new Array<Pt | null>(numberOfLines).fill(null);
      for (let i = 0; i < path.length; i++) {
        const seed = path[i];
        seedForRow[numberOfLines - 1 - i] = seed.x >= 0 && seed.y >= 0 ? { x: seed.x, y: seed.y } : null;
      }
      this.seedForRow = seedForRow;
      return;
    }

    const seedsInValuesOrder: Pt[] =
      n < 4
        ? path.map((p) => ({ x: p.x, y: p.y }))
        : MainInterface.computeSeedsInValuesOrder(path, this.cornerOffset(path));

    const raster = this.venn.buffer;
    const { width, height, data } = raster;
    const map = new Int32Array(width * height).fill(-1);
    const seedForRow: (Pt | null)[] = new Array<Pt | null>(numberOfLines).fill(null);

    for (let i = 0; i < seedsInValuesOrder.length; i++) {
      const seed = seedsInValuesOrder[i];
      const row = numberOfLines - 1 - i; // values order is reversed row order
      if (seed.x < 0 || seed.y < 0 || seed.x >= width || seed.y >= height) continue;
      const startIndex = seed.y * width + seed.x;
      if (data[startIndex] !== WHITE || map[startIndex] !== -1) continue; // blocked/duplicate seed
      seedForRow[row] = { x: seed.x, y: seed.y };
      // Iterative 4-way spread over white pixels, tagging the region id.
      map[startIndex] = row;
      const stack: number[] = [startIndex];
      while (stack.length > 0) {
        const index = stack.pop()!;
        const x = index % width;
        const y = (index - x) / width;
        if (x + 1 < width && data[index + 1] === WHITE && map[index + 1] === -1) {
          map[index + 1] = row;
          stack.push(index + 1);
        }
        if (y + 1 < height && data[index + width] === WHITE && map[index + width] === -1) {
          map[index + width] = row;
          stack.push(index + width);
        }
        if (x - 1 >= 0 && data[index - 1] === WHITE && map[index - 1] === -1) {
          map[index - 1] = row;
          stack.push(index - 1);
        }
        if (y - 1 >= 0 && data[index - width] === WHITE && map[index - width] === -1) {
          map[index - width] = row;
          stack.push(index - width);
        }
      }
    }
    this.regionMap = map;
    this.regionMapWidth = width;
    this.regionMapHeight = height;
    this.seedForRow = seedForRow;
  }

  /** Returns the truth-table row whose region contains buffer pixel (x, y), or null. */
  public regionAt(x: number, y: number): number | null {
    if (this.regionMap === null) return null;
    const bx = Math.floor(x);
    const by = Math.floor(y);
    if (bx < 0 || by < 0 || bx >= this.regionMapWidth || by >= this.regionMapHeight) return null;
    const row = this.regionMap[by * this.regionMapWidth + bx];
    return row >= 0 ? row : null;
  }

  /**
   * Java: `MainInterface.construct(List<Point> orignal, String tableValues)` —
   * point-pair extraction, quadrant lists, matrix folding and flood fill.
   * The mapping arithmetic lives in `computeSeedsInValuesOrder` (identical to
   * the original, performed on copies); this filters by the true rows and
   * flood-fills, exactly like the Java `finalList` loops.
   */
  public construct(orignal: Pt[] | null, tableValues: string): void {
    if (orignal === null) {
      console.error('Null list provided in construct [MainInterface]');
      return;
    }
    const seeds = MainInterface.computeSeedsInValuesOrder(orignal, this.cornerOffset(orignal));
    const finalList: Pt[] = [];
    for (let i = 0; i < seeds.length; i++) {
      if (isTrueChar(tableValues.charAt(i))) {
        finalList.push(seeds[i]);
      }
    }
    // now we pass a list of all points that are to be filled by flood fill algorithm
    this.venn.fillPoints(finalList, (done, total) => this.onProgress?.('filling', done, total));
  }
}
