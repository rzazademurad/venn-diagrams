/**
 * Left panel — the interactive diagram viewport.
 *
 * Rendering: the worker's pixel buffer is mirrored into a TILED renderer
 * (≤4096² tiles — immune to the browser canvas-area cap that used to blank
 * deep-zoomed diagrams). Wheel/pinch/toolbar zoom scale the VIEW instantly;
 * a debounced re-crisp runs the original zoom arithmetic in the worker and
 * compensates the view scale on arrival, so the diagram is always a crisp
 * vector rendering wherever the user settles — without per-wheel rebuilds.
 *
 * Interactions: drag pans (touch too), two-finger pinch zooms, hover shows
 * the region's MINTERM (A ∧ ¬B ∧ …), click selects (blue spotlight + table
 * row), keyboard walks regions ([ / ]), a minimap tracks the viewport inside
 * the sheet, and "Recenter" appears whenever the diagram is off-screen.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DiagramMirror } from '../app/DiagramMirror.ts';
import { CanvasRenderer, buildSVG, buildRegionHighlightCanvas } from '../renderer/CanvasRenderer.ts';
import { buildViewOverlayCanvas, setColor, type ViewMode } from '../renderer/overlays.ts';
import { cssColor } from '../renderer/Raster.ts';
import { DEFAULT_WIDTH, type GeometryStyle } from '../geometry/VennsConstruction.ts';
import { downloadBlob, downloadText, interpretedPosition } from '../exports/exporters.ts';
import { TruthValue } from '../logic/TruthValue.ts';
import { useViewport } from '../hooks/useViewport.ts';
import { prefersReducedMotion, type Theme } from '../hooks/useTheme.ts';
import { progressText, type WorkerProgress } from '../hooks/useVennWorker.ts';
import type { TruthTable } from '../logic/TruthTable.ts';

export interface VennCanvasProps {
  mirror: DiagramMirror;
  /** Bumped by the parent whenever mirror content changed. */
  revision: number;
  theme: Theme;
  /** The geometry worker is busy (construct/zoom in flight). */
  busy: boolean;
  /** Job kind while busy — constructs freeze the toolbar readouts. */
  busyKind: 'construct' | 'zoom' | 'default' | null;
  progress: WorkerProgress | null;
  onCancel(): void;
  canExport: boolean;
  exportBaseName: string;
  /** Thesis §5.2 labeling feature toggle. */
  showLabels: boolean;
  onShowLabelsChange(next: boolean): void;
  /** Increments on every successful Construct — the view re-fits and centers. */
  fitSignal: number;
  /** Region ↔ row linking. */
  selectedRow: number | null;
  onHoverRow(row: number | null): void;
  onSelectRow(row: number | null): void;
  /** Geometry style: circles/organic loops vs the exact 1:1 Java rendering. */
  geometryStyle: GeometryStyle;
  onStyleChange(next: GeometryStyle): void;
  /** View modes: plain fills / per-set colors. */
  viewMode: ViewMode;
  onViewModeChange(next: ViewMode): void;
  /** Keyboard-driven zoom actions from the app shell. */
  zoomSignal: { action: 'in' | 'out' | 'reset'; nonce: number } | null;
  /** Ask the worker for a buffer zoom (the re-crisp path); steps = ladder
   *  steps to run in ONE job (single buffer swap — no per-step flashing). */
  onRequestBufferZoom(action: 'in' | 'out' | 'reset', steps?: number): void;
  /** Fired when a worker zoom finished: view compensation data. */
  zoomDoneSignal: { factor: number; nonce: number } | null;
  /** For the minterm tooltip + legend letters. */
  truthTable: TruthTable | null;
}

interface HoverInfo {
  row: number;
  cssX: number;
  cssY: number;
}

/** One legend chip: swatch + letter; click toggles solo-highlighting the set. */
function SetChip(props: {
  name: string;
  index: number;
  solo: number | null;
  onToggle(next: number | null): void;
  wide?: boolean;
}): React.JSX.Element {
  const { name, index, solo, onToggle, wide } = props;
  const active = solo === index;
  const dimmed = solo !== null && !active;
  return (
    <button
      className={`inline-flex h-6 items-center gap-1 rounded-md border px-1.5 font-mono transition-all focus-visible:outline-2 focus-visible:outline-uom-500 ${
        wide ? 'justify-center' : ''
      } ${
        active
          ? 'border-uom-500 bg-uom-50 font-bold text-uom-800 shadow-sm dark:border-uom-400 dark:bg-uom-950 dark:text-uom-200'
          : 'border-transparent text-slate-600 hover:border-slate-300 hover:bg-white dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800'
      } ${dimmed ? 'opacity-45' : ''}`}
      onClick={() => onToggle(active ? null : index)}
      title={active ? `Show all sets again` : `Highlight only set ${name}'s regions`}
      aria-pressed={active}
    >
      <span
        className="inline-block h-3 w-3 rounded-[4px] shadow-inner ring-1 ring-black/10"
        style={{ backgroundColor: setColor(index).css }}
      />
      {name}
    </button>
  );
}

