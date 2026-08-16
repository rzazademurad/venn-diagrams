# Drawing Venn Diagrams for Arbitrary N-Sets

![CI](https://github.com/rzazademurad/venn-diagrams/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-660099.svg)
![TypeScript strict](https://img.shields.io/badge/TypeScript-5.9%20strict-3178c6.svg)
![React 19](https://img.shields.io/badge/React-19-149eca.svg)
![Vite 7](https://img.shields.io/badge/Vite-7-646cff.svg)
![Runtime dependencies](https://img.shields.io/badge/runtime%20deps-react%20%2B%20react--dom%20only-brightgreen.svg)
![Tests](https://img.shields.io/badge/parity%20tests-213%20passing-brightgreen.svg)

### ▶️ [**Try it live — rzazademurad.github.io/venn-diagrams**](https://rzazademurad.github.io/venn-diagrams/)

No install, runs entirely in your browser. Type a formula like
[`A & B & C & D & F & G & H`](https://rzazademurad.github.io/venn-diagrams/#s=A%20%26%20B%20%26%20C%20%26%20D%20%26%20F%20%26%20G%20%26%20H)
and hit **Construct**.

---

Type a logical formula. Get its truth table and its Venn diagram — for **any**
number of sets, drawn in the browser.

```
A & B | C -> !D          →   16-row truth table + 4-set diagram
A & B & C & D & F & G & H →  128 rows, every region drawn and fillable
```

The entire pipeline is implemented from first principles: a purpose-built
compiler front end lexes, parses and evaluates the formula, and the diagram
geometry is constructed and rasterized without any external geometry or
diagramming library. The application is fully client-side, with
**react and react-dom as its only runtime dependencies**.

![The app: an 8-set diagram in Sets view beside its 128-row truth table](UI.png)

### See it in action

The original 2016 implementation, demonstrated by the author:

[![Venn Diagram application for infinite sets](https://img.youtube.com/vi/raVwdW5XCQ0/hqdefault.jpg)](https://www.youtube.com/watch?v=raVwdW5XCQ0)

**[▶ Venn Diagram application for infinite sets](https://www.youtube.com/watch?v=raVwdW5XCQ0)**

---

## Quickstart

```bash
git clone https://github.com/rzazademurad/venn-diagrams.git
cd venn-diagrams
npm install

npm run dev            # dev server → http://localhost:5173
npm test               # 213-assertion parity suite (Node, no browser)
npm run build          # strict type-check + production build → dist/
```

<details>
<summary>Other commands</summary>

```bash
npm run preview        # serve the production build
npm run test:watch     # re-run the suite on change
npm run bench          # construct + zoom timings for n = 5…10
npm run e2e            # full-app E2E suite (headless Chromium against dist/)
npm run build:single   # self-contained single-file build (inline worker)
```

</details>

Requires Node ≥ 20 and any evergreen browser (Web Workers + ES2022).

### Formula syntax

Propositions `A`–`Z` · constants `1` (universal) / `0` (empty) · parentheses ·
operators below. Input is case-insensitive and reformatted canonically
(`a&b` → `A & B`).

| Operator | Type | Precedence |
| --- | --- | --- |
| `~` `!` | Negation ¬ | 6 |
| `&` `^` | Conjunction ∧ | 5 |
| `\|` | Disjunction ∨ | 4 |
| `=>` `->` | Conditional → | 3 (right-assoc.) |
| `+` | Exclusive or ⊕ | 2 |
| `<=>` `<->` | Biconditional ↔ | 2 |

> ⊕ and ↔ bind *below* the conditional, so `A + B => C` parses as
> `A + (B => C)`. This matches the reference implementation bit-for-bit —
> truth-table parity with it is the project's compatibility contract.

---

## Features

- **Two geometry engines** — smooth circular or rectilinear, switchable live.
- **Interactive viewport** — wheel / pinch / keyboard zoom, drag pan, minimap,
  off-screen recovery, high-DPI rendering.
- **Virtualized truth table** — 2¹⁶ rows scroll smoothly; main-connective
  highlighting, T/F ↔ 1/0 modes, search by row number or pattern (`TFTF…`),
  tautology / contradiction classification.
- **Region ↔ row linking** — hover a region to see its minterm; click to select
  and scroll the table; `[` / `]` walk regions from the keyboard.
- **View modes** — *Fills* (regions where the statement is true) and *Sets*
  (each region tinted by its member sets, click a legend chip to solo a set).
- **Construction replay** — animates the inductive construction, curve by curve.
- **Exports** — PNG (full-res / 4096 / 2048), vector SVG rebuilt from recorded
  stroke ops, and the table as CSV, Markdown, LaTeX or plain text.
- **Shareable links** — the URL hash reproduces statement and display options.
- **Dark mode, full keyboard access, reduced-motion support.**

---

## How it works

### The problem: circles fail at four sets

A Venn diagram on *N* sets must show **all** 2^*N* intersection regions. Two
circles meet in at most two points, so *N* circles bound at most
*N*² − *N* + 2 regions. At *N* = 4 that gives 14 < 16 — **no arrangement of four
circles is a Venn diagram.** Symmetric constructions exist only for prime *N*,
and published layouts stop at small fixed *N*.

### The solution: build it inductively

Venn's own answer generalizes. Start from the classical three-circle diagram,
then add each new set as a closed **serpentine loop** that weaves through a band
bisecting *every one* of the existing regions — doubling the region count at
each step. The induction never terminates, so a diagram exists for every *N*,
and drawing one reduces to generating the *k*-th loop programmatically.

This project implements that induction twice:

| Engine | Geometry | Source |
| --- | --- | --- |
| **Smooth** (circular) | Three circles on an equilateral trefoil; set 4 is a cut annulus hugging circle 3, whose boundary borders all 8 regions. Each further set is a smooth band of half the previous gap, closed with semicircular caps. Region membership resolved **analytically** from the circle equations plus even-odd containment tests. | `src/geometry/SmoothConstruction.ts` |
| **Rectilinear** (discretized) | Three squares, then serpentine loops traced by an up/down/left/right state machine, displacement halving per curve. Very compact at high *N*; reproduces the exact geometry of the original 2016 implementation. | `src/geometry/VennsConstruction.ts` |

Both fill the same regions from the same truth table — switching engines changes
the geometry, never the meaning.

### The pipeline

**1 · Compile the formula** (`src/logic/`) — `Scanner.ts` tokenizes with
character-offset diagnostics (*"Missing connective at position 2"*) that drive
live error highlighting as you type. `Parser.ts` validates token adjacency and
applies **Dijkstra's shunting-yard algorithm** to emit postfix. `TruthTable.ts`
evaluates all 2^*N* rows, detects the main connective column, and classifies the
statement.

**2 · Map rows to regions** (`src/geometry/Mapper.ts`) — the constructive
**bijection** that makes arbitrary *N* work. Drawing the *N*-th loop leaves an
ordered trail of boundary points; the mapper derives seed points on either side
of the boundary, distributes them into the diagram's quadrant sectors, then
**folds each list log₂ M times** — pairing entries inward from both ends. The
result: index *i* is the interior seed pixel of the region for truth-table row
*i*. Row *i* true ⇒ flood-fill that pixel. The same map runs in reverse for
hover-to-minterm lookups.

**3 · Rasterize off-thread** (`src/worker/`, `src/renderer/`) —

- **All geometry runs in a Web Worker**, so the main thread stays interactive
  during multi-second 10-set constructions, and runaway jobs are cancellable.
- **Iterative flood fill** over a 32-bit view of the pixel buffer — explicit
  stack, no recursion, no call-stack growth at any region size.
- **Tiled rendering** — browsers silently blank canvases past ~268 Mpx, so the
  buffer is blitted into ≤4096² tiles, drawing only what intersects the viewport.
- **Zoom is semantic, not optical** — zooming *re-runs the construction on a
  larger buffer*, so curves stay 1px crisp and new pixels appear *between* them.
  When regions come out too small to fill, the engine **auto-zooms** until every
  region is fillable. The visible canvas swaps exactly once per job.

---

## Project structure

```
src/
├── App.tsx, main.tsx, index.css   app shell and entry point
├── logic/         Scanner, Parser (shunting-yard), TruthTable, TruthValue,
│                  tokens, exceptions
├── geometry/      SmoothConstruction (analytic), VennsConstruction (rectilinear),
│                  Mapper (quadrant-folding bijection)
├── renderer/      Raster (Bresenham strokes + vector op log), FloodFill,
│                  CanvasRenderer (tiled), overlays (Sets view)
├── worker/        vennWorker — the complete engine, off the main thread
├── app/           MainInterface (orchestration), analyze (instant table),
│                  DiagramMirror + snapshot (worker ⇄ UI protocol), share
├── exports/       exporters — CSV / Markdown / LaTeX / text / PNG / SVG
├── hooks/         useVennWorker (job queue, cancel), useViewport (pan/zoom),
│                  useTheme, useShareLink
└── components/    FormulaBar, VennCanvas, TruthTablePanel, HelpModal,
                   LogoMark, ErrorBoundary

scripts/
├── parity-tests.ts          213 assertions vs. the reference engine
├── run-tests.mjs            test runner (esbuild bundle → Node)
├── run-bench.mjs            benchmark runner
├── inline-single-file.mjs   single-file build packer
└── dev/                     verify-app (E2E), verify-stress, verify-tiles,
                             verify-standalone, bench, gen-logo

docs/
└── Murad.Rzazade_Drawing_Venn_Diagrams.pdf   the 2016 BSc project report
```

### Verification

`npm test` asserts parity with the reference engine: scanner error offsets,
postfix streams, truth-table row strings, classification, structural geometry
for both engines (*N* ≤ 7 region distinctness and coverage), auto-zoom at
*N* = 10, flood-fill invariants, and export golden samples.

`npm run e2e` drives the production build in headless Chromium — construct,
single-swap rendering, zoom re-crisp, cancel and respawn, view modes, search,
replay, exports, dark mode — tolerating zero console errors. The tiled renderer
is separately verified at 269 Mpx, past the point where a single canvas blanks.

---

## Academic provenance & attribution

This repository is a TypeScript re-implementation and extension of:

- **Murad Rzazade** (2016). *Drawing Venn Diagrams for Arbitrary N-Sets.*
  BSc Project Report, School of Computer Science, **University of Manchester**.
  Supervised by **Dr. Ian Pratt-Hartmann**. Contributed the arbitrary-*N*
  drawing algorithm, the quadrant-folding mapper, the buffer-growth zoom model
  and the flood-fill integration. ([report](docs/Murad.Rzazade_Drawing_Venn_Diagrams.pdf) ·
  [demo video](https://www.youtube.com/watch?v=raVwdW5XCQ0))
- **Brian S. Borowski** (2011). *Truth Table Constructor* — brian-borowski.com.
  The foundational open-source Java truth-table routines (scanner, parser,
  evaluator) that the 2016 project built upon and this repository
  re-implements in TypeScript, preserving their error-reporting semantics.

This port adds the smooth analytic engine, the Web Worker and tiled-canvas
architecture, and the interactive analysis layer.

The inductive *N*-set construction both engines implement is John Venn's; the
two geometric realizations and all code in this repository are original.

## License

[MIT](LICENSE) © 2016–2026 Murad Rzazade
