/**
 * Right panel — the scrollable truth table (virtualized so 2^16-row tables
 * stay smooth) plus display toggles, the step-by-step computation methods
 * reactivated from the original code, a search/jump box, export buttons and
 * the evaluation status bar.
 *
 * Rendering rules are ported from `ttc/TruthTablePanel.java`:
 *   - display row i shows table row (numberOfLines - 1 - i) in T/F mode and
 *     row i in 0/1 mode (`interpretedPosition`);
 *   - gray "i)" row numbers, blue column separators after each proposition,
 *     the main connective column highlighted in red;
 *   - step-by-step evaluation: the statement part of a row paints only when
 *     `i <= currentRow` (ROW method) and `computeRow(index, currentColumn)`
 *     blanks the operator columns beyond the current one (COLUMN method) —
 *     exactly the dormant machinery of the original panel;
 *   - the optional footer prints `getColumnOrderStrings` ("^" markers and
 *     evaluation order numbers) following the current column.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { TruthTable } from '../logic/TruthTable.ts';
import { TruthValue } from '../logic/TruthValue.ts';
import type { EvaluationResult } from '../app/analyze.ts';
import { buildCSV, buildLaTeX, buildMarkdown, buildText, downloadText, interpretedPosition } from '../exports/exporters.ts';
import { LogoMark } from './LogoMark.tsx';

const ROW_HEIGHT = 26;
const OVERSCAN = 10;

/** Java MainInterface computation methods. */
export const COMPLETE_METHOD = 0;
export const ROW_METHOD = 1;
export const COLUMN_METHOD = 2;
/** Java used Integer.MAX_VALUE for "no limit". */
export const STEP_MAX = Number.MAX_SAFE_INTEGER;

export interface TableToggles {
  highlightMainColumn: boolean;
  showRowNumbers: boolean;
  alternateRowColors: boolean;
  showColumnNumbers: boolean;
}

export interface TruthTablePanelProps {
  truthTable: TruthTable | null;
  evaluation: EvaluationResult | null;
  toggles: TableToggles;
  onTogglesChange(next: TableToggles): void;
  displayMethod: number;
  onDisplayMethodChange(next: number): void;
  alphabetize: boolean;
  onAlphabetizeChange(next: boolean): void;
  exportBaseName: string;
  /** Step-by-step evaluation (reactivated ROW/COLUMN methods). */
  computationMethod: number;
  currentRow: number;
  currentColumn: number;
  onComputationMethodChange(next: number): void;
  onStep(action: 'first' | 'prev' | 'next' | 'last'): void;
  /** Region ↔ row linking (absolute table rows). */
  hoveredRow: number | null;
  selectedRow: number | null;
  onRowClick(row: number | null): void;
  /** Search / jump-to-row: selects AND scrolls (reciprocal region highlight). */
  onJumpToRow(row: number | null): void;
  scrollSignal: { row: number; nonce: number } | null;
  dark: boolean;
  /** Empty-state example chips construct instantly. */
  onExample(statement: string): void;
}

const EXAMPLES: { statement: string; hint: string }[] = [
  { statement: 'A & B', hint: 'intersection' },
  { statement: '(A | B) & ~C', hint: 'union minus a set' },
  { statement: 'A + B + C', hint: 'exclusive or' },
  { statement: '(A => B) & (C <=> D)', hint: '4 sets' },
  { statement: 'A & B & C & D & E', hint: '5 sets' },
  { statement: 'A | ~A', hint: 'tautology' },
];

/** Friendly one-line meaning for each evaluation outcome. */
const EVALUATION_SENTENCES: Record<string, string> = {
  Tautology: 'true in every row — every region fills',
  Identity: 'true in every row — every region fills',
  Contradiction: 'false in every row — nothing fills',
  Conditional: 'true in some rows — those regions fill',
};

/**
 * Row backgrounds (light/dark). The zebra stays NEUTRAL so the two
 * interaction states are unmistakable:
 *   - hovering a diagram region = warm amber row + amber edge bar,
 *   - the selected region       = blue row + blue edge bar, the same blue
 *     that spotlights the region in the diagram.
 */
const ROW_COLORS = {
  light: {
    alternate: 'rgb(248,250,252)', // slate-50
    hover: 'rgb(254,243,199)', // amber-100
    selected: 'rgb(240,229,248)', // uom-100
    hoverBar: 'inset 3px 0 0 0 rgb(245,158,11)', // amber-500
    selectedBar: 'inset 3px 0 0 0 rgb(102,0,153)', // UoM purple #660099
  },
  dark: {
    alternate: 'rgba(148,163,184,0.07)',
    hover: 'rgba(245,158,11,0.18)',
    selected: 'rgba(147,64,196,0.30)',
    hoverBar: 'inset 3px 0 0 0 rgb(245,158,11)',
    selectedBar: 'inset 3px 0 0 0 rgb(208,169,233)',
  },
} as const;

