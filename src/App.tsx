/**
 * Application shell — the web equivalent of `MainInterface`'s frame:
 * formula bar on top, interactive diagram viewport on the left, the truth
 * table with its display options, step-by-step computation methods and
 * evaluation status on the right.
 *
 * Architecture: the LOGIC pipeline (scanner → parser → truth table →
 * evaluation) runs on the main thread — the table appears instantly — while
 * ALL geometry (construction, auto-zoom, flood fills, region map) runs in a
 * Web Worker with progress + cancellation, mirrored back for rendering.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormulaBar, MAX_QUEUE_LENGTH } from './components/FormulaBar.tsx';
import { VennCanvas } from './components/VennCanvas.tsx';
import {
  TruthTablePanel,
  COMPLETE_METHOD,
  ROW_METHOD,
  COLUMN_METHOD,
  STEP_MAX,
  type TableToggles,
} from './components/TruthTablePanel.tsx';
import { HelpModal } from './components/HelpModal.tsx';
import { analyzeStatement, type AnalysisSuccess, type StatementError } from './app/analyze.ts';
import type { GeometryStyle } from './geometry/VennsConstruction.ts';
import { Scanner } from './logic/Scanner.ts';
import { Parser } from './logic/Parser.ts';
import { ScannerException, ParserException } from './logic/exceptions.ts';
import { TruthValue } from './logic/TruthValue.ts';
import { parseShareHash, loadPersisted, savePersisted } from './app/share.ts';
import { useVennWorker } from './hooks/useVennWorker.ts';
import { useTheme } from './hooks/useTheme.ts';
import { useShareLink } from './hooks/useShareLink.ts';
import { LogoMark } from './components/LogoMark.tsx';
import type { ViewMode } from './renderer/overlays.ts';

const persisted = typeof window !== 'undefined' ? loadPersisted() : null;

export default function App(): React.JSX.Element {
  const worker = useVennWorker();
  const { mirror, mirrorRevision, busy, busyKind, progress } = worker;

  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>(persisted?.history ?? []);
  const [analysis, setAnalysis] = useState<AnalysisSuccess | null>(null);
  const [constructError, setConstructError] = useState<StatementError | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [displayMethod, setDisplayMethod] = useState<number>(persisted?.displayMethod ?? TruthValue.TRUE_FALSE);
  const [alphabetize, setAlphabetize] = useState(persisted?.alphabetize ?? false);
  const [toggles, setToggles] = useState<TableToggles>({
    highlightMainColumn: persisted?.highlightMainColumn ?? true, // Java default: checked
    showRowNumbers: persisted?.showRowNumbers ?? true, // Java default: checked
    alternateRowColors: persisted?.alternateRowColors ?? true, // Java default: checked
    showColumnNumbers: persisted?.showColumnNumbers ?? false, // never enabled by the original frame
  });
  const [showLabels, setShowLabels] = useState(persisted?.showLabels ?? true); // thesis §5.2
  const [constructCount, setConstructCount] = useState(0); // fit-view signal
  const [geometryStyle, setGeometryStyle] = useState<GeometryStyle>(persisted?.style ?? 'circular');
  // Legacy persisted 'heat' (a removed mode) falls back to 'fills'.
  const [viewMode, setViewMode] = useState<ViewMode>(persisted?.viewMode === 'sets' ? 'sets' : 'fills');
  const [zoomSignal, setZoomSignal] = useState<{ action: 'in' | 'out' | 'reset'; nonce: number } | null>(null);
  const [zoomDoneSignal, setZoomDoneSignal] = useState<{ factor: number; nonce: number } | null>(null);
  const { theme, toggleTheme } = useTheme(persisted?.theme);

  // Step-by-step evaluation (Java MainInterface.setComputationMethod).
  const [computationMethod, setComputationMethod] = useState(COMPLETE_METHOD);
  const [currentRow, setCurrentRow] = useState(STEP_MAX);
  const [currentColumn, setCurrentColumn] = useState(STEP_MAX);

  // Region ↔ row linking.
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [scrollSignal, setScrollSignal] = useState<{ row: number; nonce: number } | null>(null);

  /** Real-time (as-you-type) syntax feedback via the ported Scanner/Parser. */
  const liveError = useMemo<StatementError | null>(() => {
    const trimmed = input.trim();
    if (trimmed.length === 0) return null;
    const scanner = new Scanner(trimmed);
    try {
      scanner.tokenize();
    } catch (e) {
      if (e instanceof ScannerException) {
        return {
          message: e.getMessage(),
          selectionStart: e.getXValue() - 1,
          selectionEnd: e.getYValue(),
          selectAll: false,
        };
      }
      throw e;
    }
    const parser = new Parser(scanner.getTokenStream());
    try {
      parser.parse();
    } catch (e) {
      if (e instanceof ParserException) {
        scanner.reformat();
        const sameShape = scanner.getStatement() === trimmed;
        return {
          message: e.getMessage(),
          selectionStart: sameShape && !e.selectAll() ? e.getXValue() - 1 : 0,
          selectionEnd: sameShape && !e.selectAll() ? e.getXValue() : 0,
          selectAll: e.selectAll(),
        };
      }
      throw e;
    }
    return null;
  }, [input]);

  /** QueueComboBox.addItem parity: move-to-front, dedupe, cap at 25. */
  const pushHistory = useCallback((statement: string): void => {
    setHistory((prev) => {
      const next = [statement, ...prev.filter((s) => s !== statement)];
      if (next.length > MAX_QUEUE_LENGTH) next.length = MAX_QUEUE_LENGTH;
      return next;
    });
  }, []);

  /** Java setComputationMethod defaults for the active method. */
  const resetStepping = useCallback((method: number): void => {
    if (method === ROW_METHOD) {
      setCurrentRow(-1);
      setCurrentColumn(STEP_MAX);
    } else if (method === COLUMN_METHOD) {
      setCurrentColumn(-1);
      setCurrentRow(STEP_MAX);
    } else {
      setCurrentRow(STEP_MAX);
      setCurrentColumn(STEP_MAX);
    }
  }, []);

  /**
   * Construct: analyze on the main thread (instant table + errors), then let
   * the worker draw. The truth table renders BEFORE the diagram finishes.
   */
  const construct = useCallback(
    (
      statement: string,
      updateFields = true,
      overrides?: { displayMethod?: number; alphabetize?: boolean; style?: GeometryStyle },
    ): void => {
      setConstructError(null);
      const mode = overrides?.displayMethod ?? displayMethod;
      const alpha = overrides?.alphabetize ?? alphabetize;
      const style = overrides?.style ?? geometryStyle;
      const outcome = analyzeStatement(statement, mode, alpha);
      if (!outcome.ok) {
        setConstructError(outcome.error);
        return;
      }
      setAnalysis(outcome);
      setSelectedRow(null);
      setHoveredRow(null);
      setScrollSignal(null);
      resetStepping(computationMethod);
      if (updateFields) {
        setInput(outcome.statement); // Java: statementComboBox.setText(scanner.getStatement())
        pushHistory(outcome.statement); // Java: statementComboBox.addItem(...)
      }
      // Each construct starts from the default zoom (each style then
      // auto-zooms to its own optimum) — pixel-identical to a fresh construct.
      worker.construct(outcome.statement, mode, alpha, style, true);
    },
    [displayMethod, alphabetize, geometryStyle, pushHistory, computationMethod, resetStepping, worker],
  );

  // Worker outcome callbacks.
  useEffect(() => {
    worker.callbacks.current = {
      onConstructDone: () => {
        setConstructCount((c) => c + 1); // re-fit the diagram view
      },
      onConstructError: (error) => {
        setConstructError(error);
      },
      onZoomDone: (snapshot, previousWidth, action) => {
        if (action === 'reset') {
          // Reset re-fits the view from scratch — no scale compensation, and
          // no re-crisp follow-up (fit lands at scale ≤ 1 by construction).
          setConstructCount((c) => c + 1);
          return;
        }
        const factor = snapshot.venn.width / previousWidth;
        if (factor !== 1) {
          setZoomDoneSignal((prev) => ({ factor, nonce: (prev?.nonce ?? 0) + 1 }));
        }
      },
    };
  }, [worker.callbacks]);

  // Boot: open a shared link (reconstructs its diagram), else show the
  // original application's default 3-set frame.
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    const shared = parseShareHash(window.location.hash);
    if (shared !== null) {
      setDisplayMethod(shared.displayMethod);
      setAlphabetize(shared.alphabetize);
      setShowLabels(shared.showLabels);
      setGeometryStyle(shared.style);
      setInput(shared.statement);
      construct(shared.statement, true, {
        displayMethod: shared.displayMethod,
        alphabetize: shared.alphabetize,
        style: shared.style,
      });
    } else {
      worker.showDefault(geometryStyle);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the URL hash shareable and persist settings.
  const shareState = useMemo(
    () =>
      analysis !== null
        ? { statement: analysis.statement, displayMethod, alphabetize, showLabels, style: geometryStyle }
        : null,
    [analysis, displayMethod, alphabetize, showLabels, geometryStyle],
  );
  const { linkCopied, copyShareLink } = useShareLink(shareState);

  useEffect(() => {
    savePersisted({
      history,
      displayMethod,
      alphabetize,
      showLabels,
      highlightMainColumn: toggles.highlightMainColumn,
      showRowNumbers: toggles.showRowNumbers,
      alternateRowColors: toggles.alternateRowColors,
      showColumnNumbers: toggles.showColumnNumbers,
      style: geometryStyle,
      theme,
      viewMode,
    });
  }, [history, displayMethod, alphabetize, showLabels, toggles, geometryStyle, theme, viewMode]);

  /**
   * Java TrueFalse/ZeroOne menu listeners: switch mode and re-analyze.
   * The FILLS are unchanged (the port treats 'T' and '1' alike), so only the
   * table re-renders — no geometry round-trip.
   */
  const changeDisplayMethod = (next: number): void => {
    setDisplayMethod(next);
    if (analysis !== null) {
      const outcome = analyzeStatement(analysis.statement, next, alphabetize);
      if (outcome.ok) setAnalysis(outcome);
    }
  };

  /** Alphabetize changes proposition ORDER → regions re-bind: full re-construct. */
  const changeAlphabetize = (next: boolean): void => {
    setAlphabetize(next);
    if (analysis !== null) {
      const outcome = analyzeStatement(analysis.statement, displayMethod, next);
      if (outcome.ok) {
        setAnalysis(outcome);
        setSelectedRow(null);
        worker.construct(outcome.statement, displayMethod, next, geometryStyle, true);
      }
    }
  };

  const changeStyle = (next: GeometryStyle): void => {
    if (next === geometryStyle) return;
    setGeometryStyle(next);
    if (analysis !== null) {
      // Style switch starts from the default zoom and re-constructs — the
      // result is pixel-identical to a fresh construct in the target style.
      setSelectedRow(null);
      worker.construct(analysis.statement, displayMethod, alphabetize, next, true);
    } else {
      worker.showDefault(next);
    }
  };

  // Keyboard shortcuts: + / − zoom, 0 fit & reset, L labels, D theme.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') {
        setZoomSignal((prev) => ({ action: 'in', nonce: (prev?.nonce ?? 0) + 1 }));
      } else if (e.key === '-' || e.key === '_') {
        setZoomSignal((prev) => ({ action: 'out', nonce: (prev?.nonce ?? 0) + 1 }));
      } else if (e.key === '0') {
        setZoomSignal((prev) => ({ action: 'reset', nonce: (prev?.nonce ?? 0) + 1 }));
      } else if (e.key === 'l' || e.key === 'L') {
        setShowLabels((v) => !v);
      } else if (e.key === 'd' || e.key === 'D') {
        toggleTheme();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleTheme]);

  const changeComputationMethod = (method: number): void => {
    setComputationMethod(method);
    resetStepping(method);
  };

  const step = (action: 'first' | 'prev' | 'next' | 'last'): void => {
    if (analysis === null) return;
    if (computationMethod === ROW_METHOD) {
      const last = analysis.truthTable.getNumberOfLines() - 1;
      setCurrentRow((cur) => {
        const c = cur === STEP_MAX ? -1 : cur;
        if (action === 'first') return 0;
        if (action === 'prev') return Math.max(-1, c - 1);
        if (action === 'next') return Math.min(last, c + 1);
        return last;
      });
    } else if (computationMethod === COLUMN_METHOD) {
      const last = analysis.truthTable.getNumberOfColumns() - 1;
      setCurrentColumn((cur) => {
        const c = cur === STEP_MAX ? -1 : cur;
        if (action === 'first') return 0;
        if (action === 'prev') return Math.max(-1, c - 1);
        if (action === 'next') return Math.min(last, c + 1);
        return last;
      });
    }
  };

  const clear = (): void => {
    setInput('');
    setConstructError(null);
  };

  const selectRowAndScroll = useCallback((row: number | null): void => {
    setSelectedRow(row);
    if (row !== null) {
      setScrollSignal((prev) => ({ row, nonce: (prev?.nonce ?? 0) + 1 }));
    }
  }, []);

  const exportBaseName = useMemo(() => {
    const base = (analysis?.statement ?? 'venn-diagram')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    return base.length > 0 ? `venn-${base}`.slice(0, 60) : 'venn-diagram';
  }, [analysis]);

  const headerButton =
    'rounded-lg border border-white/20 px-3 py-1 text-sm font-semibold text-slate-100 transition-colors hover:border-white/40 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-uom-400 disabled:opacity-40';

  return (
    <div className="flex h-full flex-col bg-[#f5f2f9] text-slate-900 dark:bg-[#120b1a] dark:text-slate-100">
      {/* header — University of Manchester palette: purple #660099, gold #FFCC33 */}
      <header className="relative flex items-center gap-3.5 overflow-hidden border-b border-uom-950 bg-gradient-to-r from-[#2c0743] via-[#4b0a70] to-[#660099] px-4 py-2.5 text-white">
        {/* ambient glow accents */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-24 -top-24 h-56 w-56 rounded-full opacity-30 blur-3xl"
          style={{ background: 'radial-gradient(closest-side, #b06be0, transparent)' }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-28 h-64 w-64 rounded-full opacity-[0.18] blur-3xl"
          style={{ background: 'radial-gradient(closest-side, #ffcc33, transparent)' }}
        />
        <div
          className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white p-1 shadow-lg ring-1 ring-white/40"
          title="John Venn's construction for 7 sets — drawn by this application's own engine"
        >
          <LogoMark className="h-9 w-9" />
        </div>
        <div className="relative min-w-0">
          <p className="truncate text-[10px] font-bold uppercase tracking-[0.22em] text-uomgold-500">
            University of Manchester · School of Computer Science
          </p>
          <h1 className="truncate font-serif text-[16px] font-bold leading-tight tracking-tight">
            Drawing Venn Diagrams for Arbitrary N-Sets
          </h1>
          <p className="truncate text-[11px] leading-tight text-uom-200/90">
            by <span className="font-semibold text-uomgold-300">Murad Rzazade</span>
            <span className="mx-1.5 text-uom-300/60">—</span>
            type a logical statement, get its truth table and Venn diagram for any number of sets
          </p>
        </div>
        <div className="relative ms-auto flex items-center gap-2">
          <button
            onClick={toggleTheme}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode (D)`}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            className={headerButton}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button
            onClick={copyShareLink}
            disabled={analysis === null}
            title="Copy a link that reproduces this diagram"
            className={headerButton}
          >
            {linkCopied ? 'Copied ✓' : 'Share'}
          </button>
          <button onClick={() => setHelpOpen(true)} className={headerButton}>
            Help
          </button>
        </div>
      </header>

      <FormulaBar
        value={input}
        onChange={(v) => {
          setInput(v);
          setConstructError(null);
        }}
        onConstruct={(s) => construct(s)}
        onClear={clear}
        history={history}
        liveError={liveError}
        constructError={constructError}
        busy={busy}
        onCancel={worker.cancel}
      />

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <VennCanvas
          mirror={mirror}
          revision={mirrorRevision}
          theme={theme}
          busy={busy}
          busyKind={busyKind}
          progress={progress}
          onCancel={worker.cancel}
          canExport={analysis !== null && mirror.hasDiagram}
          exportBaseName={exportBaseName}
          showLabels={showLabels}
          onShowLabelsChange={setShowLabels}
          fitSignal={constructCount}
          selectedRow={selectedRow}
          onHoverRow={setHoveredRow}
          onSelectRow={selectRowAndScroll}
          geometryStyle={geometryStyle}
          onStyleChange={changeStyle}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          zoomSignal={zoomSignal}
          onRequestBufferZoom={worker.zoom}
          zoomDoneSignal={zoomDoneSignal}
          truthTable={analysis?.truthTable ?? null}
        />
        <TruthTablePanel
          truthTable={analysis?.truthTable ?? null}
          evaluation={analysis?.evaluation ?? null}
          toggles={toggles}
          onTogglesChange={setToggles}
          displayMethod={displayMethod}
          onDisplayMethodChange={changeDisplayMethod}
          alphabetize={alphabetize}
          onAlphabetizeChange={changeAlphabetize}
          exportBaseName={exportBaseName}
          computationMethod={computationMethod}
          currentRow={currentRow}
          currentColumn={currentColumn}
          onComputationMethodChange={changeComputationMethod}
          onStep={step}
          hoveredRow={hoveredRow}
          selectedRow={selectedRow}
          onRowClick={setSelectedRow}
          onJumpToRow={selectRowAndScroll}
          scrollSignal={scrollSignal}
          dark={theme === 'dark'}
          onExample={(s) => {
            setInput(s);
            construct(s);
          }}
        />
      </main>

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
