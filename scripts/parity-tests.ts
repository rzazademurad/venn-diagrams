/**
 * Headless parity tests for the ported logic + geometry.
 * Run via `npm test` (bundled with esbuild, executed in Node — no DOM needed).
 */

import { Scanner } from '../src/logic/Scanner.ts';
import { Parser } from '../src/logic/Parser.ts';
import { TruthTable } from '../src/logic/TruthTable.ts';
import { ScannerException, ParserException } from '../src/logic/exceptions.ts';
import { TruthValue } from '../src/logic/TruthValue.ts';
import { MainInterface } from '../src/app/MainInterface.ts';
import { VennsConstruction } from '../src/geometry/VennsConstruction.ts';
import { WHITE, ORANGE, BLACK, RED, DARK_GREEN, packRGB } from '../src/renderer/Raster.ts';
import { FloodFill } from '../src/renderer/FloodFill.ts';
import { buildLaTeX, buildText } from '../src/exports/exporters.ts';
import type { Pt } from '../src/geometry/Mapper.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.error(`FAIL: ${name} ${detail}`);
  }
}

function scanParse(statement: string): { statement: string; table: TruthTable } {
  const scanner = new Scanner(statement);
  scanner.tokenize();
  scanner.reformat();
  const parser = new Parser(scanner.getTokenStream());
  parser.parse();
  return {
    statement: scanner.getStatement(),
    table: new TruthTable(parser.getStatement(), parser.getPostfixStream(), TruthValue.TRUE_FALSE, false),
  };
}

function postfixOf(statement: string): string {
  const scanner = new Scanner(statement);
  scanner.tokenize();
  scanner.reformat();
  const parser = new Parser(scanner.getTokenStream());
  parser.parse();
  return parser
    .getPostfixStream()
    .map((t) => t.getSymbol())
    .join(' ');
}

/** Tautology over n propositions A..: `A | ~A | (B & B) | (C & C) | ...` */
function tautologyOf(n: number): string {
  const letters = Array.from({ length: n }, (_, k) => String.fromCharCode(65 + k));
  return `${letters[0]} | ~${letters[0]}${letters
    .slice(1)
    .map((l) => ` | (${l} & ${l})`)
    .join('')}`;
}

/* ------------------------------ Scanner tests ----------------------------- */

{
  const s = new Scanner('a&b');
  s.tokenize();
  s.reformat();
  check('reformat inserts canonical spaces + uppercases', s.getStatement() === 'A & B', s.getStatement());
}
{
  const s = new Scanner('~(A|B)<=>C->0');
  s.tokenize();
  s.reformat();
  check('reformat complex', s.getStatement() === '~(A | B) <=> C -> 0', JSON.stringify(s.getStatement()));
}
{
  const s = new Scanner('A   &     b');
  s.tokenize();
  s.reformat();
  check('whitespace collapsed', s.getStatement() === 'A & B', s.getStatement());
}
{
  let error: ScannerException | null = null;
  try {
    new Scanner('A # B').tokenize();
  } catch (e) {
    error = e as ScannerException;
  }
  check(
    'single illegal symbol position',
    error !== null &&
      error.messageType === ScannerException.ILLEGAL_SYMBOL &&
      error.getXValue() === 3 &&
      error.getMessage() === 'Illegal symbol at position 3.',
    error?.getMessage(),
  );
}
{
  let error: ScannerException | null = null;
  try {
    new Scanner('A ##% B').tokenize();
  } catch (e) {
    error = e as ScannerException;
  }
  check(
    'illegal symbol range positions',
    error !== null &&
      error.messageType === ScannerException.ILLEGAL_SYMBOLS &&
      error.getXValue() === 3 &&
      error.getYValue() === 5 &&
      error.getMessage() === 'Illegal symbol from positions 3 to 5.',
    error?.getMessage(),
  );
}
{
  let error: ScannerException | null = null;
  try {
    new Scanner('A = B').tokenize(); // '=' without '>'
  } catch (e) {
    error = e as ScannerException;
  }
  check('incomplete conditional reports "=" position', error !== null && error.getXValue() === 3, error?.getMessage());
}
{
  const s = new Scanner('A <-> B'); // biconditional fallback path
  s.tokenize();
  s.reformat();
  check('biconditional <-> accepted', s.getStatement() === 'A <-> B', s.getStatement());
}
{
  const s = new Scanner('A<=>B');
  s.tokenize();
  s.reformat();
  check('biconditional <=> accepted', s.getStatement() === 'A <=> B', s.getStatement());
}

/* ------------------------------- Parser tests ----------------------------- */