const TOOLBAR_BTN =
  'h-7 px-2.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-uom-500';
const SEG_WRAP =
  'inline-flex items-center divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-800';
const GHOST_BTN =
  'text-slate-600 hover:bg-uom-50 hover:text-uom-700 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-uom-300';
const CHIP_MONO =
  'inline-flex h-7 items-center rounded-lg bg-slate-100 px-2 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300';

export function VennCanvas(props: VennCanvasProps): React.JSX.Element {
  const {
    mirror,
    revision,
    theme,
    busy,
    busyKind,
    progress,
    onCancel,
    canExport,
    exportBaseName,
    showLabels,
    onShowLabelsChange,
    fitSignal,
    selectedRow,
    onHoverRow,
    onSelectRow,
    geometryStyle,
    onStyleChange,
    viewMode,
    onViewModeChange,
    zoomSignal,
    onRequestBufferZoom,
    zoomDoneSignal,
    truthTable,
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const replayCanvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [dragging, setDragging] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [replaying, setReplaying] = useState(false);
  /** Sets mode: highlight only this set (0-based), toggled from the legend. */
  const [soloSet, setSoloSet] = useState<number | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ startDist: number; startScale: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number; active: boolean; moved: boolean }>({
    x: 0,
    y: 0,
    panX: 0,
    panY: 0,
    active: false,
    moved: false,
  });

  if (rendererRef.current === null) {
    rendererRef.current = new CanvasRenderer();
  }

  // Live refs for rAF loops (replay) that must track the current viewport.
  const panRef = useRef({ x: 16, y: 16 });
  const scaleRef = useRef(1);

  const n = mirror.hasDiagram ? 31 - Math.clz32(mirror.values.length) : 0;

  const viewport = useViewport({
    contentWidth: mirror.width,
    contentHeight: mirror.height,
    viewWidth: size.w,
    viewHeight: size.h,
    canRebuildIn: mirror.venn?.canZoomIn ?? false,
    canRebuildOut: (mirror.venn?.width ?? DEFAULT_WIDTH) > DEFAULT_WIDTH,
    rebuildBusy: busy,
    hasDiagram: mirror.hasDiagram,
    requestRebuild: () => {
      // Simulate the original zoom ladder and run ALL needed steps as one
      // worker job — one settle, one buffer swap, no flashing.
      const plan = mirror.planRecrisp(scaleRef.current);
      if (plan !== null) onRequestBufferZoom(plan.action, plan.steps);
    },
  });
  const { pan, viewScale, setPan, clampPan, fitView, zoomViewBy, compensateRebuild, scheduleRecrisp } = viewport;
  panRef.current = pan;
  scaleRef.current = viewScale;

  // Observe container size.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit on first layout and after every successful Construct.
  const fittedRef = useRef(false);
  useLayoutEffect(() => {
    if (fittedRef.current || size.w === 0 || size.h === 0) return;
    fittedRef.current = true;
    fitView();
  }, [size, fitView]);
  const prevFitSignal = useRef(fitSignal);
  useLayoutEffect(() => {
    if (prevFitSignal.current !== fitSignal) {
      prevFitSignal.current = fitSignal;
      fitView();
    }
  }, [fitSignal, fitView]);

  // Worker zoom finished → exact view compensation, then keep re-crisping.
  const prevZoomDone = useRef(0);
  useEffect(() => {
    if (zoomDoneSignal !== null && zoomDoneSignal.nonce !== prevZoomDone.current) {
      prevZoomDone.current = zoomDoneSignal.nonce;
      compensateRebuild(zoomDoneSignal.factor);
      scheduleRecrisp();
    }
  }, [zoomDoneSignal, compensateRebuild, scheduleRecrisp]);

  // Region highlight overlay for the selected truth-table row (UoM purple).
  const highlightCanvas = useMemo(
    () =>
      buildRegionHighlightCanvas(mirror.regionMap, mirror.regionMapWidth, mirror.regionMapHeight, selectedRow, {
        r: 102,
        g: 0,
        b: 153,
        a: 96,
      }),
    // revision is part of the key: a redraw rebuilds the region map
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mirror, selectedRow, revision],
  );

  // View-mode overlay (per-set colors / solo set).
  const overlayCanvas = useMemo(
    () => buildViewOverlayCanvas(mirror.regionMap, mirror.regionMapWidth, mirror.regionMapHeight, viewMode, n, soloSet),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mirror, viewMode, n, soloSet, revision],
  );

  // Solo selection is per-diagram: clear it when the set count or mode changes.
  useEffect(() => {
    setSoloSet(null);
    setLegendOpen(false);
  }, [n, viewMode]);

  // Blit + render whenever anything changes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (canvas === null || renderer === null || size.w === 0 || size.h === 0 || mirror.raster === null) return;
    renderer.sync(mirror.raster, mirror.revision);
    renderer.render(
      canvas,
      size.w,
      size.h,
      { panX: pan.x, panY: pan.y, scale: viewScale },
      showLabels ? mirror.labels : [],
      highlightCanvas,
      overlayCanvas,
      theme,
    );
  }, [mirror, revision, pan, viewScale, size, showLabels, highlightCanvas, overlayCanvas, theme]);

  /* -------------------------------- minimap -------------------------------- */

  const sheetScreen = {
    x: pan.x,
    y: pan.y,
    w: mirror.width * viewScale,
    h: mirror.height * viewScale,
  };
  const sheetFullyVisible =
    sheetScreen.x >= -2 &&
    sheetScreen.y >= -2 &&
    sheetScreen.x + sheetScreen.w <= size.w + 2 &&
    sheetScreen.y + sheetScreen.h <= size.h + 2;
  const sheetOffscreen =
    sheetScreen.x > size.w || sheetScreen.y > size.h || sheetScreen.x + sheetScreen.w < 0 || sheetScreen.y + sheetScreen.h < 0;
  const minimapVisible = !sheetFullyVisible && size.w > 0;

  useLayoutEffect(() => {
    if (!minimapVisible) return;
    const canvas = minimapRef.current;
    const renderer = rendererRef.current;
    if (canvas === null || renderer === null) return;
    const thumb = renderer.getThumb();
    if (thumb === null) return;
    const boxW = 168;
    const boxH = Math.max(48, Math.round((mirror.height / mirror.width) * boxW));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = boxW * dpr;
    canvas.height = boxH * dpr;
    canvas.style.width = `${boxW}px`;
    canvas.style.height = `${boxH}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, boxW, boxH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(thumb.canvas, 0, 0, boxW, boxH);
    // Viewport rectangle in minimap space.
    const kx = boxW / mirror.width;
    const ky = boxH / mirror.height;
    const vx = (-pan.x / viewScale) * kx;
    const vy = (-pan.y / viewScale) * ky;
    const vw = (size.w / viewScale) * kx;
    const vh = (size.h / viewScale) * ky;
    ctx.strokeStyle = '#660099';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(Math.max(0.75, vx), Math.max(0.75, vy), Math.min(boxW - 1.5, vw), Math.min(boxH - 1.5, vh));
    ctx.fillStyle = 'rgba(102,0,153,0.10)';
    ctx.fillRect(Math.max(0, vx), Math.max(0, vy), Math.min(boxW, vw), Math.min(boxH, vh));
  }, [minimapVisible, mirror, revision, pan, viewScale, size]);

  const minimapJump = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    // Center the viewport on the clicked content point.
    setPan(
      clampPan(
        { x: size.w / 2 - fx * mirror.width * viewScale, y: size.h / 2 - fy * mirror.height * viewScale },
        viewScale,
      ),
    );
  };

  /* ---------------------------- pointer handling ---------------------------- */

  /** Converts viewport CSS coordinates into buffer pixel coordinates. */
  const toBufferCoords = useCallback(
    (cssX: number, cssY: number): { x: number; y: number } => ({
      x: (cssX - pan.x) / viewScale,
      y: (cssY - pan.y) / viewScale,
    }),
    [pan, viewScale],
  );

  // Wheel: instant VIEW zoom at the cursor (re-crisp runs debounced).
  // The factor is PROPORTIONAL to the scroll delta, not per-event: macOS
  // trackpads emit dozens of small-delta events per flick (a fixed factor
  // per event made zooming wildly oversensitive), while a discrete mouse
  // wheel notch (~±120px) still lands at a comfortable ~1.3× step.
  // Trackpad pinch gestures arrive as ctrlKey+wheel and get a higher gain.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; // lines → px
      else if (e.deltaMode === 2) dy *= 120; // pages → px
      const gain = e.ctrlKey ? 0.01 : 0.0022; // pinch gesture vs scroll
      const factor = Math.min(1.6, Math.max(0.625, Math.exp(-dy * gain)));
      zoomViewBy(factor, e.clientX - rect.left, e.clientY - rect.top);
      scheduleRecrisp();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomViewBy, scheduleRecrisp]);

  // Keyboard-driven zoom from the app shell (+ / − / 0).
  const prevZoomNonce = useRef(0);
  useEffect(() => {
    if (zoomSignal !== null && zoomSignal.nonce !== prevZoomNonce.current) {
      prevZoomNonce.current = zoomSignal.nonce;
      zoom(zoomSignal.action);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomSignal]);

  const zoom = (direction: 'in' | 'out' | 'reset'): void => {
    if (direction === 'reset') {
      onRequestBufferZoom('reset');
      return; // App bumps fitSignal when the reset buffer arrives
    }
    zoomViewBy(direction === 'in' ? 1.35 : 1 / 1.35, size.w / 2, size.h / 2);
    scheduleRecrisp();
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      // Pinch start.
      const [p1, p2] = [...pointersRef.current.values()];
      pinchRef.current = { startDist: Math.hypot(p2.x - p1.x, p2.y - p1.y), startScale: viewScale };
      dragRef.current.active = false;
      setDragging(false);
      return;
    }
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y, active: true, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    // Two-finger pinch: view zoom anchored at the midpoint.
    if (pointersRef.current.size === 2 && pinchRef.current !== null) {
      const [p1, p2] = [...pointersRef.current.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (dist > 0 && pinchRef.current.startDist > 0) {
        const target = (pinchRef.current.startScale * dist) / pinchRef.current.startDist;
        const midX = (p1.x + p2.x) / 2 - rect.left;
        const midY = (p1.y + p2.y) / 2 - rect.top;
        zoomViewBy(target / viewScale, midX, midY);
      }
      return;
    }
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    if (dragRef.current.active) {
      const dx = e.clientX - dragRef.current.x;
      const dy = e.clientY - dragRef.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        dragRef.current.moved = true;
        if (!dragging) setDragging(true);
      }
      if (dragRef.current.moved) {
        setPan(clampPan({ x: dragRef.current.panX + dx, y: dragRef.current.panY + dy }, viewScale));
        if (hover !== null) {
          setHover(null);
          onHoverRow(null);
        }
        return;
      }
    }
    // Hover hit-test (also while the pointer is down but not yet dragging).
    const b = toBufferCoords(cssX, cssY);
    const row = mirror.regionAt(b.x, b.y);
    if (row === null) {
      if (hover !== null) {
        setHover(null);
        onHoverRow(null);
      }
    } else if (hover === null || hover.row !== row || Math.abs(hover.cssX - cssX) > 2 || Math.abs(hover.cssY - cssY) > 2) {
      setHover({ row, cssX, cssY });
      onHoverRow(row);
    }
  };

  const onPointerUp = (e: React.PointerEvent): void => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2 && pinchRef.current !== null) {
      pinchRef.current = null;
      scheduleRecrisp();
    }
    const wasDrag = dragRef.current.moved;
    dragRef.current.active = false;
    dragRef.current.moved = false;
    setDragging(false);
    if (!wasDrag && e.pointerType !== 'touch') {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const b = toBufferCoords(e.clientX - rect.left, e.clientY - rect.top);
      const row = mirror.regionAt(b.x, b.y);
      onSelectRow(row !== null && row === selectedRow ? null : row);
    } else if (!wasDrag && e.pointerType === 'touch') {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const b = toBufferCoords(e.clientX - rect.left, e.clientY - rect.top);
      const row = mirror.regionAt(b.x, b.y);
      if (row !== null) onSelectRow(row === selectedRow ? null : row);
    }
  };

  /* ---------------------------- keyboard access ----------------------------- */

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const PAN_STEP = e.shiftKey ? 160 : 40;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dx = e.key === 'ArrowLeft' ? PAN_STEP : e.key === 'ArrowRight' ? -PAN_STEP : 0;
      const dy = e.key === 'ArrowUp' ? PAN_STEP : e.key === 'ArrowDown' ? -PAN_STEP : 0;
      setPan((p) => clampPan({ x: p.x + dx, y: p.y + dy }, viewScale));
    } else if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      const rows = mirror.rowsWithRegion();
      if (rows.length === 0) return;
      const dir = e.key === ']' ? 1 : -1;
      const at = selectedRow === null ? -1 : rows.indexOf(selectedRow);
      const next = at === -1 ? (dir === 1 ? rows[0] : rows[rows.length - 1]) : rows[(at + dir + rows.length) % rows.length];
      onSelectRow(next);
    } else if (e.key === 'Enter' && hover !== null) {
      e.preventDefault();
      onSelectRow(hover.row === selectedRow ? null : hover.row);
    } else if (e.key === 'Escape') {
      onSelectRow(null);
    }
  };

  /* ------------------------------ replay layer ------------------------------ */

  const startReplay = (): void => {
    if (replaying || busy || mirror.raster === null || mirror.raster.ops.length === 0 || prefersReducedMotion()) return;
    setReplaying(true);
  };

  useEffect(() => {
    if (!replaying) return;
    const canvas = replayCanvasRef.current;
    const raster = mirror.raster;
    if (canvas === null || raster === null || raster.ops.length === 0) {
      setReplaying(false);
      return;
    }
    const ops = raster.ops;
    const groups = raster.opGroups.length > 0 ? raster.opGroups : [{ set: 0, color: 0, start: 0 }];
    const perGroup = Math.min(900, Math.max(420, 3600 / groups.length));
    const total = groups.length * perGroup;
    const dpr = window.devicePixelRatio || 1;
    let raf = 0;
    let start = 0;
    let fading = false;

    const draw = (now: number): void => {
      if (start === 0) start = now;
      const t = now - start;
      const bw = Math.max(1, Math.round(size.w * dpr));
      const bh = Math.max(1, Math.round(size.h * dpr));
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      const ctx = canvas.getContext('2d')!;
      const livePan = panRef.current;
      const liveScale = scaleRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      ctx.translate(livePan.x, livePan.y);
      ctx.scale(liveScale, liveScale);
      // White sheet covering the finished diagram while strokes replay.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, mirror.width, mirror.height);
      // How many ops are revealed at time t.
      let revealed = 0;
      for (let gi = 0; gi < groups.length; gi++) {
        const gStart = gi * perGroup;
        const gEnd = groups[gi + 1]?.start ?? ops.length;
        const gFrom = groups[gi].start;
        if (t >= gStart + perGroup) revealed = gEnd;
        else if (t > gStart) {
          revealed = gFrom + Math.floor(((t - gStart) / perGroup) * (gEnd - gFrom));
          break;
        } else break;
      }
      ctx.lineWidth = Math.max(1.1, 1.4 / liveScale);
      ctx.lineCap = 'round';
      for (let i = 0; i < Math.min(revealed, ops.length); i++) {
        const op = ops[i];
        ctx.strokeStyle = cssColor(op.color);
        ctx.beginPath();
        if (op.kind === 'line') {
          ctx.moveTo(op.x1 + 0.5, op.y1 + 0.5);
          ctx.lineTo(op.x2 + 0.5, op.y2 + 0.5);
        } else if (op.kind === 'circle') {
          ctx.arc(op.cx + 0.5, op.cy + 0.5, op.r, 0, Math.PI * 2);
        } else {
          ctx.arc(op.cx + 0.5, op.cy + 0.5, op.r, op.a0, op.a1, op.a1 < op.a0);
        }
        ctx.stroke();
      }
      if (t < total) {
        raf = requestAnimationFrame(draw);
      } else if (!fading) {
        fading = true;
        canvas.style.transition = 'opacity 420ms ease';
        canvas.style.opacity = '0';
        window.setTimeout(() => setReplaying(false), 440);
      }
    };
    canvas.style.opacity = '1';
    canvas.style.transition = '';
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaying]);

  /* --------------------------------- export --------------------------------- */

  const exportPNG = async (targetLongSide: number | null): Promise<void> => {
    const renderer = rendererRef.current;
    if (renderer === null || mirror.raster === null) return;
    renderer.sync(mirror.raster, mirror.revision);
    const blob = await renderer.toPNGBlob(showLabels ? mirror.labels : [], targetLongSide);
    downloadBlob(blob, `${exportBaseName}.png`);
    setExportOpen(false);
  };

  const exportSVG = (): void => {
    if (mirror.raster === null) return;
    downloadText(buildSVG(mirror.raster, showLabels ? mirror.labels : []), `${exportBaseName}.svg`, 'image/svg+xml');
    setExportOpen(false);
  };

  useEffect(() => {
    if (!exportOpen) return;
    const close = (): void => setExportOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [exportOpen]);

  useEffect(() => {
    if (!legendOpen) return;
    const close = (): void => setLegendOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [legendOpen]);

  /* --------------------------------- tooltip -------------------------------- */

  /** Minterm line for a hovered region: `#i  A ∧ ¬B ∧ C  →  T`. */
  const hoverText = useMemo((): string => {
    if (hover === null || truthTable === null) return '';
    const table = truthTable;
    const row = hover.row;
    const displayIndex = interpretedPosition(table, row);
    const names = table.getPropositionNames();
    const binary = table.getBinaryFormat(row);
    const displayMethod = table.getDisplayMethod();
    const mainChar = table.computeRow(row).charAt(table.getPositionOfMainColumn());
    const shown = Math.min(names.length, 10);
    const parts: string[] = [];
    for (let k = 0; k < shown; k++) {
      const isTrue = TruthValue.getTruthValueString(binary[k], displayMethod) === (displayMethod === TruthValue.ZERO_ONE ? '1' : 'T');
      parts.push(isTrue ? names[k] : `¬${names[k]}`);
    }
    return `${displayIndex})  ${parts.join(' ∧ ')}${names.length > shown ? ' ∧ …' : ''}  →  ${mainChar}`;
  }, [hover, truthTable]);

  /**
   * Toolbar readouts. A construct changes the canvas EXACTLY ONCE (when the
   * finished snapshot swaps in) — while it runs, the chips freeze at their
   * last settled values (dimmed), the sheet keeps the previous diagram under
   * a soft wash, and the live working size is narrated in the progress pill;
   * everything settles together in a single update when the job completes.
   * Zoom jobs keep live values (wheel feedback must track continuously).
   */
  const zoomPercentLive = Math.round(mirror.zoomRatio * viewScale * 100);
  const settledReadout = useRef({ pct: 100, w: mirror.width, h: mirror.height });
  const freezeReadouts = busy && (busyKind === 'construct' || busyKind === 'default');
  if (!freezeReadouts) {
    settledReadout.current = { pct: zoomPercentLive, w: mirror.width, h: mirror.height };
  }
  const zoomPercent = freezeReadouts ? settledReadout.current.pct : zoomPercentLive;
  const shownWidth = freezeReadouts ? settledReadout.current.w : mirror.width;
  const shownHeight = freezeReadouts ? settledReadout.current.h : mirror.height;
  const blockedRegions = mirror.blockedRegions;
  const zoomLimited = mirror.venn !== null && !mirror.venn.canZoomIn;
  const names = truthTable?.getPropositionNames() ?? [];

  const segBtn = (active: boolean): string =>
    `${TOOLBAR_BTN} ${active ? 'bg-uom-600 text-white' : GHOST_BTN}`;

  const ariaLabel = mirror.hasDiagram
    ? `Venn diagram of ${mirror.statement}: ${mirror.values.length} regions across ${n} sets. ` +
      `Use arrow keys to pan, bracket keys to walk regions, Enter to select.`
    : 'Empty Venn diagram workspace. Construct a statement to draw a diagram.';

  const pct = progress !== null && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
        <span className="hidden text-[11px] font-bold uppercase tracking-wider text-slate-400 sm:inline dark:text-slate-500">
          Diagram
        </span>
        <div className={SEG_WRAP}>
          <button className={`${TOOLBAR_BTN} text-sm font-bold ${GHOST_BTN}`} onClick={() => zoom('in')} title="Zoom in (+)">
            +
          </button>
          <button className={`${TOOLBAR_BTN} text-sm font-bold ${GHOST_BTN}`} onClick={() => zoom('out')} title="Zoom out (−)">
            −
          </button>
          <button
            className={`${TOOLBAR_BTN} ${GHOST_BTN}`}
            onClick={() => zoom('reset')}
            title="Reset zoom and fit the whole diagram (0)"
          >
            Reset
          </button>
        </div>
        <div className={SEG_WRAP}>
          <button
            className={segBtn(geometryStyle === 'circular')}
            onClick={() => onStyleChange('circular')}
            title="Smooth analytic engine — circles for 1–3 sets, inductive smooth bands beyond"
          >
            ● Circular<span className="hidden md:inline"> (Smooth)</span>
          </button>
          <button
            className={segBtn(geometryStyle === 'classic')}
            onClick={() => onStyleChange('classic')}
            title="Rectilinear discretized engine — inductive serpentine curves on a square layout"
          >
            ▢ Square<span className="hidden md:inline"> (Rectilinear)</span>
          </button>
        </div>
        <div className={SEG_WRAP} title="View mode: plain fills or per-set colors">
          <button className={segBtn(viewMode === 'fills')} onClick={() => onViewModeChange('fills')}>
            Fills
          </button>
          <button className={segBtn(viewMode === 'sets')} onClick={() => onViewModeChange('sets')} disabled={!mirror.hasDiagram}>
            Sets
          </button>
        </div>
        <span
          className={`${CHIP_MONO} transition-opacity ${freezeReadouts ? 'opacity-45' : ''}`}
          title={freezeReadouts ? 'Re-constructing — settles when finished' : 'Zoom relative to the default buffer'}
        >
          {zoomPercent}%
        </span>
        <span
          className={`${CHIP_MONO} max-xl:hidden transition-opacity ${freezeReadouts ? 'opacity-45' : ''}`}
          title={freezeReadouts ? 'Re-constructing — settles when finished' : 'Pixel-buffer size'}
        >
          {shownWidth} × {shownHeight} px
        </span>
        {viewMode === 'fills' && (
          <span
            className="hidden items-center gap-1.5 text-[11px] text-slate-500 sm:flex dark:text-slate-400"
            title="Regions where the statement is true are flood-filled orange — in both styles"
          >
            <span className="inline-block h-3 w-3 rounded-[4px] shadow-inner" style={{ backgroundColor: '#ffa500' }} />
            true regions
          </span>
        )}
        {viewMode === 'sets' && n > 0 && (
          <div
            className="relative flex items-center gap-0.5 text-[11px] text-slate-500 dark:text-slate-400"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {(names.length <= 8 ? names : names.slice(0, 5)).map((nm, j) => (
              <SetChip key={nm} name={nm} index={j} solo={soloSet} onToggle={setSoloSet} />
            ))}
            {names.length > 8 && (
              <button
                className={`inline-flex h-6 items-center rounded-md border px-1.5 font-mono text-[11px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-uom-500 ${
                  legendOpen || (soloSet !== null && soloSet >= 5)
                    ? 'border-uom-400 bg-uom-50 text-uom-700 dark:border-uom-500 dark:bg-uom-950 dark:text-uom-300'
                    : 'border-slate-200 bg-white text-slate-500 hover:border-uom-300 hover:text-uom-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400'
                }`}
                onClick={() => setLegendOpen((v) => !v)}
                title="Show all sets"
                aria-haspopup="true"
                aria-expanded={legendOpen}
              >
                +{names.length - 5}
              </button>
            )}
            {soloSet !== null && (
              <button
                className="ml-0.5 inline-flex h-6 items-center rounded-md px-1 text-[11px] text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                onClick={() => setSoloSet(null)}
                title={`Stop highlighting only ${names[soloSet] ?? ''}`}
              >
                ✕
              </button>
            )}
            {legendOpen && (
              <div className="absolute left-0 top-full z-30 mt-1.5 w-64 rounded-xl border border-slate-200 bg-white p-2.5 shadow-xl dark:border-slate-700 dark:bg-slate-800">
                <p className="mb-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  All {names.length} sets — click one to highlight only its regions
                </p>
                <div className="grid grid-cols-4 gap-1">
                  {names.map((nm, j) => (
                    <SetChip key={nm} name={nm} index={j} solo={soloSet} onToggle={setSoloSet} wide />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        <label
          className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300"
          title="Show which square/curve each letter corresponds to (L)"
        >
          <input
            type="checkbox"
            className="accent-uom-600"
            checked={showLabels}
            onChange={(e) => onShowLabelsChange(e.target.checked)}
          />
          Labels
        </label>
        <button
          className={`h-7 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 shadow-sm transition-colors hover:border-uom-300 hover:text-uom-700 focus-visible:outline-2 focus-visible:outline-uom-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:text-uom-300`}
          onClick={startReplay}
          disabled={!mirror.hasDiagram || busy || replaying || prefersReducedMotion()}
          title="Replay Venn's inductive construction curve by curve"
        >
          ▶ Replay
        </button>
        {mirror.autoZoomSteps > 0 && (
          <span
            className="rounded-full border border-uom-200 bg-uom-50 px-2 py-0.5 text-[11px] font-semibold text-uom-700 dark:border-uom-900 dark:bg-uom-950 dark:text-uom-300"
            title="Some regions had no pixels left between the curves, so the diagram was automatically zoomed in until every region became fillable"
          >
            auto-zoomed ×{mirror.autoZoomSteps}
          </span>
        )}
        {blockedRegions > 0 && (
          <span
            className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
            title="At this zoom level some regions have no pixels between the curves and cannot be filled — zoom in to reveal them, or switch to the Square (Rectilinear) engine which handles many sets more compactly"
          >
            ⚠ {blockedRegions} region{blockedRegions === 1 ? ' needs' : 's need'} more zoom
          </span>
        )}
        {zoomLimited && (
          <span
            className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
            title="The pixel buffer reached the browser-safe memory budget — the view keeps zooming, but strokes are no longer re-vectorized beyond this point"
          >
            max buffer zoom
          </span>
        )}
        <div className="ms-auto flex items-center gap-1.5">
          <div className="relative" onPointerDown={(e) => e.stopPropagation()}>
            <button
              className="h-7 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 shadow-sm transition-colors hover:border-uom-300 hover:text-uom-700 focus-visible:outline-2 focus-visible:outline-uom-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:text-uom-300"
              disabled={!canExport}
              onClick={() => setExportOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
            >
              Export ▾
            </button>
            {exportOpen && (
              <div
                role="menu"
                className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-xs shadow-xl dark:border-slate-700 dark:bg-slate-800"
              >
                <button
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left text-slate-700 hover:bg-uom-50 dark:text-slate-200 dark:hover:bg-slate-700"
                  onClick={() => void exportPNG(null)}
                >
                  PNG — full resolution ({mirror.width}×{mirror.height})
                </button>
                <button
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left text-slate-700 hover:bg-uom-50 dark:text-slate-200 dark:hover:bg-slate-700"
                  onClick={() => void exportPNG(4096)}
                >
                  PNG — fit 4096 px
                </button>
                <button
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left text-slate-700 hover:bg-uom-50 dark:text-slate-200 dark:hover:bg-slate-700"
                  onClick={() => void exportPNG(2048)}
                >
                  PNG — fit 2048 px
                </button>
                <div className="my-1 border-t border-slate-100 dark:border-slate-700" />
                <button
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left text-slate-700 hover:bg-uom-50 dark:text-slate-200 dark:hover:bg-slate-700"
                  onClick={exportSVG}
                >
                  SVG — vector strokes
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        ref={containerRef}
        role="application"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={`relative min-h-0 flex-1 touch-none overflow-hidden bg-[#f5f2f9] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-uom-400 dark:bg-[#120b1a] ${
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => {
          pointersRef.current.delete(e.pointerId);
          pinchRef.current = null;
          dragRef.current.active = false;
          dragRef.current.moved = false;
          setDragging(false);
        }}
        onPointerLeave={() => {
          setHover(null);
          onHoverRow(null);
        }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        {replaying && <canvas ref={replayCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />}

        {/* Soft wash over the PREVIOUS diagram while a construct computes —
            the sheet itself never changes until the finished result swaps in. */}
        {freezeReadouts && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-10 bg-[#f5f2f9]/55 motion-safe:transition-opacity dark:bg-[#120b1a]/55"
          />
        )}

        {/* busy progress: thin bar + status chip with cancel */}
        {busy && (
          <>
            <div className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-uom-100/60 dark:bg-uom-950/60">
              <div
                className={`h-full bg-uom-500 ${pct === null ? 'motion-safe:animate-pulse w-full' : 'transition-[width] duration-150'}`}
                style={pct !== null ? { width: `${pct}%` } : undefined}
              />
            </div>
            <div className="absolute bottom-3 left-3 z-20 flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 py-1 pl-3 pr-1 text-xs font-semibold text-slate-600 shadow-lg dark:border-slate-700 dark:bg-slate-800/95 dark:text-slate-300">
              <span className="inline-block h-3 w-3 motion-safe:animate-spin rounded-full border-2 border-uom-500 border-t-transparent" />
              {progress !== null ? progressText(progress) : 'working…'}
              {freezeReadouts && progress?.width !== undefined && (
                <span className="font-mono text-[11px] font-normal text-slate-400 dark:text-slate-500">
                  {progress.width} × {progress.height} px
                </span>
              )}
              <button
                className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600 hover:bg-rose-100 hover:text-rose-700 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-rose-900 dark:hover:text-rose-200"
                onClick={onCancel}
                title="Cancel this construction (keeps the previous diagram)"
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {/* off-screen recovery */}
        {sheetOffscreen && !busy && (
          <button
            className="absolute left-1/2 top-4 z-20 -translate-x-1/2 rounded-full border border-uom-300 bg-white/95 px-4 py-1.5 text-xs font-bold text-uom-700 shadow-lg transition hover:bg-uom-50 dark:border-uom-700 dark:bg-slate-800/95 dark:text-uom-300"
            onClick={fitView}
          >
            Diagram is off-screen — Recenter
          </button>
        )}

        {/* minimap */}
        {minimapVisible && (
          <div className="absolute bottom-3 right-3 z-20 overflow-hidden rounded-lg border border-slate-300/80 bg-white/95 shadow-lg dark:border-slate-600 dark:bg-slate-800/95">
            <canvas
              ref={minimapRef}
              className="block cursor-pointer"
              title="Minimap — click to move the viewport"
              onPointerDown={(e) => {
                e.stopPropagation();
                minimapJump(e);
              }}
              onPointerMove={(e) => {
                if (e.buttons === 1) {
                  e.stopPropagation();
                  minimapJump(e);
                }
              }}
            />
          </div>
        )}

        {hover !== null && hoverText.length > 0 && !dragging && (
          <div
            className="pointer-events-none absolute z-20 max-w-md truncate rounded-md bg-slate-900/90 px-2.5 py-1 font-mono text-[12px] text-white shadow-lg dark:bg-slate-100/95 dark:text-slate-900"
            style={{
              left: Math.min(hover.cssX + 14, Math.max(0, size.w - 280)),
              top: Math.min(hover.cssY + 14, Math.max(0, size.h - 34)),
            }}
          >
            {hoverText}
          </div>
        )}
      </div>
    </div>
  );
}