const TOOLBAR_LABEL = 'flex cursor-pointer items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300';
const EXPORT_BTN =
  'h-6 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-600 shadow-sm transition-colors hover:border-uom-300 hover:text-uom-700 focus-visible:outline-2 focus-visible:outline-uom-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:text-uom-300';

export function TruthTablePanel(props: TruthTablePanelProps): React.JSX.Element {
  const {
    truthTable,
    evaluation,
    toggles,
    onTogglesChange,
    displayMethod,
    onDisplayMethodChange,
    alphabetize,
    onAlphabetizeChange,
    exportBaseName,
    computationMethod,
    currentRow,
    currentColumn,
    onComputationMethodChange,
    onStep,
    hoveredRow,
    selectedRow,
    onRowClick,
    onJumpToRow,
    scrollSignal,
    dark,
    onExample,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [search, setSearch] = useState('');
  const [searchMiss, setSearchMiss] = useState(false);

  const colors = dark ? ROW_COLORS.dark : ROW_COLORS.light;

  const meta = useMemo(() => {
    if (truthTable === null) return null;
    const numberOfLines = truthTable.getNumberOfLines();
    return {
      numberOfLines,
      numberOfColumns: truthTable.getNumberOfColumns(),
      mainColumnPosition: truthTable.getPositionOfMainColumn(),
      propositionNames: truthTable.getPropositionNames(),
      statement: truthTable.getStatement(),
      rowNumberChars: String(numberOfLines - 1).length,
    };
  }, [truthTable]);

  // Scroll the table to a row selected by clicking its region in the diagram.
  useEffect(() => {
    if (scrollSignal === null || truthTable === null) return;
    const el = scrollRef.current;
    if (el === null) return;
    const displayIndex = interpretedPosition(truthTable, scrollSignal.row);
    const target = displayIndex * ROW_HEIGHT + ROW_HEIGHT - el.clientHeight / 2;
    el.scrollTop = Math.max(0, target);
  }, [scrollSignal, truthTable]);

  /**
   * Search: a row NUMBER jumps to that display row; a truth pattern like
   * "TFT" / "101" finds the first row whose proposition values match it as a
   * prefix. The hit is selected — which also spotlights its diagram region.
   */
  const runSearch = (): void => {
    if (truthTable === null || meta === null) return;
    const query = search.trim().toUpperCase();
    if (query.length === 0) return;
    setSearchMiss(false);
    if (/^\d+$/.test(query)) {
      const displayIndex = Number(query);
      if (displayIndex >= 0 && displayIndex < meta.numberOfLines) {
        onJumpToRow(interpretedPosition(truthTable, displayIndex));
        return;
      }
      setSearchMiss(true);
      return;
    }
    if (/^[TF10]+$/.test(query) && query.length <= meta.propositionNames.length) {
      const want = [...query].map((c) => c === 'T' || c === '1');
      for (let i = 0; i < meta.numberOfLines; i++) {
        const row = interpretedPosition(truthTable, i);
        const binary = truthTable.getBinaryFormat(row);
        let match = true;
        for (let k = 0; k < want.length; k++) {
          const isTrue = TruthValue.getTruthValueString(binary[k], TruthValue.TRUE_FALSE) === 'T';
          if (isTrue !== want[k]) {
            match = false;
            break;
          }
        }
        if (match) {
          onJumpToRow(row);
          return;
        }
      }
    }
    setSearchMiss(true);
  };

  const totalHeight = meta === null ? 0 : meta.numberOfLines * ROW_HEIGHT;
  const startRow = meta === null ? 0 : Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endRow =
    meta === null ? -1 : Math.min(meta.numberOfLines - 1, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);

  const rows: React.JSX.Element[] = [];
  if (truthTable !== null && meta !== null) {
    for (let i = startRow; i <= endRow; i++) {
      const row = interpretedPosition(truthTable, i);
      const binary = truthTable.getBinaryFormat(row);
      // Java: the statement part paints only when i <= currentRow.
      const statementRevealed = i <= currentRow;
      // Java: computeRow(index) when currentColumn == MAX, else computeRow(index, currentColumn).
      const rowString = statementRevealed
        ? currentColumn === STEP_MAX
          ? truthTable.computeRow(row)
          : truthTable.computeRow(row, currentColumn)
        : '';
      const isAlternate = toggles.alternateRowColors && i % 2 !== 0;
      const isHovered = hoveredRow === row;
      const isSelected = selectedRow === row;
      const backgroundColor = isSelected
        ? colors.selected
        : isHovered
          ? colors.hover
          : isAlternate
            ? colors.alternate
            : undefined;
      const boxShadow = isSelected ? colors.selectedBar : isHovered ? colors.hoverBar : undefined;
      rows.push(
        <div
          key={i}
          onClick={() => onRowClick(isSelected ? null : row)}
          title="Click to spotlight this row's region in the diagram"
          className={`absolute left-0 flex w-full cursor-pointer items-center whitespace-pre font-mono text-[14px] leading-none transition-colors duration-75 hover:brightness-[0.96] dark:hover:brightness-125 ${
            isSelected ? 'font-semibold' : ''
          }`}
          style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT, backgroundColor, boxShadow }}
        >
          {toggles.showRowNumbers && (
            <span
              className="shrink-0 select-none text-gray-500 dark:text-slate-500"
              style={{ width: `${meta.rowNumberChars + 2}ch` }}
            >
              {String(i).padStart(meta.rowNumberChars, ' ')}
              {')'}
            </span>
          )}
          {binary.map((b, j) => (
            <span
              key={j}
              className="shrink-0 border-r border-uom-600 text-center text-slate-900 dark:border-uom-300 dark:text-slate-100"
              style={{ width: '3ch' }}
            >
              {` ${TruthValue.getTruthValueString(b, displayMethod)} `}
            </span>
          ))}
          {statementRevealed && (
            <span className="pl-[1ch] text-slate-900 dark:text-slate-100">
              {toggles.highlightMainColumn ? (
                <>
                  <span>{rowString.slice(0, meta.mainColumnPosition)}</span>
                  <span className="rounded-[2px] bg-red-100 font-bold text-red-600 dark:bg-red-900 dark:text-red-300">
                    {rowString.charAt(meta.mainColumnPosition) || ' '}
                  </span>
                  <span>{rowString.slice(meta.mainColumnPosition + 1)}</span>
                </>
              ) : (
                rowString
              )}
            </span>
          )}
        </div>,
      );
    }
  }

  const setToggle = (key: keyof TableToggles, value: boolean): void => {
    onTogglesChange({ ...toggles, [key]: value });
  };

  const canExport = truthTable !== null;
  const stepping = computationMethod !== COMPLETE_METHOD;
  const stepLabel =
    meta === null
      ? ''
      : computationMethod === ROW_METHOD
        ? `${Math.max(0, Math.min(currentRow, meta.numberOfLines - 1) + 1)} / ${meta.numberOfLines} rows`
        : computationMethod === COLUMN_METHOD
          ? `${Math.max(0, Math.min(currentColumn, meta.numberOfColumns - 1) + 1)} / ${meta.numberOfColumns} columns`
          : '';

  const columnOrderStrings =
    truthTable !== null && toggles.showColumnNumbers ? truthTable.getColumnOrderStrings(currentColumn) : [];

  return (
    <div className="flex min-h-0 w-full flex-col border-t border-slate-200 dark:border-slate-700 lg:w-[560px] lg:border-t-0 lg:border-l">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          Truth table
        </span>
        <label className={TOOLBAR_LABEL}>
          <input
            type="checkbox"
            className="accent-uom-600"
            checked={toggles.highlightMainColumn}
            onChange={(e) => setToggle('highlightMainColumn', e.target.checked)}
          />
          Highlight main column
        </label>
        <label className={TOOLBAR_LABEL}>
          <input
            type="checkbox"
            className="accent-uom-600"
            checked={toggles.showRowNumbers}
            onChange={(e) => setToggle('showRowNumbers', e.target.checked)}
          />
          Row numbers
        </label>
        <label className={TOOLBAR_LABEL}>
          <input
            type="checkbox"
            className="accent-uom-600"
            checked={toggles.alternateRowColors}
            onChange={(e) => setToggle('alternateRowColors', e.target.checked)}
          />
          Alternate colors
        </label>
        <label className={TOOLBAR_LABEL}>
          <input
            type="checkbox"
            className="accent-uom-600"
            checked={toggles.showColumnNumbers}
            onChange={(e) => setToggle('showColumnNumbers', e.target.checked)}
          />
          Column order
        </label>
        <label className={TOOLBAR_LABEL} title="Re-constructs the table">
          <input
            type="checkbox"
            className="accent-uom-600"
            checked={alphabetize}
            onChange={(e) => onAlphabetizeChange(e.target.checked)}
          />
          Alphabetize
        </label>
        <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
          <span className="font-semibold">Values:</span>
          <div className="inline-flex items-center divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white font-mono shadow-sm dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-800">
            <button
              className={`h-6 px-2 transition-colors focus-visible:outline-2 focus-visible:outline-uom-500 ${displayMethod === TruthValue.TRUE_FALSE ? 'bg-uom-600 text-white' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-700'}`}
              onClick={() => onDisplayMethodChange(TruthValue.TRUE_FALSE)}
            >
              T/F
            </button>
            <button
              className={`h-6 px-2 transition-colors focus-visible:outline-2 focus-visible:outline-uom-500 ${displayMethod === TruthValue.ZERO_ONE ? 'bg-uom-600 text-white' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-700'}`}
              onClick={() => onDisplayMethodChange(TruthValue.ZERO_ONE)}
            >
              1/0
            </button>
          </div>
        </div>
      </div>

      {/* computation method + search + export row */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Method</span>
        <select
          className="h-6 rounded-lg border border-slate-200 bg-white px-1.5 text-xs text-slate-600 shadow-sm focus-visible:outline-2 focus-visible:outline-uom-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          value={computationMethod}
          onChange={(e) => onComputationMethodChange(Number(e.target.value))}
          disabled={!canExport}
          title="Step-by-step evaluation — reveal the table row by row or connective column by column"
        >
          <option value={COMPLETE_METHOD}>Complete</option>
          <option value={ROW_METHOD}>Step rows</option>
          <option value={COLUMN_METHOD}>Step columns</option>
        </select>
        {stepping && (
          <>
            <div className="inline-flex items-center divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-800">
              {(
                [
                  ['first', '⏮'],
                  ['prev', '◀'],
                  ['next', '▶'],
                  ['last', '⏭'],
                ] as const
              ).map(([action, glyph]) => (
                <button
                  key={action}
                  className="h-6 px-2 text-xs text-slate-600 transition-colors hover:bg-uom-50 hover:text-uom-700 focus-visible:outline-2 focus-visible:outline-uom-500 dark:text-slate-300 dark:hover:bg-slate-700"
                  onClick={() => onStep(action)}
                  title={action}
                >
                  {glyph}
                </button>
              ))}
            </div>
            <span className="inline-flex h-6 items-center rounded-lg bg-slate-100 px-1.5 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {stepLabel}
            </span>
          </>
        )}
        <input
          type="text"
          value={search}
          disabled={!canExport}
          placeholder="row # or TFT…"
          title="Jump to a row: enter a row number, or a truth pattern like TFT / 101 to find the first matching row (also spotlights its region)"
          aria-label="Search rows"
          onChange={(e) => {
            setSearch(e.target.value);
            setSearchMiss(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
          }}
          className={`h-6 w-28 rounded-lg border px-2 font-mono text-[11px] shadow-sm outline-none transition-colors focus:ring-2 disabled:opacity-40 ${
            searchMiss
              ? 'border-rose-400 bg-rose-50 text-rose-700 focus:ring-rose-200 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300'
              : 'border-slate-200 bg-white text-slate-700 focus:border-uom-300 focus:ring-uom-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
          }`}
        />
        <span className="ms-2 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          Export
        </span>
        <button
          className={EXPORT_BTN}
          disabled={!canExport}
          onClick={() => truthTable !== null && downloadText(buildCSV(truthTable), `${exportBaseName}.csv`, 'text/csv')}
        >
          CSV
        </button>
        <button
          className={EXPORT_BTN}
          disabled={!canExport}
          onClick={() =>
            truthTable !== null && downloadText(buildMarkdown(truthTable), `${exportBaseName}.md`, 'text/markdown')
          }
        >
          Markdown
        </button>
        <button
          className={EXPORT_BTN}
          disabled={!canExport}
          title="LaTeX tabular markup — paste straight into a paper or report"
          onClick={() =>
            truthTable !== null && downloadText(buildLaTeX(truthTable), `${exportBaseName}.tex`, 'application/x-tex')
          }
        >
          LaTeX
        </button>
        <button
          className={EXPORT_BTN}
          disabled={!canExport}
          title="Byte-exact format of the original application's text export"
          onClick={() =>
            truthTable !== null &&
            downloadText(
              buildText(truthTable, {
                highlightMainColumn: toggles.highlightMainColumn,
                showRowNumbers: toggles.showRowNumbers,
                showColumnNumbers: toggles.showColumnNumbers,
              }),
              `${exportBaseName}.txt`,
              'text/plain',
            )
          }
        >
          TXT
        </button>
        {meta !== null && (
          <span className="ms-auto font-mono text-[11px] text-slate-400 dark:text-slate-500">
            {meta.numberOfLines} rows · {meta.propositionNames.length} proposition
            {meta.propositionNames.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* table body */}
      <div
        ref={scrollRef}
        className="thin-scrollbar relative min-h-0 flex-1 overflow-auto bg-white dark:bg-slate-900"
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          setViewportH(e.currentTarget.clientHeight);
        }}
      >
        {truthTable === null || meta === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <LogoMark className="h-24 w-28 opacity-90" />
            <div>
              <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">
                Type a logical statement and press Construct
              </p>
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                Every true row of the truth table fills its region in the diagram — for any number of sets.
              </p>
            </div>
            <div className="flex max-w-md flex-wrap items-center justify-center gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example.statement}
                  onClick={() => onExample(example.statement)}
                  title={example.hint}
                  className="rounded-full border border-uom-200 bg-uom-50 px-3 py-1 font-mono text-xs text-uom-800 hover:border-uom-400 hover:bg-uom-100 active:translate-y-px dark:border-uom-900 dark:bg-uom-950 dark:text-uom-300 dark:hover:border-uom-700"
                >
                  {example.statement}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 dark:text-slate-500">
              Shortcuts: <kbd className="rounded border border-slate-300 bg-white px-1 dark:border-slate-600 dark:bg-slate-800">+</kbd> /{' '}
              <kbd className="rounded border border-slate-300 bg-white px-1 dark:border-slate-600 dark:bg-slate-800">−</kbd> zoom ·{' '}
              <kbd className="rounded border border-slate-300 bg-white px-1 dark:border-slate-600 dark:bg-slate-800">0</kbd> fit ·{' '}
              <kbd className="rounded border border-slate-300 bg-white px-1 dark:border-slate-600 dark:bg-slate-800">L</kbd> labels ·{' '}
              <kbd className="rounded border border-slate-300 bg-white px-1 dark:border-slate-600 dark:bg-slate-800">D</kbd> theme
            </p>
          </div>
        ) : (
          <div className="inline-block min-w-full px-2 pb-4">
            {/* header */}
            <div className="sticky top-0 z-10 border-b-2 border-uom-600 bg-white pt-2 dark:border-uom-300 dark:bg-slate-900">
              <div
                className="flex items-center whitespace-pre font-mono text-[14px] font-bold leading-none text-slate-900 dark:text-slate-100"
                style={{ height: ROW_HEIGHT }}
              >
                {toggles.showRowNumbers && (
                  <span className="shrink-0" style={{ width: `${meta.rowNumberChars + 2}ch` }} />
                )}
                {meta.propositionNames.map((name) => (
                  <span
                    key={name}
                    className="shrink-0 border-r border-uom-600 text-center dark:border-uom-300"
                    style={{ width: '3ch' }}
                  >
                    {` ${name} `}
                  </span>
                ))}
                <span className="pl-[1ch]">{meta.statement}</span>
              </div>
            </div>
            {/* virtualized rows */}
            <div className="relative" style={{ height: totalHeight }}>
              {rows}
            </div>
            {/* column order footer */}
            {toggles.showColumnNumbers && (
              <div className="mt-1 border-t border-slate-200 pt-1 text-gray-500 dark:border-slate-700 dark:text-slate-400">
                {columnOrderStrings.map((line, k) => (
                  <div key={k} className="flex whitespace-pre font-mono text-[14px] leading-tight">
                    {toggles.showRowNumbers && (
                      <span className="shrink-0" style={{ width: `${meta.rowNumberChars + 2}ch` }} />
                    )}
                    <span className="shrink-0" style={{ width: `${meta.propositionNames.length * 3}ch` }} />
                    <span className="pl-[1ch]">{line}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* status bar — mirrors MainInterface's status panel */}
      <div className="flex items-center gap-2 border-t border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Evaluation
        </span>
        {evaluation !== null ? (
          <>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${
                evaluation.evaluationName === 'Tautology' || evaluation.evaluationName === 'Identity'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                  : evaluation.evaluationName === 'Contradiction'
                    ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300'
                    : 'border-uom-200 bg-uom-50 text-uom-700 dark:border-uom-800 dark:bg-uom-950 dark:text-uom-300'
              }`}
            >
              {evaluation.evaluationName}
            </span>
            <span className="hidden text-xs text-slate-500 md:inline dark:text-slate-400">
              {EVALUATION_SENTENCES[evaluation.evaluationName] ?? ''}
            </span>
            <span className="ms-auto font-mono text-xs text-slate-400 dark:text-slate-500">{evaluation.statsText}</span>
          </>
        ) : (
          <span className="text-slate-400 dark:text-slate-600">—</span>
        )}
      </div>
    </div>
  );
}
