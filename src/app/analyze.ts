/**
 * The pure LOGIC pipeline of `MainInterface.processCommand` — Scanner →
 * reformat → Parser → TruthTable → values string → evaluation — extracted so
 * it can run in two places without duplication:
 *
 *   - on the MAIN THREAD, where the app validates input and shows the truth
 *     table instantly (2^N rows are cheap; the geometry is what's heavy), and
 *   - inside `MainInterface` (main thread in tests, worker in the app), whose
 *     `processCommand` composes this analysis with the geometry pipeline.
 *
 * Every message, selection offset and classification is byte-identical to the
 * Java original — see the assertions in `scripts/parity-tests.ts`.
 */

import { Scanner } from '../logic/Scanner.ts';
import { Parser } from '../logic/Parser.ts';
import { TruthTable } from '../logic/TruthTable.ts';
import { ScannerException, ParserException } from '../logic/exceptions.ts';

export interface StatementError {
  message: string;
  /** 0-based selection range [from, to) in the statement input — mirrors
   *  `statementComboBox.select(...)` calls in the Java code. */
  selectionStart: number;
  selectionEnd: number;
  selectAll: boolean;
}

export interface EvaluationResult {
  /** One of TruthTable.TAUTOLOGY / IDENTITY / CONDITIONAL / CONTRADICTION. */
  evaluation: number;
  evaluationName: string;
  /** The "N rows / X s" statistic exactly as MainInterface.run() computes it. */
  rowsChecked: number;
  seconds: number;
  statsText: string;
}

export interface AnalysisSuccess {
  ok: true;
  /** The reformatted statement (`scanner.getStatement()`). */
  statement: string;
  truthTable: TruthTable;
  /** TruthTablePanel.values — reversed main-column string driving the fills. */
  values: string;
  evaluation: EvaluationResult;
  numberOfPropositions: number;
  propositionNames: string[];
}

export interface AnalysisFailure {
  ok: false;
  error: StatementError;
}

export type AnalysisResult = AnalysisSuccess | AnalysisFailure;

/**
 * Practical guard for the web build: 2^N rows are materialised into the
 * `values` string and 2^N flood fills are performed, exactly like the Java
 * app. Beyond this many propositions the (unchanged) algorithm still works
 * but browsers stall, so the UI refuses politely instead of freezing.
 */
export const MAX_PROPOSITIONS = 16;

/** Scanner → Parser → TruthTable → evaluation, with the exact Java errors. */
export function analyzeStatement(
  statementInput: string,
  outputMode: number,
  alphabetizePropositions: boolean,
): AnalysisResult {
  const trimmed = statementInput.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: {
        message: 'Cannot construct table: no statement entered.',
        selectionStart: 0,
        selectionEnd: 0,
        selectAll: false,
      },
    };
  }
  const scanner = new Scanner(trimmed);
  try {
    scanner.tokenize();
  } catch (e) {
    if (e instanceof ScannerException) {
      // Java: statementComboBox.select(se.getXValue() - 1, se.getYValue());
      return {
        ok: false,
        error: {
          message: e.getMessage(),
          selectionStart: e.getXValue() - 1,
          selectionEnd: e.getYValue(),
          selectAll: false,
        },
      };
    }
    throw e;
  }
  scanner.reformat();
  const statement = scanner.getStatement();
  const parser = new Parser(scanner.getTokenStream());
  try {
    parser.parse();
  } catch (e) {
    if (e instanceof ParserException) {
      // Java: select all, or select(pe.getXValue() - 1, pe.getXValue());
      return {
        ok: false,
        error: {
          message: e.getMessage(),
          selectionStart: e.selectAll() ? 0 : e.getXValue() - 1,
          selectionEnd: e.selectAll() ? statement.length : e.getXValue(),
          selectAll: e.selectAll(),
        },
      };
    }
    throw e;
  }

  const truthTable = new TruthTable(
    parser.getStatement(),
    parser.getPostfixStream(),
    outputMode,
    alphabetizePropositions,
  );

  if (truthTable.getNumberOfPropositions() > MAX_PROPOSITIONS) {
    return {
      ok: false,
      error: {
        message:
          `Statements with more than ${MAX_PROPOSITIONS} propositions ` +
          `(${Math.pow(2, MAX_PROPOSITIONS).toLocaleString()} rows) are not constructed in the browser.`,
        selectionStart: 0,
        selectionEnd: statement.length,
        selectAll: true,
      },
    };
  }

  return {
    ok: true,
    statement,
    truthTable,
    values: computeValuesForPainting(truthTable),
    evaluation: evaluateTable(truthTable),
    numberOfPropositions: truthTable.getNumberOfPropositions(),
    propositionNames: truthTable.getPropositionNames(),
  };
}

