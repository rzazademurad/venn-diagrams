/**
 * Viewport state for the diagram canvas: pan + view scale, wheel zoom at the
 * cursor, two-finger pinch zoom, fit-to-view, and the RE-CRISP loop.
 *
 * Zoom model (an evolution of the original's rebuild-per-wheel-step):
 *   - wheel / pinch / toolbar zoom changes the VIEW SCALE instantly (buttery,
 *     zero rebuild — the old model rebuilt the whole buffer per wheel event);
 *   - a debounced re-crisp then asks the worker to run the ORIGINAL zoom
 *     arithmetic (width += ZOOM; ZOOM += ZOOMFACTOR++ …) toward the current
 *     magnification. When the rebuilt buffer arrives, the view scale is
 *     divided by exactly the growth factor — the on-screen size is preserved
 *     to the pixel while the strokes snap crisp (they are re-vectorized at
 *     the new displacement, exactly like the original zoom).
 *
 * The result keeps the Java zoom model's guarantee (a crisp vector rendering
 * at every zoom level) with modern direct-manipulation feel, and it is what
 * makes gigantic buffers impossible to trigger accidentally: the buffer only
 * rebuilds when the user actually SETTLES at a deeper magnification.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Pan {
  x: number;
  y: number;
}

export interface ViewportConfig {
  /** Current buffer dimensions (content size in content px). */
  contentWidth: number;
  contentHeight: number;
  /** Viewport CSS size. */
  viewWidth: number;
  viewHeight: number;
  /** Re-crisp driver. */
  canRebuildIn: boolean;
  canRebuildOut: boolean;
  rebuildBusy: boolean;
  hasDiagram: boolean;
  requestRebuild(action: 'in' | 'out'): void;
}

export const MIN_VIEW_SCALE = 0.02;
export const MAX_VIEW_SCALE = 64;

/** Re-crisp thresholds: rebuild toward crisp when the view settles outside. */
const CRISP_HIGH = 1.06;
const CRISP_LOW = 0.52;

export function useViewport(config: ViewportConfig): {
  pan: Pan;
  viewScale: number;
  setPan: React.Dispatch<React.SetStateAction<Pan>>;
  setViewScale: React.Dispatch<React.SetStateAction<number>>;
  clampPan(p: Pan, scale: number): Pan;
  fitView(): void;
  /** Zoom the VIEW by `factor`, anchored at CSS point (ax, ay). */
  zoomViewBy(factor: number, ax: number, ay: number): void;
  /** Exact compensation when a rebuilt buffer arrives (factor = newW/oldW). */
  compensateRebuild(factor: number): void;
  /** Kick the re-crisp debounce (called after wheel/pinch/toolbar zoom). */
  scheduleRecrisp(): void;
} {
  const { contentWidth, contentHeight, viewWidth, viewHeight } = config;
  const [pan, setPan] = useState<Pan>({ x: 16, y: 16 });
  const [viewScale, setViewScale] = useState(1);
  const configRef = useRef(config);
  configRef.current = config;
  const viewScaleRef = useRef(viewScale);
  viewScaleRef.current = viewScale;

  const clampPan = useCallback(
    (p: Pan, scale: number): Pan => {
      const c = configRef.current;
      const bw = c.contentWidth * scale;
      const bh = c.contentHeight * scale;
      const margin = 60;
      return {
        x: Math.min(Math.max(p.x, margin - bw), c.viewWidth - margin),
        y: Math.min(Math.max(p.y, margin - bh), c.viewHeight - margin),
      };
    },
    [],
  );

  /** Fits the whole sheet into the viewport and centers it. */
  const fitView = useCallback((): void => {
    if (viewWidth === 0 || viewHeight === 0) return;
    const scale = Math.max(
      MIN_VIEW_SCALE,
      Math.min(1, (viewWidth - 32) / contentWidth, (viewHeight - 32) / contentHeight),
    );
    setViewScale(scale);
    setPan({ x: (viewWidth - contentWidth * scale) / 2, y: (viewHeight - contentHeight * scale) / 2 });
  }, [viewWidth, viewHeight, contentWidth, contentHeight]);

  const zoomViewBy = useCallback(
    (factor: number, ax: number, ay: number): void => {
      setViewScale((prev) => {
        const next = Math.min(MAX_VIEW_SCALE, Math.max(MIN_VIEW_SCALE, prev * factor));
        const applied = next / prev;
        setPan((p) => clampPan({ x: ax - (ax - p.x) * applied, y: ay - (ay - p.y) * applied }, next));
        return next;
      });
    },
    [clampPan],
  );

  /**
   * A rebuilt buffer arrived: content coordinates scaled by `factor`, so
   * dividing the view scale by the same factor keeps EVERY content point at
   * the same screen position (pan is invariant: screen = pan + p·f·(s/f)).
   */
  const compensateRebuild = useCallback((factor: number): void => {
    if (factor > 0 && Number.isFinite(factor)) {
      setViewScale((s) => Math.min(MAX_VIEW_SCALE, Math.max(MIN_VIEW_SCALE, s / factor)));
    }
  }, []);

  /* ------------------------------- re-crisp -------------------------------- */

  const recrispTimer = useRef<number | null>(null);
  const scheduleRecrisp = useCallback((): void => {
    if (recrispTimer.current !== null) window.clearTimeout(recrispTimer.current);
    recrispTimer.current = window.setTimeout(() => {
      recrispTimer.current = null;
      const c = configRef.current;
      if (!c.hasDiagram || c.rebuildBusy) return;
      const s = viewScaleRef.current;
      if (s > CRISP_HIGH && c.canRebuildIn) c.requestRebuild('in');
      else if (s < CRISP_LOW && c.canRebuildOut) c.requestRebuild('out');
    }, 320);
  }, []);

  useEffect(
    () => () => {
      if (recrispTimer.current !== null) window.clearTimeout(recrispTimer.current);
    },
    [],
  );

  return { pan, viewScale, setPan, setViewScale, clampPan, fitView, zoomViewBy, compensateRebuild, scheduleRecrisp };
}
