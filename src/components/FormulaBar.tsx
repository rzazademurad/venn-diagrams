/**
 * Top formula bar: statement input with history dropdown (QueueComboBox
 * semantics: 25-entry queue, most-recent-first, whitespace/case-insensitive
 * prefix suggestions), quick-insert symbol buttons, Construct / Cancel /
 * Clear actions and a real-time syntax banner pinpointing exact character
 * positions.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { StatementError } from '../app/analyze.ts';

export const MAX_STATEMENT_LENGTH = 256;
export const MAX_QUEUE_LENGTH = 25; // QueueComboBox(…, 25) in MainInterface

interface SymbolButton {
  label: string;
  insert: string;
  title: string;
}

const SYMBOL_BUTTONS: SymbolButton[] = [
  { label: '¬', insert: '~', title: 'Negation  ~ or !' },
  { label: '∧', insert: '&', title: 'Conjunction (AND)  & or ^' },
  { label: '∨', insert: '|', title: 'Inclusive disjunction (OR)  |' },
  { label: '⊕', insert: '+', title: 'Exclusive disjunction (XOR)  +' },
  { label: '→', insert: '=>', title: 'Implication  => or ->' },
  { label: '↔', insert: '<=>', title: 'Bi-implication  <=> or <->' },
  { label: '(', insert: '(', title: 'Open parenthesis' },
  { label: ')', insert: ')', title: 'Close parenthesis' },
];

export interface FormulaBarProps {
  value: string;
  onChange(next: string): void;
  onConstruct(statement: string): void;
  onClear(): void;
  history: string[];
  liveError: StatementError | null;
  /** Error from the last explicit Construct — takes priority in the banner. */
  constructError: StatementError | null;
  busy: boolean;
  /** Cancels the in-flight construction (worker terminate + respawn). */
  onCancel(): void;
}

/** QueueComboBox.getMatchingItems: prefix match ignoring whitespace + case. */
function getMatchingItems(queue: string[], match: string): string[] {
  const list: string[] = [];
  if (match.length === 0) return list;
  const needle = match.toLowerCase().replace(/\s/g, '');
  for (const currentText of queue) {
    const currentLowerCase = currentText.toLowerCase().replace(/\s/g, '');
    if (currentLowerCase.startsWith(needle) && currentLowerCase !== needle) {
      list.push(currentText);
    }
  }
  return list;
}