/**
 * Java: `TruthTablePanel.computeValuesForPainting()` (the values-building
 * tail of it) — reversed row order: values[0] is the LAST row (all-true).
 */
export function computeValuesForPainting(truthTable: TruthTable): string {
  const numberOfLines = truthTable.getNumberOfLines();
  let retString = '';
  for (let h = numberOfLines - 1; h >= 0; h--) {
    const mystirng = truthTable.computeRow(h);
    const pos = truthTable.getPositionOfMainColumn();
    retString += mystirng.substring(pos, pos + 1);
  }
  return retString;
}

/**
 * Port of `MainInterface.run()` — evaluation classification plus the
 * "rows / seconds" statistic (synchronous; abort thread machinery dropped).
 */
export function evaluateTable(truthTable: TruthTable): EvaluationResult {
  const startTime = performanceNow();
  const numberOfLines = truthTable.getNumberOfLines();
  const pos = truthTable.getPositionOfMainColumn();
  const upperBound = Math.floor(numberOfLines / 2);
  const oneLess = numberOfLines - 1;
  let result: number;
  let done = false;
  let currentIteration = 0;
  const row = truthTable.computeRow(0);

  const ch = row.charAt(pos);
  if (ch === 'T') {
    result = TruthTable.TAUTOLOGY;
  } else if (ch === '1') {
    result = TruthTable.IDENTITY;
  } else {
    result = TruthTable.CONTRADICTION;
  }

  while (currentIteration < upperBound) {
    if (
      truthTable.computeRow(currentIteration).charAt(pos) === ch &&
      truthTable.computeRow(oneLess - currentIteration).charAt(pos) === ch
    ) {
      currentIteration += 1;
    } else {
      currentIteration = numberOfLines;
      done = true;
      break;
    }
  }

  if (currentIteration !== numberOfLines) {
    currentIteration <<= 1;
  }
  const cachedEvaluation = !done ? result : TruthTable.CONDITIONAL;
  const endTime = performanceNow();
  const seconds = (endTime - startTime) / 1000;

  const statsText =
    currentIteration === 0
      ? `1 row / ${formatSeconds(seconds)} s`
      : `${currentIteration.toLocaleString('en-US')} rows / ${formatSeconds(seconds)} s`;

  return {
    evaluation: cachedEvaluation,
    evaluationName: TruthTable.EVALUATION_DEFINITION[cachedEvaluation],
    rowsChecked: currentIteration === 0 ? 1 : currentIteration,
    seconds,
    statsText,
  };
}

/**
 * True-row detector for the fill pipeline. Java compared against 'T' / 't'
 * only, which silently disabled all fills in 0/1 display mode; the port
 * accepts '1' as well so the diagram stays correct under both display modes.
 */
export function isTrueChar(c: string): boolean {
  const u = c.toUpperCase();
  return u === 'T' || u === '1';
}

function performanceNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function formatSeconds(s: number): string {
  // Java prints `(endTime - startTime) / 1000f` — a float like 0.016
  return String(Math.round(s * 1000) / 1000);
}
