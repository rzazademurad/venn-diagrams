/**
 * The geometry worker: a full `MainInterface` living OFF the main thread.
 *
 * Every heavy operation — construction, auto-zoom, flood fills, the region
 * map — runs here, so the page stays responsive (pan, hover, typing) during
 * even the largest diagrams, and a runaway construct can be CANCELLED by
 * terminating this worker (the app respawns it and restores the zoom state
 * with the `restore` message, no re-parse needed).
 *
 * The visible diagram changes EXACTLY ONCE per job: nothing is streamed to
 * the canvas mid-construct — the sheet keeps the previous diagram until the
 * finished snapshot swaps in. Progress milestones (with the live working
 * buffer size) stream back as lightweight `progress` messages so the UI can
 * narrate what is happening without any visual churn.
 */

import { MainInterface } from '../app/MainInterface.ts';
import { TruthValue } from '../logic/TruthValue.ts';
import { buildSnapshot, type WorkerRequest, type WorkerResponse } from '../app/snapshot.ts';

const app = new MainInterface(TruthValue.TRUE_FALSE);
let lastProgressPost = 0;

const post = (message: WorkerResponse, transfers?: Transferable[]): void => {
  (postMessage as (message: WorkerResponse, transfer?: Transferable[]) => void)(
    message,
    transfers ?? [],
  );
};

app.onProgress = (label, done, total) => {
  if (label === 'drawn') return; // milestone only — nothing is streamed
  const now = Date.now();
  if (now - lastProgressPost < 80 && done !== total) return; // throttle
  lastProgressPost = now;
  post({
    type: 'progress',
    label,
    done,
    total,
    // Live working-buffer size: during an auto-zoom ladder the UI narrates
    // the growing size in the progress pill (the canvas stays untouched).
    width: app.venn.buffer.width,
    height: app.venn.buffer.height,
  });
};

function postDone(id: number, autoZoomSteps: number): void {
  const { snapshot, transfers } = buildSnapshot(app, autoZoomSteps);
  post({ id, type: 'done', ok: true, snapshot }, transfers);
  // The raster's ArrayBuffer is detached after the transfer — re-arm the
  // engine with a fresh (blank) buffer of the same size so the next job can
  // draw into it. The zoom state and values are untouched.
  app.venn.update(false);
}

let lastAutoZoomSteps = 0;

onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'construct': {
        app.venn.maxBufferPixels = msg.maxBufferPixels;
        app.outputMode = msg.outputMode;
        app.alphabetizePropositions = msg.alphabetize;
        app.venn.style = msg.style;
        if (msg.resetZoom) app.venn.reset(false);
        const outcome = app.processCommand(msg.statement);
        if (!outcome.ok) {
          post({ id: msg.id, type: 'done', ok: false, error: outcome.error });
          return;
        }
        lastAutoZoomSteps = outcome.autoZoomSteps;
        postDone(msg.id, outcome.autoZoomSteps);
        break;
      }
      case 'zoom': {
        // Apply the WHOLE ladder in one job (steps computed by the UI's
        // simulation), then draw + fill exactly once — a single buffer swap
        // per settle instead of a construct-flash per step.
        const steps = Math.max(1, Math.min(64, msg.steps));
        const hasDiagram = app.lastValues.length > 0;
        for (let i = 0; i < steps; i++) {
          if (msg.action === 'in') {
            if (!app.venn.canZoomIn()) break;
            app.venn.zoomin(false);
          } else if (msg.action === 'out') {
            const widthBefore = app.venn.width;
            app.venn.zoomout(false);
            if (app.venn.width === widthBefore) break; // at/below default
          } else {
            app.venn.reset(false);
            break;
          }
        }
        if (hasDiagram) app.redraw();
        else app.venn.update(); // redraw the default frame at the new size
        postDone(msg.id, lastAutoZoomSteps);
        break;
      }
      case 'default': {
        // The original application's startup view: the blank 3-set diagram.
        app.venn.maxBufferPixels = msg.maxBufferPixels;
        app.venn.style = msg.style;
        app.truthTable = null;
        app.lastStatement = '';
        app.lastValues = '';
        app.labelNames = [];
        app.lastLabels = [];
        app.regionMap = null;
        app.seedForRow = [];
        app.venn.reset(false);
        app.venn.update(); // draws the default 3-set frame
        lastAutoZoomSteps = 0;
        postDone(msg.id, 0);
        break;
      }
      case 'restore': {
        // After a cancel (worker respawn): restore the zoom state + values so
        // subsequent zoom actions redraw the same diagram without re-parsing.
        app.venn.maxBufferPixels = msg.maxBufferPixels;
        app.venn.style = msg.style;
        app.venn.width = msg.venn.width;
        app.venn.length = msg.venn.length;
        app.venn.ZOOM = msg.venn.ZOOM;
        app.venn.ZOOMFACTOR = msg.venn.ZOOMFACTOR;
        app.lastStatement = msg.statement;
        app.lastValues = msg.values;
        app.labelNames = msg.labelNames;
        app.venn.update(false); // size the buffer; nothing is drawn yet
        break;
      }
    }
  } catch (err) {
    const id = 'id' in msg ? msg.id : -1;
    post({
      id,
      type: 'done',
      ok: false,
      error: {
        message: err instanceof Error ? err.message : String(err),
        selectionStart: 0,
        selectionEnd: 0,
        selectAll: false,
      },
    });
  }
};