function expectParserError(statement: string, messageType: number, xValue: number | null, name: string): void {
  const scanner = new Scanner(statement);
  scanner.tokenize();
  scanner.reformat();
  const parser = new Parser(scanner.getTokenStream());
  let error: ParserException | null = null;
  try {
    parser.parse();
  } catch (e) {
    error = e as ParserException;
  }
  check(
    name,
    error !== null && error.messageType === messageType && (xValue === null || error.getXValue() === xValue),
    `${error?.getMessage()} x=${error?.getXValue()}`,
  );
}

expectParserError('A B', ParserException.MISSING_CONNECTIVE, 2, 'missing connective A B');
expectParserError('A &', ParserException.MISSING_STATEMENT, 4, 'missing statement after &');
expectParserError('~', ParserException.MISSING_STATEMENT, 2, 'missing statement after ~');
expectParserError('()', ParserException.MISSING_STATEMENT_IN_PARENTHESES, 2, 'empty parentheses');
expectParserError('(', ParserException.ILLEGAL_USE_OF_PARENTHESES, 1, 'lone open parenthesis');
expectParserError(') A', ParserException.ILLEGAL_USE_OF_PARENTHESES, 1, 'leading close parenthesis');
expectParserError('& A', ParserException.MISSING_STATEMENT, 1, 'leading binary operator');
expectParserError('A | B)', ParserException.MISSING_OPEN_PARENTHESIS, null, 'missing open parenthesis');
expectParserError('(A | B', ParserException.MISSING_CLOSE_PARENTHESIS, null, 'missing close parenthesis');

/* ----------------------- Postfix / precedence parity ---------------------- */

check('AND over XOR (Java precedences)', postfixOf('A + B & C') === 'A B C & +', postfixOf('A + B & C'));
check('OR over XOR', postfixOf('A | B + C') === 'A B | C +', postfixOf('A | B + C'));
check('AND over OR', postfixOf('A | B & C') === 'A B C & |', postfixOf('A | B & C'));
check('conditional right-associative', postfixOf('A => B => C') === 'A B C => =>', postfixOf('A => B => C'));
check(
  'biconditional/xor equal precedence, left assoc',
  postfixOf('A <=> B + C') === 'A B <=> C +',
  postfixOf('A <=> B + C'),
);
check('negation stacking', postfixOf('~~A') === 'A ~ ~', postfixOf('~~A'));
check('parentheses', postfixOf('(A | B) & C') === 'A B | C &', postfixOf('(A | B) & C'));
check('conditional over xor', postfixOf('A + B => C') === 'A B C => +', postfixOf('A + B => C'));

/* ---------------------------- TruthTable parity ---------------------------- */

