/**
 * Drives the geometry worker: job queue (latest zoom wins), progress state,
 * cancellation (terminate + respawn + state restore) and the main-thread
 * `DiagramMirror`. The mirror changes EXACTLY ONCE per job — when the
 * finished snapshot arrives — so a construct never flashes intermediate
 * states on the canvas.
 *
 * The worker is imported with `?worker&inline`, so the single-file build
 * (`npm run build:single`) keeps working — the worker ships as an inline
 * blob inside the one HTML file.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import VennWorkerFactory from '../worker/vennWorker.ts?worker&inline';
import { DiagramMirror } from '../app/DiagramMirror.ts';
import type { DiagramSnapshot, WorkerRequest, WorkerResponse } from '../app/snapshot.ts';
import type { StatementError } from '../app/analyze.ts';
import type { GeometryStyle } from '../geometry/VennsConstruction.ts';

export interface WorkerProgress {
  label: string;
  done: number;
  total: number;
  /** Live working-buffer size (auto-zoom rungs) — shown in the progress pill. */
  width?: number;
  height?: number;
}

/** Human phrasing for the engine's progress milestones. */
export function progressText(p: WorkerProgress): string {
  switch (p.label) {
    case 'drawing':
      return 'drawing curves…';
    case 'mapping':
      return 'mapping regions…';
    case 'filling': {
      const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
      return `filling regions… ${pct}%`;
    }
    case 'auto-zoom':
      return `auto-zoom ×${p.done} — re-constructing…`;
    default:
      return 'working…';
  }
}

/**
 * Browser-safe buffer budget: with the tiled renderer no single canvas can
 * blank out any more, so this bounds MEMORY (raster + region map + tiles are
 * 4 bytes/px each). Mobile browsers get a smaller budget.
 */
export function detectBufferBudget(): number {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return 64_000_000;
  return 268_000_000;
}

type Job =
  | { kind: 'construct'; statement: string; outputMode: number; alphabetize: boolean; style: GeometryStyle; resetZoom: boolean }
  | { kind: 'zoom'; action: 'in' | 'out' | 'reset'; steps: number }
  | { kind: 'default'; style: GeometryStyle };

export interface UseVennWorker {
  mirror: DiagramMirror;
  /** Bumps whenever the mirror content changed (new pixels / snapshot). */
  mirrorRevision: number;
  busy: boolean;
  /** What kind of job is running — constructs freeze the toolbar readouts. */
  busyKind: 'construct' | 'zoom' | 'default' | null;
  progress: WorkerProgress | null;
  construct(statement: string, outputMode: number, alphabetize: boolean, style: GeometryStyle, resetZoom: boolean): void;
  zoom(action: 'in' | 'out' | 'reset', steps?: number): void;
  showDefault(style: GeometryStyle): void;
  cancel(): void;
  /** Set once from App: outcome callbacks. */
  callbacks: React.RefObject<WorkerCallbacks>;
}

export interface WorkerCallbacks {
  onConstructDone?(snapshot: DiagramSnapshot): void;
  onConstructError?(error: StatementError): void;
  onZoomDone?(snapshot: DiagramSnapshot, previousWidth: number, action: 'in' | 'out' | 'reset'): void;
  onCancelled?(): void;
}

