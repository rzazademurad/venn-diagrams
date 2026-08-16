/**
 * The transfer protocol between the geometry worker and the main thread.
 *
 * A `DiagramSnapshot` carries everything the UI needs to render and interact
 * with a finished diagram: the pixel buffer (transferred, zero-copy), the
 * vector ops for SVG export + construction replay, the labels, the region→row
 * map (downsampled when very large — hit-testing a mouse cursor does not need
 * 295 million entries), the per-row seeds and the engine's zoom state.
 */

import type { DrawOp, OpGroup } from '../renderer/Raster.ts';
import type { DiagramLabel } from './MainInterface.ts';
import type { GeometryStyle } from '../geometry/VennsConstruction.ts';
import type { Pt } from '../geometry/Mapper.ts';
import type { MainInterface } from './MainInterface.ts';
import type { StatementError } from './analyze.ts';

/** Region maps above this many entries are stride-downsampled before transfer. */
export const MAX_TRANSFER_MAP_PIXELS = 64_000_000;

export interface VennStateSnapshot {
  width: number;
  length: number;
  ZOOM: number;
  ZOOMFACTOR: number;
  style: GeometryStyle;
  blockedFills: number;
  zoomDenied: boolean;
  canZoomIn: boolean;
  /** The engine's buffer budget — lets the UI simulate the zoom ladder. */
  maxBufferPixels: number;
}

export interface DiagramSnapshot {
  width: number;
  height: number;
  /** RGBA pixels (Uint32 view) — TRANSFERRED. */
  pixels: ArrayBuffer;
  ops: DrawOp[];
  opGroups: OpGroup[];
  labels: DiagramLabel[];
  /** Region→row map (Int32 view) — TRANSFERRED; null when no diagram. */
  regionMap: ArrayBuffer | null;
  regionMapWidth: number;
  regionMapHeight: number;
  /** Buffer pixels per map cell along each axis (1 = exact). */
  regionMapScale: number;
  seedForRow: (Pt | null)[];
  venn: VennStateSnapshot;
  values: string;
  statement: string;
  numberOfPropositions: number;
  autoZoomSteps: number;
  blockedRegions: number;
}

/* ------------------------------- messages --------------------------------- */

export type WorkerRequest =
  | {
      id: number;
      type: 'construct';
      statement: string;
      outputMode: number;
      alphabetize: boolean;
      style: GeometryStyle;
      resetZoom: boolean;
      maxBufferPixels: number;
    }
  | { id: number; type: 'zoom'; action: 'in' | 'out' | 'reset'; steps: number }
  | { id: number; type: 'default'; style: GeometryStyle; maxBufferPixels: number }
  | {
      id: number;
      type: 'restore';
      venn: { width: number; length: number; ZOOM: number; ZOOMFACTOR: number };
      style: GeometryStyle;
      statement: string;
      values: string;
      labelNames: string[];
      maxBufferPixels: number;
    };

export type WorkerResponse =
  | {
      type: 'progress';
      label: string;
      done: number;
      total: number;
      /** Live working-buffer size — narrated in the UI's progress pill. */
      width?: number;
      height?: number;
    }
  | { id: number; type: 'done'; ok: true; snapshot: DiagramSnapshot }
  | { id: number; type: 'done'; ok: false; error: StatementError };

/* ------------------------------ construction ------------------------------- */

/** Stride-downsamples a region map so it stays under `maxPixels` entries. */
export function downsampleRegionMap(
  map: Int32Array,
  width: number,
  height: number,
  maxPixels: number,
): { map: Int32Array; width: number; height: number; scale: number } {
  if (width * height <= maxPixels) {
    return { map, width, height, scale: 1 };
  }
  let scale = 2;
  while ((Math.ceil(width / scale) * Math.ceil(height / scale)) > maxPixels) {
    scale *= 2;
  }
  const dw = Math.ceil(width / scale);
  const dh = Math.ceil(height / scale);
  const out = new Int32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(height - 1, y * scale);
    const srcBase = sy * width;
    const outBase = y * dw;
    for (let x = 0; x < dw; x++) {
      out[outBase + x] = map[srcBase + Math.min(width - 1, x * scale)];
    }
  }
  return { map: out, width: dw, height: dh, scale };
}

/**
 * Extracts a transferable snapshot from a `MainInterface` after a completed
 * construct/zoom. Returns the transfer list alongside — the pixel buffer (and
 * the map buffer when not downsampled-copied) move zero-copy.
 *
 * NOTE: after posting, the worker's raster is detached — the caller must
 * re-arm it with `app.venn.update(false)`.
 */
export function buildSnapshot(
  app: MainInterface,
  autoZoomSteps: number,
): { snapshot: DiagramSnapshot; transfers: ArrayBuffer[] } {
  const raster = app.venn.buffer;
  const transfers: ArrayBuffer[] = [raster.data.buffer];

  let mapBuffer: ArrayBuffer | null = null;
  let mapW = 0;
  let mapH = 0;
  let mapScale = 1;
  if (app.regionMap !== null) {
    const down = downsampleRegionMap(
      app.regionMap,
      app.regionMapWidth,
      app.regionMapHeight,
      MAX_TRANSFER_MAP_PIXELS,
    );
    mapBuffer = down.map.buffer as ArrayBuffer;
    mapW = down.width;
    mapH = down.height;
    mapScale = down.scale;
    transfers.push(mapBuffer);
  }

  const snapshot: DiagramSnapshot = {
    width: raster.width,
    height: raster.height,
    pixels: raster.data.buffer,
    ops: raster.ops,
    opGroups: raster.opGroups,
    labels: app.lastLabels,
    regionMap: mapBuffer,
    regionMapWidth: mapW,
    regionMapHeight: mapH,
    regionMapScale: mapScale,
    seedForRow: app.seedForRow,
    venn: {
      width: app.venn.width,
      length: app.venn.length,
      ZOOM: app.venn.ZOOM,
      ZOOMFACTOR: app.venn.ZOOMFACTOR,
      style: app.venn.style,
      blockedFills: app.venn.blockedFills,
      zoomDenied: app.venn.zoomDenied,
      canZoomIn: app.venn.canZoomIn(),
      maxBufferPixels: app.venn.maxBufferPixels,
    },
    values: app.lastValues,
    statement: app.lastStatement,
    numberOfPropositions: app.labelNames.length,
    autoZoomSteps,
    blockedRegions: app.venn.blockedFills,
  };
  return { snapshot, transfers };
}