{
  const { statement, table } = scanParse('A & B');
  check('statement reformatted', statement === 'A & B', statement);
  check('4 lines for 2 props', table.getNumberOfLines() === 4);
  check('main column under &', table.getPositionOfMainColumn() === 2);
  check('row0 binary FF', JSON.stringify(table.getBinaryFormat(0)) === '[false,false]');
  check('row3 binary TT', JSON.stringify(table.getBinaryFormat(3)) === '[true,true]');
  check('row0 string', table.computeRow(0) === '  F  ', JSON.stringify(table.computeRow(0)));
  check('row3 string', table.computeRow(3) === '  T  ', JSON.stringify(table.computeRow(3)));
  check('evaluation conditional', table.getEvaluation() === TruthTable.CONDITIONAL);
}
{
  const { table } = scanParse('A | ~A');
  check('tautology (T/F mode)', table.getEvaluation() === TruthTable.TAUTOLOGY);
}
{
  const scanner = new Scanner('A | ~A');
  scanner.tokenize();
  scanner.reformat();
  const parser = new Parser(scanner.getTokenStream());
  parser.parse();
  const table = new TruthTable(parser.getStatement(), parser.getPostfixStream(), TruthValue.ZERO_ONE, false);
  check('same statement is Identity in 0/1 mode (Java quirk preserved)', table.getEvaluation() === TruthTable.IDENTITY);
}
{
  const { table } = scanParse('A & ~A');
  check('contradiction', table.getEvaluation() === TruthTable.CONTRADICTION);
}
{
  const { statement, table } = scanParse('~A & B');
  check('negation statement', statement === '~A & B', statement);
  const row = table.computeRow(2); // binary [true, false]
  check('negation row string', row === 'F  F  ', JSON.stringify(row));
  check('main col of ~A & B', table.getPositionOfMainColumn() === 3);
}
{
  const { table } = scanParse('A');
  check('single proposition: 1 column', table.getNumberOfColumns() === 1);
  check('single proposition row1', table.computeRow(1) === 'T', JSON.stringify(table.computeRow(1)));
  const values = MainInterface.computeValuesForPainting(table);
  check('values reversed (all-true first)', values === 'TF', values);
}
{
  const { table } = scanParse('A & B & C');
  const values = MainInterface.computeValuesForPainting(table);
  check('values for A & B & C', values === 'TFFFFFFF', values);
}
{
  const { table } = scanParse('A & B | C');
  const strings = table.getColumnOrderStrings(Number.MAX_SAFE_INTEGER);
  check('column order height', strings.length === 2, JSON.stringify(strings));
  check(
    'column order marks ^ under operators',
    strings[0].charAt(2) === '^' && strings[0].charAt(6) === '^',
    JSON.stringify(strings),
  );
}
{
  // Text export golden sample (TruthTableTextArea.saveTableToFile format)
  const { table } = scanParse('A & B');
  const text = buildText(table, { highlightMainColumn: true, showRowNumbers: true, showColumnNumbers: false });
  const expected = [
    ' '.repeat(13) + '*' + ' '.repeat(3),
    '   A | B | A & B ',
    '  ---+---+-------',
    '0) T | T |   T   ',
    '1) T | F |   F   ',
    '2) F | T |   F   ',
    '3) F | F |   F   ',
  ].join('\n');
  check('text export golden sample', text === expected, JSON.stringify(text));
}
{
  // LaTeX export: structure + escaping of LaTeX-special operator symbols.
  const { table } = scanParse('A & B');
  const tex = buildLaTeX(table);
  check('latex export: tabular env + column spec', tex.includes('\\begin{tabular}{r|cc|c}'), tex.slice(0, 200));
  check('latex export: & escaped in labels', tex.includes('\\&') && !tex.includes('{& '), tex.slice(0, 400));
  const rowLines = tex.split('\n').filter((l) => /^\s+\d+ & /.test(l));
  check('latex export: one line per truth-table row', rowLines.length === 4, String(rowLines.length));
  check('latex export: first row is the all-true minterm', /^\s+0 & T & T & T \\\\$/.test(rowLines[0]), rowLines[0]);
}

/* --------------------------- Flood fill (iterative) ------------------------ */

{
  const venn = new VennsConstruction();
  venn.draw(3);
  FloodFill.fillRegion(1, 1, venn.buffer, ORANGE);
  let orangeCount = 0;
  let blackCount = 0;
  for (let i = 0; i < venn.buffer.data.length; i++) {
    if (venn.buffer.data[i] === ORANGE) orangeCount++;
    if (venn.buffer.data[i] === BLACK) blackCount++;
  }
  check('iterative flood fill fills large outside region', orangeCount > 100000, String(orangeCount));
  check('strokes untouched by fill', blackCount > 1000, String(blackCount));
}

/* ------------------- Venn construction + Mapper region tests --------------- */

{
  const venn = new VennsConstruction();
  for (let n = 4; n <= 8; n++) {
    const path = venn.drawVenn(n);
    check(
      `path size for n=${n} is 2^(n-1)`,
      path !== null && path.length === Math.pow(2, n - 1),
      String(path?.length),
    );
  }
}

/**
 * Structural check: filling every region of an n-set tautology must cover the
 * entire white plane (all 2^n regions exist and are reached), and each of the
 * 2^n seeds must land in its own distinct connected white region.
 */
for (let n = 1; n <= 7; n++) {
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  const seeds: Pt[] = [];
  const venn = app.venn;
  const origFillPoint = venn.fillPoint.bind(venn);
  venn.fillPoint = (p: Pt) => {
    seeds.push({ x: p.x, y: p.y });
    origFillPoint(p);
  };
  const result = app.processCommand(tautologyOf(n));
  check(`processCommand ok for n=${n}`, result.ok === true, JSON.stringify(result));
  if (!result.ok) continue;
  check(`n=${n}: table has n propositions`, result.numberOfPropositions === n);
  check(`n=${n}: ${Math.pow(2, n)} seeds filled`, seeds.length === Math.pow(2, n), String(seeds.length));
  let whiteLeft = 0;
  for (let i = 0; i < venn.buffer.data.length; i++) {
    if (venn.buffer.data[i] === WHITE) whiteLeft++;
  }
  check(`n=${n}: tautology fills the entire plane (no white left)`, whiteLeft === 0, String(whiteLeft));
}