export function FormulaBar(props: FormulaBarProps): React.JSX.Element {
  const { value, onChange, onConstruct, onClear, history, liveError, constructError, busy, onCancel } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [suggestionsMode, setSuggestionsMode] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const suggestions = useMemo(
    () => (suggestionsMode ? getMatchingItems(history, value) : history),
    [history, value, suggestionsMode],
  );

  const error = constructError ?? liveError;

  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent): void => {
      if (containerRef.current !== null && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, []);

  // Mirror Java's statementComboBox.select(...) after a construct error.
  useEffect(() => {
    if (constructError !== null && inputRef.current !== null) {
      inputRef.current.focus();
      try {
        inputRef.current.setSelectionRange(
          Math.max(0, constructError.selectionStart),
          Math.max(constructError.selectionStart, constructError.selectionEnd),
        );
      } catch {
        /* ignore */
      }
    }
  }, [constructError]);

  const insertAtCaret = (text: string): void => {
    const input = inputRef.current;
    if (input === null) {
      onChange((value + text).slice(0, MAX_STATEMENT_LENGTH));
      return;
    }
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    const next = (value.slice(0, start) + text + value.slice(end)).slice(0, MAX_STATEMENT_LENGTH);
    onChange(next);
    requestAnimationFrame(() => {
      input.focus();
      const caret = Math.min(start + text.length, next.length);
      input.setSelectionRange(caret, caret);
    });
  };

  const pickSuggestion = (statement: string): void => {
    onChange(statement);
    setDropdownOpen(false);
    setSuggestionsMode(false);
    onConstruct(statement);
  };

  /** Renders the statement with the offending character range highlighted. */
  const errorHighlight = useMemo(() => {
    if (error === null || value.length === 0) return null;
    const from = Math.max(0, Math.min(error.selectionStart, value.length));
    const to = Math.max(from, Math.min(error.selectionEnd, value.length));
    if (error.selectAll || to <= from) return null;
    return (
      <span className="font-mono whitespace-pre">
        <span className="text-red-900/60 dark:text-red-200/60">{value.slice(0, from)}</span>
        <span className="bg-red-200 text-red-900 rounded-[2px] font-bold dark:bg-red-800 dark:text-red-100">
          {value.slice(from, to)}
        </span>
        <span className="text-red-900/60 dark:text-red-200/60">{value.slice(to)}</span>
      </span>
    );
  }, [error, value]);

  return (
    <div
      className="border-b border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-900"
      ref={containerRef}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="statement" className="hidden text-sm font-semibold text-slate-600 dark:text-slate-300 sm:block">
          Statement:
        </label>
        {/* Mobile: the input takes its own full-width row; controls wrap below. */}
        <div className="relative min-w-0 basis-full sm:min-w-64 sm:flex-1 sm:basis-auto">
          <input
            id="statement"
            ref={inputRef}
            type="text"
            spellCheck={false}
            autoComplete="off"
            maxLength={MAX_STATEMENT_LENGTH}
            value={value}
            placeholder="e.g.  (A & B) => C | ~D"
            aria-invalid={error !== null}
            aria-describedby={error !== null ? 'statement-error' : undefined}
            onChange={(e) => {
              onChange(e.target.value);
              setSuggestionsMode(true);
              setDropdownOpen(getMatchingItems(history, e.target.value).length > 0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setDropdownOpen(false);
                onConstruct(value);
              } else if (e.key === 'Escape') {
                setDropdownOpen(false);
                inputRef.current?.select();
              }
            }}
            className={`w-full rounded-lg border px-3 py-1.5 font-mono text-base shadow-sm outline-none transition sm:text-[15px]
              ${
                error !== null
                  ? 'border-red-400 bg-red-50 focus:ring-2 focus:ring-red-300 dark:border-red-700 dark:bg-red-950 dark:text-red-100'
                  : 'border-slate-200 bg-white focus:border-uom-300 focus:ring-2 focus:ring-uom-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:focus:border-uom-600 dark:focus:ring-uom-900'
              }`}
          />
          {history.length > 0 && (
            <button
              type="button"
              title="Statement history"
              aria-label="Statement history"
              onClick={() => {
                setSuggestionsMode(false);
                setDropdownOpen((v) => !v);
              }}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
            >
              ▾
            </button>
          )}
          {dropdownOpen && suggestions.length > 0 && (
            <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 font-mono text-sm shadow-lg dark:border-slate-700 dark:bg-slate-800">
              {suggestions.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    className="block w-full px-3 py-1 text-left hover:bg-amber-100 dark:text-slate-200 dark:hover:bg-slate-700"
                    onClick={() => pickSuggestion(s)}
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="inline-flex max-w-full items-center divide-x divide-slate-200 overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-800">
          {SYMBOL_BUTTONS.map((b) => (
            <button
              key={b.label}
              type="button"
              title={b.title}
              onClick={() => insertAtCaret(b.insert)}
              className="h-9 w-9 shrink-0 font-mono text-[15px] text-slate-600 transition-colors hover:bg-uom-50 hover:text-uom-700 focus-visible:outline-2 focus-visible:outline-uom-500 active:bg-uom-100 sm:h-8 sm:w-8 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-uom-300"
            >
              {b.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            setDropdownOpen(false);
            onConstruct(value);
          }}
          disabled={busy}
          title="Construct truth table (Enter)"
          className="flex-1 rounded-lg bg-gradient-to-b from-uom-500 to-uom-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-uom-400 hover:to-uom-500 focus-visible:outline-2 focus-visible:outline-uom-500 active:translate-y-px disabled:opacity-50 sm:flex-none sm:py-1.5"
        >
          {busy ? 'Constructing…' : 'Construct'}
        </button>
        {busy && (
          <button
            type="button"
            onClick={onCancel}
            title="Cancel the running construction (keeps the previous diagram)"
            className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm font-semibold text-rose-700 shadow-sm transition-colors hover:bg-rose-100 focus-visible:outline-2 focus-visible:outline-rose-500 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300 dark:hover:bg-rose-900"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setDropdownOpen(false);
            onClear();
          }}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-600 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-uom-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
        >
          Clear
        </button>
      </div>

      {error !== null && (
        <div
          id="statement-error"
          role="alert"
          className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          <span className="font-semibold">{constructError !== null ? 'Error:' : 'Syntax:'}</span>
          <span>{error.message}</span>
          {errorHighlight}
        </div>
      )}
    </div>
  );
}
