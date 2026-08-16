/**
 * Truth-table export builders: CSV, Markdown, LaTeX tabular markup and the
 * plain-text format that replicates `TruthTableTextArea.saveTableToFile`
 * byte-for-byte (the `*` main-column marker line, header, `-+-` separator
 * and rows).
 */

import { TruthTable } from '../logic/TruthTable.ts';
import { TruthValue } from '../logic/TruthValue.ts';

/** Display-row -> table-row mapping used everywhere by the original UI. */
export function interpretedPosition(truthTable: TruthTable, displayRow: number): number {
  if (truthTable.getDisplayMethod() === TruthValue.TRUE_FALSE) {
    return truthTable.getNumberOfLines() - displayRow - 1;
  }
  return displayRow;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Column metadata shared by CSV and Markdown exports. */
function operatorColumns(truthTable: TruthTable): { position: number; label: string }[] {
  const statement = truthTable.getStatement();
  const positions = truthTable.getOperatorPositions();
  if (positions.length === 0) {
    // Statement with no operators: single result column under the proposition/constant.
    return [{ position: truthTable.getPositionOfMainColumn(), label: statement.trim() || 'value' }];
  }
  return positions.map((position, k) => ({
    position,
    label: `${statement.charAt(position)} [col ${k + 1}]${k === positions.length - 1 ? ' (main)' : ''}`,
  }));
}

export function buildCSV(truthTable: TruthTable): string {
  truthTable.getPositionOfMainColumn(); // ensure operator positions are computed
  const propositionNames = truthTable.getPropositionNames();
  const columns = operatorColumns(truthTable);
  const lines: string[] = [];
  const header = ['No.', ...propositionNames, ...columns.map((c) => c.label)];
  lines.push(header.map(csvEscape).join(','));

  const numberOfLines = truthTable.getNumberOfLines();
  const displayMethod = truthTable.getDisplayMethod();
  for (let i = 0; i < numberOfLines; i++) {
    const row = interpretedPosition(truthTable, i);
    const binary = truthTable.getBinaryFormat(row);
    const rowString = truthTable.computeRow(row);
    const cells = [
      String(i),
      ...binary.map((b) => TruthValue.getTruthValueString(b, displayMethod)),
      ...columns.map((c) => rowString.charAt(c.position)),
    ];
    lines.push(cells.map(csvEscape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

export function buildMarkdown(truthTable: TruthTable): string {
  truthTable.getPositionOfMainColumn();
  const propositionNames = truthTable.getPropositionNames();
  const columns = operatorColumns(truthTable);
  const evaluation = truthTable.getEvaluation();
  const lines: string[] = [];
  lines.push(`# Truth table — \`${truthTable.getStatement()}\``);
  lines.push('');
  lines.push(
    `**Evaluation:** ${TruthTable.EVALUATION_DEFINITION[evaluation]} · ` +
      `${truthTable.getNumberOfLines()} rows · ${truthTable.getNumberOfPropositions()} proposition(s)`,
  );
  lines.push('');
  const header = ['No.', ...propositionNames.map((p) => `\`${p}\``), ...columns.map((c) => `\`${c.label}\``)];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);

  const numberOfLines = truthTable.getNumberOfLines();
  const displayMethod = truthTable.getDisplayMethod();
  for (let i = 0; i < numberOfLines; i++) {
    const row = interpretedPosition(truthTable, i);
    const binary = truthTable.getBinaryFormat(row);
    const rowString = truthTable.computeRow(row);
    const cells = [
      String(i),
      ...binary.map((b) => TruthValue.getTruthValueString(b, displayMethod)),
      ...columns.map((c) => rowString.charAt(c.position) || ' '),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Escapes LaTeX special characters in plain text (used inside \texttt{}). */
function latexEscape(value: string): string {
  return value
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/**
 * LaTeX `tabular` export (plain LaTeX 2e — no extra packages required).
 * Column layout mirrors the CSV/Markdown exports: row number, one column per
 * proposition, one column per operator (evaluation order), main column last.
 */
export function buildLaTeX(truthTable: TruthTable): string {
  truthTable.getPositionOfMainColumn(); // ensure operator positions are computed
  const propositionNames = truthTable.getPropositionNames();
  const columns = operatorColumns(truthTable);
  const evaluation = truthTable.getEvaluation();
  const colSpec = `r|${'c'.repeat(propositionNames.length)}|${'c'.repeat(columns.length)}`;

  const lines: string[] = [];
  lines.push(`% Truth table for: ${truthTable.getStatement()}`);
  lines.push(`% Evaluation: ${TruthTable.EVALUATION_DEFINITION[evaluation]}`);
  lines.push(`% ${truthTable.getNumberOfLines()} rows, ${truthTable.getNumberOfPropositions()} proposition(s)`);
  lines.push('\\begin{table}[ht]');
  lines.push('  \\centering');
  lines.push(`  \\begin{tabular}{${colSpec}}`);
  const header = [
    'No.',
    ...propositionNames.map((p) => `$${latexEscape(p)}$`),
    ...columns.map((c) => `\\texttt{${latexEscape(c.label)}}`),
  ];
  lines.push(`    ${header.join(' & ')} \\\\`);
  lines.push('    \\hline');

  const numberOfLines = truthTable.getNumberOfLines();
  const displayMethod = truthTable.getDisplayMethod();
  for (let i = 0; i < numberOfLines; i++) {
    const row = interpretedPosition(truthTable, i);
    const binary = truthTable.getBinaryFormat(row);
    const rowString = truthTable.computeRow(row);
    const cells = [
      String(i),
      ...binary.map((b) => TruthValue.getTruthValueString(b, displayMethod)),
      ...columns.map((c) => rowString.charAt(c.position).trim() || '~'),
    ];
    lines.push(`    ${cells.join(' & ')} \\\\`);
  }
  lines.push('  \\end{tabular}');
  lines.push(`  \\caption{Truth table for \\texttt{${latexEscape(truthTable.getStatement())}} — ` +
    `${TruthTable.EVALUATION_DEFINITION[evaluation]}.}`);
  lines.push('\\end{table}');
  lines.push('');
  return lines.join('\n');
}

/**
 * Byte-for-byte port of the text export produced by
 * `TruthTableTextArea.saveTableToFile` / `MainInterface.saveTableToFile`.
 */
export function buildText(
  truthTable: TruthTable,
  options: {
    highlightMainColumn: boolean;
    showRowNumbers: boolean;
    showColumnNumbers: boolean;
  },
): string {
  const numberOfCharsInMaxLine = String(truthTable.getNumberOfLines() - 1).length;
  const out: string[] = [];

  const padLeftMargin = (builder: string[]): void => {
    if (options.showRowNumbers) {
      for (let i = 0; i < numberOfCharsInMaxLine + 1; i++) builder.push(' ');
    }
  };

  if (options.highlightMainColumn) {
    // TruthTableTextArea.getHighlightedLine
    const builder: string[] = [];
    padLeftMargin(builder);
    const numberOfPropositions = truthTable.getNumberOfPropositions();
    for (let i = 0; i < numberOfPropositions; i++) builder.push('    ');
    builder.push(' ');
    const mainColumnPosition = truthTable.getPositionOfMainColumn();
    for (let i = 0; i < mainColumnPosition; i++) builder.push(' ');
    builder.push('*');
    for (let i = mainColumnPosition; i < truthTable.getStatement().length; i++) builder.push(' ');
    out.push(builder.join(''));
  }

  {
    const builder: string[] = [];
    padLeftMargin(builder);
    builder.push(truthTable.getHeader(true));
    out.push(builder.join(''));
  }
  {
    const builder: string[] = [];
    padLeftMargin(builder);
    builder.push(truthTable.getHeaderSeparator());
    out.push(builder.join(''));
  }

  const numberOfLines = truthTable.getNumberOfLines();
  const displayMethod = truthTable.getDisplayMethod();
  for (let i = 0; i < numberOfLines; i++) {
    // TruthTableTextArea.getLine (currentRow = MAX, currentColumn = MAX)
    const builder: string[] = [];
    const row = interpretedPosition(truthTable, i);
    if (options.showRowNumbers) {
      const str = String(i);
      for (let j = 0; j < numberOfCharsInMaxLine - str.length; j++) builder.push(' ');
      builder.push(str);
      builder.push(')');
    }
    const binaryPropositionValues = truthTable.getBinaryFormat(row);
    for (let j = 0; j < binaryPropositionValues.length; j++) {
      builder.push(' ');
      builder.push(TruthValue.getTruthValueString(binaryPropositionValues[j], displayMethod));
      builder.push(' |');
    }
    builder.push(' ');
    builder.push(truthTable.computeRow(row));
    builder.push(' ');
    out.push(builder.join(''));
  }

  if (options.showColumnNumbers) {
    out.push('');
    const columnOrderStrings = truthTable.getColumnOrderStrings(Number.MAX_SAFE_INTEGER);
    for (const line of columnOrderStrings) {
      const builder: string[] = [];
      padLeftMargin(builder);
      const numberOfPropositions = truthTable.getNumberOfPropositions();
      for (let i = 0; i < numberOfPropositions; i++) builder.push('    ');
      builder.push(' ');
      builder.push(line);
      out.push(builder.join(''));
    }
  }
  return out.join('\n');
}

/* ------------------------------ download helper --------------------------- */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text: string, filename: string, mime: string): void {
  downloadBlob(new Blob([text], { type: mime }), filename);
}
