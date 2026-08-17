# Drawing Venn Diagrams for Arbitrary N-Sets

[![CI](https://github.com/rzazademurad/venn-diagrams/actions/workflows/ci.yml/badge.svg)](https://github.com/rzazademurad/venn-diagrams/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Type a propositional formula and get its truth table and Venn diagram, for any
number of sets. Runs entirely in the browser; the only runtime dependencies
are react and react-dom.

Classical circles cannot construct Venn diagrams for $N \ge 4$ sets because
$N$ circles produce at most $N^2 - N + 2$ regions (14 regions for 4 circles,
failing the required $2^4 = 16$). This project implements John Venn's
inductive serpentine construction to generate and fill all $2^N$ regions for
arbitrary $N$ — see [Geometry engines](#geometry-engines).

**Live demo:** https://rzazademurad.github.io/venn-diagrams/

![Application screenshot: an 8-set diagram next to its 128-row truth table](UI.png)

## Usage

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm test           # parity test suite (Node, no browser needed)
npm run build      # type-check + production build to dist/
```

Other scripts: `preview`, `test:watch`, `bench`, `e2e`, `build:single`
(self-contained single-file build). Requires Node 20 or later.

### Formula syntax

Propositions `A`–`Z`, constants `1` (universal set) and `0` (empty set),
parentheses, and the following operators. Input is case-insensitive and
reformatted canonically (`a&b` becomes `A & B`).

| Operator | Meaning | Precedence |
| --- | --- | --- |
| `~` `!` | negation | 6 |
| `&` `^` | conjunction | 5 |
| `\|` | disjunction | 4 |
| `=>` `->` | conditional (right-assoc.) | 3 |
| `+` | exclusive or | 2 |
| `<=>` `<->` | biconditional | 2 |

Note that `+` and `<=>` bind below the conditional, so `A + B => C` parses as
`A + (B => C)`. This matches the reference implementation, which the test
suite checks against.

## Geometry engines

Venn's construction is inductive: start from the classical three-set diagram,
then add each set as a closed serpentine loop that bisects every existing
region, doubling the region count. This works for every N.

The original 2016 project realized this construction in Java using a
square-based (rectilinear) layout. This port re-implements that engine in
TypeScript and adds a second, circular realization of the same induction:

| Engine | Approach | Source |
| --- | --- | --- |
| Rectilinear (original) | Squares plus serpentine loops traced by a directional state machine, displacement halving per curve. Compact at high N; same geometry as the 2016 Java implementation. | `src/geometry/VennsConstruction.ts` |
| Smooth / circular (new) | Three circles on an equilateral trefoil; set 4 is a cut annulus around circle 3; further sets are bands of half the previous gap with semicircular caps. Region membership is computed analytically. | `src/geometry/SmoothConstruction.ts` |

Both engines fill the same regions from the same truth table; the UI switches
between them live.

## What makes this project unique

Most online tools only draw 3 circles or static templates for 4 to 6 sets.
This project builds a complete, working pipeline for any number of sets
(arbitrary N):

- **Row-to-region mapping** (`src/geometry/Mapper.ts`) — a custom
  quadrant-folding algorithm that reliably maps every truth-table row (all
  2^N combinations) to the exact pixel inside its diagram region for flood
  filling, and runs in reverse for hover-to-minterm lookup.
- **Two realizations of Venn's induction** — the original 2016 rectilinear
  serpentine engine (discretized loops) and a new smooth circular engine,
  driven by the same truth table.
- **Large-set scalability** — solves tiny-region and browser memory limits
  by running all geometry off the main thread in a Web Worker, with a custom
  32-bit iterative flood fill, tiled canvas rendering, and automatic
  buffer-growth zooming so curves stay 1 px sharp.

Around the engine: two view modes (fills / per-set tinting), construction
replay, a virtualized truth table with search, PNG/SVG export, table export
to CSV/Markdown/LaTeX/text, shareable URLs, dark mode, keyboard and mobile
support.

## Project structure

```
src/
├── logic/         Scanner, Parser, TruthTable, tokens, exceptions
├── geometry/      SmoothConstruction, VennsConstruction, Mapper
├── renderer/      Raster, FloodFill, CanvasRenderer, overlays
├── worker/        vennWorker
├── app/           MainInterface, analyze, DiagramMirror, snapshot, share
├── exports/       CSV / Markdown / LaTeX / text / PNG / SVG export
├── hooks/         useVennWorker, useViewport, useTheme, useShareLink
└── components/    FormulaBar, VennCanvas, TruthTablePanel, HelpModal, ...
scripts/           test runner, benchmarks, E2E checks, single-file packer
docs/              the 2016 project report (PDF)
```

## Testing

`npm test` runs 213 assertions checking logic and geometry parity with the
reference engine; `npm run e2e` drives the production build in headless
Chromium with zero tolerated console errors.

## Background

This is a TypeScript re-implementation and extension of my 2016 BSc project:

> Murad Rzazade, *Drawing Venn Diagrams for Arbitrary N-Sets*. BSc Project
> Report, School of Computer Science, University of Manchester, 2016.
> Supervised by Dr. Ian Pratt-Hartmann.
> [Report (PDF)](docs/Murad.Rzazade_Drawing_Venn_Diagrams.pdf) ·
> [demo video of the original](https://www.youtube.com/watch?v=raVwdW5XCQ0)

The truth-table routines derive from Brian S. Borowski's open-source *Truth
Table Constructor* (2011, brian-borowski.com), which the 2016 project built
on. This port adds the smooth circular engine, the Web Worker and tiled-canvas
architecture, and the interactive analysis layer. The inductive construction
itself is John Venn's.

## License

[MIT](LICENSE) © 2016–2026 Murad Rzazade