for (let n = 1; n <= 7; n++) {
  // Distinctness: fill each region with a unique color; a seed that is no
  // longer white when its turn comes means two rows mapped to one region.
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  const seeds: Pt[] = [];
  const venn = app.venn;
  venn.fillPoint = (p: Pt) => {
    seeds.push({ x: p.x, y: p.y });
  };
  const result = app.processCommand(tautologyOf(n));
  if (!result.ok) {
    check(`distinctness n=${n}: construct ok`, false, JSON.stringify(result));
    continue;
  }
  let nonWhiteSeeds = 0;
  seeds.forEach((seed, k) => {
    const pixel = venn.buffer.getPixel(seed.x, seed.y);
    if (pixel !== WHITE) {
      nonWhiteSeeds++;
      return;
    }
    FloodFill.fillRegion(seed.x, seed.y, venn.buffer, packRGB((k + 1) & 0xff, ((k + 1) >> 8) & 0xff, 200));
  });
  check(`n=${n}: all ${seeds.length} regions distinct`, nonWhiteSeeds === 0, `${nonWhiteSeeds} collisions`);
}

{
  // Semantic spot check for N=3: "A & B & C" fills exactly the triple overlap.
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  const result = app.processCommand('A & B & C');
  check('A & B & C ok', result.ok);
  const venn = app.venn;
  const d = Math.trunc(venn.width / 8);
  const x3 = 70 + d + d + d;
  const y3 = 80 + d - d + 2 * d;
  check('triple overlap filled', venn.buffer.getPixel(x3 + 1, y3 + 1) === ORANGE);
  check('universe not filled', venn.buffer.getPixel(1, 1) === WHITE);
  check('A-only region not filled', venn.buffer.getPixel(x3 - 1, y3 + 1 + d) !== ORANGE);
}

{
  // Contradiction fills nothing.
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  const result = app.processCommand('A & ~A & B & C & D');
  check('contradiction ok', result.ok);
  let orangeCount = 0;
  for (let i = 0; i < app.venn.buffer.data.length; i++) {
    if (app.venn.buffer.data[i] === ORANGE) orangeCount++;
  }
  check('contradiction fills nothing', orangeCount === 0, String(orangeCount));
}

{
  // Evaluation statistics parity with MainInterface.run()
  const { table } = scanParse('A | ~A');
  const ev = MainInterface.evaluate(table);
  check('tautology stats: rows = numberOfLines', ev.rowsChecked === 2, String(ev.rowsChecked));
  check('tautology name', ev.evaluationName === 'Tautology');
  const { table: t2 } = scanParse('A & B');
  const ev2 = MainInterface.evaluate(t2);
  check('conditional rows = all lines', ev2.rowsChecked === 4, String(ev2.rowsChecked));
}

/* ---------------------- computeRow(index, maxColumn) ----------------------- */

{
  const { table } = scanParse('A & B | C');
  // row 3 = binary [F, T, T]: '&' (pos 2) = F, '|' (pos 6) = T
  check('computeRow full', table.computeRow(3) === '  F   T  ', JSON.stringify(table.computeRow(3)));
  check('computeRow maxColumn=0 blanks later columns', table.computeRow(3, 0) === '  F      ', JSON.stringify(table.computeRow(3, 0)));
  check('computeRow maxColumn=-1 blanks all operator columns', table.computeRow(3, -1) === '         ', JSON.stringify(table.computeRow(3, -1)));
}

/* ------------------------ region map (row ↔ region) ------------------------ */

{
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  const result = app.processCommand('A & B & C');
  check('regionmap: construct ok', result.ok);
  check('regionmap: built', app.regionMap !== null && app.regionMapWidth === app.venn.width);
  // (1,1) is the universe seed — row 0 (all false).
  check('regionmap: (1,1) is row 0', app.regionAt(1, 1) === 0, String(app.regionAt(1, 1)));
  // Triple overlap contains row 7 (all true).
  const d = Math.trunc(app.venn.width / 8);
  const x3 = 70 + 3 * d;
  const y3 = 80 + 2 * d;
  check('regionmap: triple overlap is row 7', app.regionAt(x3 + 1, y3 + 1) === 7, String(app.regionAt(x3 + 1, y3 + 1)));
  // Every mapped seed resolves back to its own row.
  let seedMismatches = 0;
  app.seedForRow.forEach((seed, row) => {
    if (seed !== null && app.regionAt(seed.x, seed.y) !== row) seedMismatches++;
  });
  check('regionmap: seeds resolve to their rows (n=3)', seedMismatches === 0, String(seedMismatches));
}