export function useVennWorker(): UseVennWorker {
  const mirror = useMemo(() => new DiagramMirror(), []);
  const [mirrorRevision, setMirrorRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [busyKind, setBusyKind] = useState<'construct' | 'zoom' | 'default' | null>(null);
  const [progress, setProgress] = useState<WorkerProgress | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const jobIdRef = useRef(0);
  const activeJobRef = useRef<Job | null>(null);
  const pendingJobRef = useRef<Job | null>(null);
  const budgetRef = useRef(detectBufferBudget());
  const callbacks = useRef<WorkerCallbacks>({});

  const handleMessage = useCallback(
    (event: MessageEvent<WorkerResponse>): void => {
      const msg = event.data;
      if (msg.type === 'progress') {
        setProgress({ label: msg.label, done: msg.done, total: msg.total, width: msg.width, height: msg.height });
        return;
      }
      // 'done'
      const job = activeJobRef.current;
      activeJobRef.current = null;
      setProgress(null);
      if (msg.ok) {
        const previousWidth = mirror.venn?.width ?? msg.snapshot.venn.width;
        mirror.applySnapshot(msg.snapshot);
        setMirrorRevision((r) => r + 1);
        if (job?.kind === 'zoom') callbacks.current.onZoomDone?.(msg.snapshot, previousWidth, job.action);
        else callbacks.current.onConstructDone?.(msg.snapshot);
      } else {
        callbacks.current.onConstructError?.(msg.error);
      }
      // Run the coalesced pending job, if any.
      const next = pendingJobRef.current;
      pendingJobRef.current = null;
      if (next !== null) {
        dispatch(next);
      } else {
        setBusy(false);
        setBusyKind(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mirror],
  );

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current === null) {
      const worker = new VennWorkerFactory();
      worker.onmessage = handleMessage;
      workerRef.current = worker;
    }
    return workerRef.current;
  }, [handleMessage]);

  const dispatch = useCallback(
    (job: Job): void => {
      const worker = ensureWorker();
      activeJobRef.current = job;
      setBusy(true);
      setBusyKind(job.kind);
      const id = ++jobIdRef.current;
      let request: WorkerRequest;
      if (job.kind === 'construct') {
        request = {
          id,
          type: 'construct',
          statement: job.statement,
          outputMode: job.outputMode,
          alphabetize: job.alphabetize,
          style: job.style,
          resetZoom: job.resetZoom,
          maxBufferPixels: budgetRef.current,
        };
      } else if (job.kind === 'zoom') {
        request = { id, type: 'zoom', action: job.action, steps: job.steps };
      } else {
        request = { id, type: 'default', style: job.style, maxBufferPixels: budgetRef.current };
      }
      worker.postMessage(request);
    },
    [ensureWorker],
  );

  /** Queue a job; while busy, the LATEST job replaces any waiting one. */
  const submit = useCallback(
    (job: Job): void => {
      if (activeJobRef.current !== null) {
        pendingJobRef.current = job;
        return;
      }
      dispatch(job);
    },
    [dispatch],
  );

  const construct = useCallback(
    (statement: string, outputMode: number, alphabetize: boolean, style: GeometryStyle, resetZoom: boolean): void => {
      submit({ kind: 'construct', statement, outputMode, alphabetize, style, resetZoom });
    },
    [submit],
  );

  const zoom = useCallback(
    (action: 'in' | 'out' | 'reset', steps = 1): void => {
      submit({ kind: 'zoom', action, steps });
    },
    [submit],
  );

  const showDefault = useCallback(
    (style: GeometryStyle): void => {
      submit({ kind: 'default', style });
    },
    [submit],
  );

  /** Kill the running job: terminate, respawn, restore engine state. */
  const cancel = useCallback((): void => {
    if (workerRef.current === null) return;
    workerRef.current.terminate();
    workerRef.current = null;
    activeJobRef.current = null;
    pendingJobRef.current = null;
    setBusy(false);
    setBusyKind(null);
    setProgress(null);
    // Restore the (respawned) worker to the last COMPLETED snapshot's state,
    // so later zoom actions redraw the same diagram without re-parsing.
    if (mirror.venn !== null && mirror.hasDiagram) {
      const worker = ensureWorker();
      const labelNames = mirror.labels.map((l) => l.text);
      const request: WorkerRequest = {
        id: ++jobIdRef.current,
        type: 'restore',
        venn: {
          width: mirror.venn.width,
          length: mirror.venn.length,
          ZOOM: mirror.venn.ZOOM,
          ZOOMFACTOR: mirror.venn.ZOOMFACTOR,
        },
        style: mirror.venn.style,
        statement: mirror.statement,
        values: mirror.values,
        labelNames,
        maxBufferPixels: budgetRef.current,
      };
      worker.postMessage(request);
    }
    callbacks.current.onCancelled?.();
  }, [ensureWorker, mirror]);

  // Terminate on unmount.
  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  return { mirror, mirrorRevision, busy, busyKind, progress, construct, zoom, showDefault, cancel, callbacks };
}
