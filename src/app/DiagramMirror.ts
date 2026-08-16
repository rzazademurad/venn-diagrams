/**
 * Main-thread mirror of the geometry worker's diagram.
 *
 * Holds the last transferred snapshot as live objects the UI can use
 * synchronously: a `Raster` (for the tile renderer + SVG export), the
 * region→row map (scale-aware hit-testing), labels, seeds and the engine's
 * zoom state. `revision` bumps whenever pixels change so consumers re-blit.
 */

import { Raster } from '../renderer/Raster.ts';
import { DEFAULT_WIDTH, DEFAULT_LENGTH } from '../geometry/VennsConstruction.ts';
import type { DiagramSnapshot, VennStateSnapshot } from './snapshot.ts';
import type { DiagramLabel } from './MainInterface.ts';
import type { Pt } from '../geometry/Mapper.ts';

export interface RecrispPlan {
  action: 'in' | 'out';
  /** Ladder steps to run in ONE worker job (single buffer swap). */
  steps: number;
}

export class DiagramMirror {
  public raster: Raster | null = null;
  public labels: DiagramLabel[] = [];
  public regionMap: Int32Array | null = null;
  public regionMapWidth = 0;
  public regionMapHeight = 0;
  public regionMapScale = 1;
  public seedForRow: (Pt | null)[] = [];
  public venn: VennStateSnapshot | null = null;
  public values = '';
  public statement = '';
  public autoZoomSteps = 0;
  public blockedRegions = 0;
  public revision = 0;

  public get width(): number {
    return this.raster?.width ?? this.venn?.width ?? DEFAULT_WIDTH;
  }

  public get height(): number {
    return this.raster?.height ?? this.venn?.length ?? DEFAULT_WIDTH;
  }

  public get hasDiagram(): boolean {
    return this.values.length > 0;
  }

  /** The buffer-zoom percentage exactly as the toolbar displayed it before. */
  public get zoomRatio(): number {
    return (this.venn?.width ?? DEFAULT_WIDTH) / DEFAULT_WIDTH;
  }

  public applySnapshot(snapshot: DiagramSnapshot): void {
    this.raster = Raster.adopt(snapshot.width, snapshot.height, snapshot.pixels, snapshot.ops, snapshot.opGroups);
    this.labels = snapshot.labels;
    this.regionMap = snapshot.regionMap !== null ? new Int32Array(snapshot.regionMap) : null;
    this.regionMapWidth = snapshot.regionMapWidth;
    this.regionMapHeight = snapshot.regionMapHeight;
    this.regionMapScale = snapshot.regionMapScale;
    this.seedForRow = snapshot.seedForRow;
    this.venn = snapshot.venn;
    this.values = snapshot.values;
    this.statement = snapshot.statement;
    this.autoZoomSteps = snapshot.autoZoomSteps;
    this.blockedRegions = snapshot.blockedRegions;
    this.revision++;
  }

  /** Returns the truth-table row whose region contains buffer pixel (x, y), or null. */
  public regionAt(x: number, y: number): number | null {
    if (this.regionMap === null) return null;
    const mx = Math.floor(x / this.regionMapScale);
    const my = Math.floor(y / this.regionMapScale);
    if (mx < 0 || my < 0 || mx >= this.regionMapWidth || my >= this.regionMapHeight) return null;
    const row = this.regionMap[my * this.regionMapWidth + mx];
    return row >= 0 ? row : null;
  }

  /**
   * Simulates the ORIGINAL zoom ladder (width += ZOOM; ZOOM += ZOOMFACTOR++ —
   * and its inverse with the Java guards) to compute how many steps bring the
   * compensated view scale back into the crisp band. The whole plan runs as
   * ONE worker job, so a settle causes exactly one buffer swap — no
   * construct-flash per ladder step.
   */
  public planRecrisp(viewScale: number): RecrispPlan | null {
    const v = this.venn;
    if (v === null) return null;
    let w = v.width;
    let l = v.length;
    let Z = v.ZOOM;
    let ZF = v.ZOOMFACTOR;
    if (viewScale > 1.06) {
      let f = 1;
      let steps = 0;
      while (viewScale / f > 1.06 && steps < 24) {
        if ((w + Z) * (l + Z) > v.maxBufferPixels) break;
        f *= (w + Z) / w;
        w += Z;
        l += Z;
        Z += ZF;
        ZF++;
        steps++;
      }
      return steps > 0 ? { action: 'in', steps } : null;
    }
    if (viewScale < 0.52 && w > DEFAULT_WIDTH) {
      let f = 1;
      let steps = 0;
      while (viewScale / f < 0.62 && steps < 24) {
        if (!(w > DEFAULT_WIDTH && l > DEFAULT_LENGTH)) break;
        if (w - Z < DEFAULT_WIDTH || l - Z < DEFAULT_LENGTH) {
          // The engine's zoomout would reset() here.
          f *= DEFAULT_WIDTH / w;
          steps++;
          break;
        }
        f *= (w - Z) / w;
        w -= Z;
        l -= Z;
        Z -= ZF;
        ZF--;
        steps++;
      }
      return steps > 0 ? { action: 'out', steps } : null;
    }
    return null;
  }

  /** Rows that own a visible region (for keyboard region-walking), ascending. */
  public rowsWithRegion(): number[] {
    const rows: number[] = [];
    for (let row = 0; row < this.seedForRow.length; row++) {
      if (this.seedForRow[row] !== null) rows.push(row);
    }
    return rows;
  }
}