{
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  const result = app.processCommand('(A & B) | (C & D) + E');
  check('regionmap n=5: construct ok', result.ok);
  check(
    'regionmap n=5: all 32 seeds known',
    app.seedForRow.length === 32 && app.seedForRow.every((s) => s !== null),
    String(app.seedForRow.filter((s) => s === null).length),
  );
  let seedMismatches = 0;
  app.seedForRow.forEach((seed, row) => {
    if (seed !== null && app.regionAt(seed.x, seed.y) !== row) seedMismatches++;
  });
  check('regionmap n=5: seeds resolve to their rows', seedMismatches === 0, String(seedMismatches));
  const seeds = MainInterface.computeSeedsInValuesOrder(app.venn.path!);
  check('computeSeedsInValuesOrder n=5: 32 seeds', seeds.length === 32, String(seeds.length));
}

/* ---------------- Thesis §5.2 labeling + §4.1 auto-zoom fix ---------------- */

{
  // Labeling: one label per set, square labels black, curve labels in the
  // curve colors, texts bound to the table's proposition order.
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  const result = app.processCommand('A & B & C & D & E');
  check('labels: construct ok', result.ok);
  check('labels: one per set', app.lastLabels.length === 5, String(app.lastLabels.length));
  check(
    'labels: texts follow proposition order',
    app.lastLabels.map((l) => l.text).join('') === 'ABCDE',
    app.lastLabels.map((l) => l.text).join(''),
  );
  check(
    'labels: colors black×3 then red, dark green',
    app.lastLabels[0].color === BLACK &&
      app.lastLabels[1].color === BLACK &&
      app.lastLabels[2].color === BLACK &&
      app.lastLabels[3].color === RED &&
      app.lastLabels[4].color === DARK_GREEN,
  );
  const inBounds = app.lastLabels.every(
    (l) => l.x > 0 && l.y > 0 && l.x < app.venn.width && l.y < app.venn.length,
  );
  check('labels: anchors inside the buffer', inBounds);
  // Labels are an overlay — the pixel buffer must be identical with/without
  // them, so fills can never be blocked by label text (nothing to test on the
  // raster; assert the anchors are not drawn into it by checking stroke colors
  // only exist on stroke pixels is implicit in the earlier fill tests).
}

{
  // Auto-zoom (thesis §4.1): at the default size a 10-set diagram leaves no
  // pixels between the innermost curves, so some regions cannot be filled.
  // processCommand must zoom in automatically until every region fills.
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  const letters10 = 'ABCDEFGHIJ'.split('');
  const tautology10 = `A | ~A${letters10.slice(1).map((l) => ` | (${l} & ${l})`).join('')}`;
  const result = app.processCommand(tautology10);
  check('auto-zoom: construct ok for n=10', result.ok, JSON.stringify(result).slice(0, 200));
  if (result.ok) {
    check('auto-zoom: all regions fillable after fix', result.blockedRegions === 0, String(result.blockedRegions));
    let whiteLeft = 0;
    for (let i = 0; i < app.venn.buffer.data.length; i++) {
      if (app.venn.buffer.data[i] === WHITE) whiteLeft++;
    }
    check('auto-zoom: n=10 tautology fills entire plane', whiteLeft === 0, String(whiteLeft));
    console.log(
      `  [info] n=10 auto-zoom steps: ${result.autoZoomSteps}, final buffer ${app.venn.width}×${app.venn.length}`,
    );
    // Detection side: zooming back OUT to the default must re-block regions
    // (this is the situation the original program silently mis-rendered).
    app.venn.reset();
    app.redraw();
    check('auto-zoom: blocked regions detected at default zoom', app.venn.blockedFills > 0, String(app.venn.blockedFills));
  }
}

{
  // n <= 7 diagrams never need the auto-zoom at the default size.
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  const result = app.processCommand('A & B & C & D & E & F & G');
  check('no auto-zoom for n=7', result.ok && result.autoZoomSteps === 0 && result.blockedRegions === 0);
}

{
  // Zoom arithmetic parity (width/ZOOM/ZOOMFACTOR sequence).
  const v = new VennsConstruction();
  v.zoomin(); // width 1231, ZOOM 70, ZF 21
  v.zoomin(); // width 1301, ZOOM 91, ZF 22
  check(
    'zoomin sequence',
    v.width === 1301 && v.length === 1039 && v.ZOOM === 91 && v.ZOOMFACTOR === 22,
    `${v.width} ${v.length} ${v.ZOOM} ${v.ZOOMFACTOR}`,
  );
  v.zoomout();
  check('zoomout sequence', v.width === 1210 && v.ZOOM === 69 && v.ZOOMFACTOR === 21, `${v.width} ${v.ZOOM} ${v.ZOOMFACTOR}`);
  v.zoomout();
  check('zoomout resets at floor', v.width === 1181 && v.ZOOM === 50 && v.ZOOMFACTOR === 20, `${v.width}`);
}

/* --------------------- circular style (redesign mode) ---------------------- */

for (let n = 1; n <= 7; n++) {
  // Same structural guarantees as classic: filling every region of an n-set
  // tautology covers the whole plane, and all 2^n regions are distinct.
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  app.venn.style = 'circular';
  const result = app.processCommand(tautologyOf(n));
  check(`circular n=${n}: construct ok`, result.ok === true, JSON.stringify(result).slice(0, 160));
  if (!result.ok) continue;
  const fill = app.venn.fillColor();
  let whiteLeft = 0;
  let filled = 0;
  for (let i = 0; i < app.venn.buffer.data.length; i++) {
    if (app.venn.buffer.data[i] === WHITE) whiteLeft++;
    if (app.venn.buffer.data[i] === fill) filled++;
  }
  // Smooth arcs crossing at shallow angles can enclose a handful of 1px
  // pockets between stroke pixels — invisible pinholes, not regions.
  check(`circular n=${n}: tautology covers plane`, whiteLeft <= 16, String(whiteLeft));
  check(`circular n=${n}: fill color present`, filled > 1000, String(filled));
  check(`circular n=${n}: no blocked regions`, result.blockedRegions === 0, String(result.blockedRegions));
}

for (let n = 1; n <= 7; n++) {
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  app.venn.style = 'circular';
  const seeds: Pt[] = [];
  const venn = app.venn;
  venn.fillPoint = (p: Pt) => {
    seeds.push({ x: p.x, y: p.y });
  };
  const result = app.processCommand(tautologyOf(n));
  if (!result.ok) {
    check(`circular distinctness n=${n}: construct ok`, false, JSON.stringify(result).slice(0, 160));
    continue;
  }
  let nonWhiteSeeds = 0;
  seeds.forEach((seed, k) => {
    const pixel = venn.buffer.getPixel(seed.x, seed.y);
    if (pixel !== WHITE) {
      nonWhiteSeeds++;
      return;
    }
    FloodFill.fillRegion(seed.x, seed.y, venn.buffer, packRGB((k + 1) & 0xff, ((k + 1) >> 8) & 0xff, 199));
  });
  check(`circular n=${n}: all ${seeds.length} regions distinct`, nonWhiteSeeds === 0, `${nonWhiteSeeds} collisions`);
}

{
  // Circular semantics for the classic trio: A & B & C fills exactly the
  // triple overlap (the centroid region), leaving the universe white.
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  app.venn.style = 'circular';
  const result = app.processCommand('A & B & C');
  check('circular A & B & C ok', result.ok);
  const fill = app.venn.fillColor();
  const d = Math.trunc(app.venn.width / 8);
  const gx = 70 + Math.round(3.5 * d);
  const gy = 80 + 3 * d;
  check('circular: centroid region filled', app.venn.buffer.getPixel(gx, gy) === fill);
  check('circular: universe white', app.venn.buffer.getPixel(1, 1) === WHITE);
  check('circular: three black circle labels (wiki style)', app.lastLabels.length === 3 && app.lastLabels[0].color === BLACK);
  check('circular: region map centroid = row 7', app.regionAt(gx, gy) === 7, String(app.regionAt(gx, gy)));
}

{
  // Smooth style label colors match the reference figure: black circles,
  // then red / green / blue curve labels.
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  app.venn.style = 'circular';
  const result = app.processCommand('(A & B) | (C & D) + E');
  check('smooth labels: construct ok', result.ok);
  check(
    'smooth labels: black circles + red D + green E',
    app.lastLabels.length === 5 &&
      app.lastLabels[0].color === BLACK &&
      app.lastLabels[1].color === BLACK &&
      app.lastLabels[2].color === BLACK &&
      app.lastLabels[3].color === RED &&
      app.lastLabels[4].color === DARK_GREEN,
  );
}

{
  // Auto-zoom fix works in circular style too (the band gaps halve per level,
  // so 8 sets is the practical smooth depth; beyond that the blocked-regions
  // chip advises the Classic style).
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  app.venn.style = 'circular';
  const result = app.processCommand(tautologyOf(8));
  check('circular n=8: construct ok', result.ok);
  if (result.ok) {
    check('circular n=8: all regions fillable', result.blockedRegions === 0, String(result.blockedRegions));
    let whiteLeft = 0;
    for (let i = 0; i < app.venn.buffer.data.length; i++) {
      if (app.venn.buffer.data[i] === WHITE) whiteLeft++;
    }
    check('circular n=8: covers plane', whiteLeft <= 16, String(whiteLeft));
    console.log(`  [info] circular n=8 auto-zoom steps: ${result.autoZoomSteps}, buffer ${app.venn.width}×${app.venn.length}`);
  }
}

/* -------------------- style switching & zoom-path parity -------------------- */

{
  // Both styles fill true regions with the same orange.
  const venn = new VennsConstruction();
  venn.style = 'classic';
  const classicFill = venn.fillColor();
  venn.style = 'circular';
  check('fill color: identical in both styles', venn.fillColor() === classicFill && classicFill === ORANGE);
}

function diffPixels(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length) return -1;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

for (const n of [4, 5, 6]) {
  // Switching circular -> classic re-runs the construct from the default zoom
  // and must be pixel-identical to a FRESH classic construct (the changeStyle
  // flow: style switch + reset(false) + processCommand).
  const letters = Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i)).join(' & ');
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  app.venn.style = 'circular';
  app.venn.update();
  app.processCommand(letters);
  app.venn.zoomin(false); // a leftover manual zoom must not leak through the switch
  app.venn.style = 'classic';
  app.venn.reset(false);
  const switched = app.processCommand(letters);
  check(`switch n=${n}: classic re-construct ok`, switched.ok);

  const fresh = new MainInterface(TruthValue.TRUE_FALSE);
  fresh.venn.style = 'classic';
  fresh.venn.update();
  fresh.processCommand(letters);
  const d = diffPixels(app.venn.buffer.data, fresh.venn.buffer.data);
  check(`switch n=${n}: pixel-identical to fresh classic`, d === 0, `${d} differing pixels`);
}

{
  // zoomAction('in') (single-construction path) produces the exact pixels of
  // the two-construction zoomin() + redraw() flow, in both styles.
  for (const style of ['classic', 'circular'] as const) {
    const a = new MainInterface(TruthValue.TRUE_FALSE);
    a.venn.style = style;
    a.venn.update();
    a.processCommand('(A & B) | (C & D)');
    a.venn.zoomin(); // old flow: full draw in update()...
    a.redraw(); // ...then draw + fill again

    const b = new MainInterface(TruthValue.TRUE_FALSE);
    b.venn.style = style;
    b.venn.update();
    b.processCommand('(A & B) | (C & D)');
    b.zoomAction('in'); // new flow: resize buffer, single draw + fill

    const d = diffPixels(a.venn.buffer.data, b.venn.buffer.data);
    check(`zoomAction('in') ${style}: pixel-identical to zoomin()+redraw()`, d === 0, `${d} differing pixels`);
    check(
      `zoomAction('in') ${style}: zoom state identical`,
      a.venn.width === b.venn.width && a.venn.ZOOM === b.venn.ZOOM && a.venn.ZOOMFACTOR === b.venn.ZOOMFACTOR,
    );

    a.zoomAction('reset');
    check(`zoomAction('reset') ${style}: back to default size`, a.venn.width === 1181 && a.venn.length === 919);
    let whiteOnly = true;
    const seedPixel = a.venn.buffer.getPixel(1, 1);
    void seedPixel;
    let filled = 0;
    for (let i = 0; i < a.venn.buffer.data.length; i++) {
      if (a.venn.buffer.data[i] === ORANGE) filled++;
    }
    whiteOnly = filled === 0;
    check(`zoomAction('reset') ${style}: fills reapplied after reset`, !whiteOnly, `${filled} orange px`);
  }
}

{
  // Buffer budget (web safety cap): with the default (Infinity) the engine is
  // byte-identical to Java; with a budget set, zoomin() past it is a denied
  // no-op (state unchanged, zoomDenied flagged) and auto-zoom stops at it.
  const v = new VennsConstruction();
  check('budget: default Infinity keeps canZoomIn() true', v.canZoomIn());
  const w0 = v.width;
  const z0 = v.ZOOM;
  v.maxBufferPixels = v.width * v.length; // any zoom-in would exceed this
  check('budget: canZoomIn() false at cap', !v.canZoomIn());
  v.zoomin();
  check('budget: denied zoomin leaves size unchanged', v.width === w0 && v.ZOOM === z0);
  check('budget: denied zoomin sets zoomDenied', v.zoomDenied);
  v.maxBufferPixels = Number.POSITIVE_INFINITY;
  v.zoomin();
  check('budget: lifted cap zooms again', v.width === w0 + z0 && !v.zoomDenied);

  // Auto-zoom respects the budget: a diagram that WOULD auto-zoom stops at
  // the cap and reports its blocked regions instead of exceeding the budget.
  const capped = new MainInterface(TruthValue.TRUE_FALSE);
  capped.venn.maxBufferPixels = 1181 * 919; // no zoom headroom at all
  const cappedResult = capped.processCommand('A & B & C & D & E & F & G & H & I & J');
  check('budget: capped construct still ok', cappedResult.ok);
  if (cappedResult.ok) {
    check('budget: no auto-zoom past the cap', cappedResult.autoZoomSteps === 0);
    check('budget: blocked regions reported', cappedResult.blockedRegions > 0, String(cappedResult.blockedRegions));
    check('budget: buffer stayed at default', capped.venn.width === 1181 && capped.venn.length === 919);
  }

  // zoomAction('in') at the cap: no-op returning false, pixels untouched.
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  app.processCommand('A & B');
  app.venn.maxBufferPixels = app.venn.width * app.venn.length;
  const before = app.venn.buffer.data.slice();
  const applied = app.zoomAction('in');
  check('budget: zoomAction denied returns false', !applied);
  check('budget: denied zoomAction leaves pixels untouched', diffPixels(before, app.venn.buffer.data) === 0);
}

{
  // Raster.adopt round-trip (the worker→main transfer wrapper).
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  app.processCommand('A & B & C & D');
  const source = app.venn.buffer;
  const adopted = (await import('../src/renderer/Raster.ts')).Raster.adopt(
    source.width,
    source.height,
    source.data.buffer.slice(0),
    source.ops,
    source.opGroups,
  );
  check('adopt: dimensions preserved', adopted.width === source.width && adopted.height === source.height);
  check('adopt: pixels identical', diffPixels(adopted.data, source.data) === 0);
  check('adopt: ops shared', adopted.ops.length === source.ops.length && adopted.ops.length > 0);
  check(
    'adopt: op groups mark every set',
    source.opGroups.length === 4 && source.opGroups.every((g, i) => g.set === i),
    JSON.stringify(source.opGroups.map((g) => g.set)),
  );
  // Group starts must be ascending and inside ops.
  let ascending = true;
  for (let i = 1; i < source.opGroups.length; i++) {
    if (source.opGroups[i].start < source.opGroups[i - 1].start) ascending = false;
  }
  check('adopt: op group starts ascending', ascending && source.opGroups[0].start === 0);
}

{
  // Region-map downsampling: hit-tests through the scale factor agree with
  // the full-resolution map at the sampled positions.
  const { downsampleRegionMap } = await import('../src/app/snapshot.ts');
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  app.processCommand('A & B & C & D & E');
  const full = app.regionMap!;
  const w = app.regionMapWidth;
  const h = app.regionMapHeight;
  const down = downsampleRegionMap(full, w, h, Math.floor((w * h) / 5));
  check('downsample: scaled below budget', down.width * down.height <= Math.floor((w * h) / 5));
  check('downsample: scale is a power of two > 1', down.scale >= 2 && (down.scale & (down.scale - 1)) === 0);
  let agree = true;
  for (let y = 0; y < down.height; y += 7) {
    for (let x = 0; x < down.width; x += 7) {
      const sx = Math.min(w - 1, x * down.scale);
      const sy = Math.min(h - 1, y * down.scale);
      if (down.map[y * down.width + x] !== full[sy * w + sx]) agree = false;
    }
  }
  check('downsample: sampled entries agree with full map', agree);
  const same = downsampleRegionMap(full, w, h, w * h);
  check('downsample: under budget returns identity', same.scale === 1 && same.map === full);
}

{
  // analyzeStatement (the worker-split logic pipeline) matches processCommand.
  const { analyzeStatement } = await import('../src/app/analyze.ts');
  const app = new MainInterface(TruthValue.TRUE_FALSE);
  const viaApp = app.processCommand('(A => B) & (C <=> D)');
  const viaAnalyze = analyzeStatement('(A => B) & (C <=> D)', TruthValue.TRUE_FALSE, false);
  check('analyze: ok parity', viaApp.ok && viaAnalyze.ok);
  if (viaApp.ok && viaAnalyze.ok) {
    check('analyze: statement identical', viaAnalyze.statement === viaApp.statement);
    check('analyze: values identical', viaAnalyze.values === viaApp.values);
    check('analyze: evaluation identical', viaAnalyze.evaluation.evaluationName === viaApp.evaluation.evaluationName);
  }
  const badApp = app.processCommand('A && B');
  const badAnalyze = analyzeStatement('A && B', TruthValue.TRUE_FALSE, false);
  check('analyze: error parity', !badApp.ok && !badAnalyze.ok);
  if (!badApp.ok && !badAnalyze.ok) {
    check('analyze: error message identical', badAnalyze.error.message === badApp.error.message);
    check(
      'analyze: error offsets identical',
      badAnalyze.error.selectionStart === badApp.error.selectionStart &&
        badAnalyze.error.selectionEnd === badApp.error.selectionEnd,
    );
  }
}

/* ------------------------------- summary ----------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
