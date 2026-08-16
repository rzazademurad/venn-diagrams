# Drawing Venn Diagrams for Arbitrary N-Sets

<!-- After pushing to GitHub, replace <OWNER>/<REPO> in the CI badge URL. -->
![CI](https://github.com/%3COWNER%3E/%3CREPO%3E/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-660099.svg)
![TypeScript strict](https://img.shields.io/badge/TypeScript-5.9%20strict-3178c6.svg)
![React 19](https://img.shields.io/badge/React-19-149eca.svg)
![Vite 7](https://img.shields.io/badge/Vite-7-646cff.svg)
![Runtime dependencies](https://img.shields.io/badge/runtime%20deps-react%20%2B%20react--dom%20only-brightgreen.svg)
![Tests](https://img.shields.io/badge/parity%20tests-213%20passing-brightgreen.svg)

**A modern client-side formal-logic visualizer that bridges compiler
construction and computational geometry.** Type any propositional formula —
the application compiles it (shunting-yard AST parsing), evaluates its full
truth table, and draws the Venn diagram for an *arbitrary* number of sets,
entirely in the browser. No server, no external geometry or diagram
libraries: every algorithm — lexing, parsing, curve construction, the
bijective region↔row mapping, flood-fill rasterization — is implemented from
first principles in strict TypeScript.

```
A & B + C | D -> !E <-> F        →   64-row truth table + 6-set Venn diagram
A & B & C & D & E & F & G & H    →   256 regions, auto-zoomed until every region is visible
```

All geometry runs in a Web Worker, rendering is tiled to escape browser
canvas limits, and the truth table is virtualized to handle $2^{16}$ rows.

---

## The geometric challenge (N ≥ 4)

A Venn diagram on $N$ sets must show **all** $2^N$ possible intersection
regions (one per truth-table row, counting the exterior). Circles stop being
able to do this at four sets. Two distinct circles intersect in at most two
points, so the $k$-th circle is cut by the previous $k-1$ circles into at most
$2(k-1)$ arcs — and each arc adds at most one region. Hence for $N$ circles:

$$\text{Max regions} = 2 + \sum_{k=2}^{N} 2(k-1) = N^2 - N + 2$$

For $N = 4$ this gives $14 < 16 = 2^4$: **no arrangement of four circles can
be a Venn diagram.** Symmetric constructions exist only for prime $N$; other
published layouts stop at small fixed $N$.

### Solving it inductively

The general solution (due to John Venn, and the basis of both engines here)
is **inductive**: start from the classical three-circle diagram, then add each
new set as a closed **serpentine loop** that follows the previous curve on
both sides, weaving in a band that **bisects every one of the $2^{k-1}$
existing regions** — doubling the region count to $2^k$ at every step. The
construction never terminates: a diagram exists for every $N$, and drawing it
reduces to generating the $k$-th loop programmatically.

This project implements that induction twice, as two selectable engines:

| Engine | UI toggle | Geometry | Source |
| --- | --- | --- | --- |
| **Smooth (Circular / Analytic)** | ● Circular (Smooth) | Three circles on an equilateral trefoil; set 4 is a cut annulus hugging circle 3 (whose boundary borders *all* 8 regions — the induction step made geometric); each further set is a smooth band of half the gap along the previous loop, closed with semicircular U-turn caps. Region membership is resolved **analytically** from the three circle equations plus even-odd containment tests against each polygonized loop. | `src/geometry/SmoothConstruction.ts` |
| **Rectilinear (Discretized)** | ▢ Square (Rectilinear) | Directional state-machine curves on a square layout: three squares (side $3d$, displacement $d = \lfloor \text{width}/8 \rfloor$), then inductive serpentine loops drawn by an up/down/left/right state machine with start/end cases, the displacement halving per curve. Very compact at high $N$; reproduces the exact geometry of the original 2016 implementation. | `src/geometry/VennsConstruction.ts` |

Both engines fill the same regions from the same truth table — switching
engines changes the geometry, never the meaning.

---

## Algorithmic core

### 1. Lexer & parser — `src/logic/`

The formula pipeline is a classical two-stage compiler front end:

- **Scanner** (`Scanner.ts`) tokenizes propositions `A–Z`, constants `1`/`0`
  (universal/empty set), and multi-character connectives, with
  **character-offset error diagnostics** — `Missing connective at position 2`,
  `Illegal symbol from positions 3 to 5` — that drive exact selection
  highlighting in the UI, live as you type.
- **Parser** (`Parser.ts`) validates pairwise token adjacency, then applies
  **Dijkstra's shunting-yard algorithm** to produce the postfix (RPN) stream
  evaluated per truth-table row.

Operator precedence, exactly as the engine implements it (higher binds
tighter; `→` is right-associative):

| Operator | Symbols | Precedence |
| --- | --- | --- |
| Negation ¬ | `~` `!` | 6 |
| Conjunction ∧ | `&` `^` | 5 |
| Inclusive disjunction ∨ | `\|` | 4 |
| Conditional → | `=>` `->` | 3 (right-assoc.) |
| Exclusive disjunction ⊕ | `+` | 2 |
| Biconditional ↔ | `<=>` `<->` | 2 |

> **Note.** ⊕ and ↔ are tied *below* the conditional, so `A + B => C` parses
> as `A + (B => C)`. This matches the reference implementation bit-for-bit —
> truth-table parity with it is the project's compatibility contract.

- **Truth table** (`TruthTable.ts`) evaluates all $2^N$ rows, detects the
  **main connective column**, and classifies every statement as *Tautology*,
  *Contradiction*, *Identity* or *Conditional*. Row order and the reverse-order
  `values` string (`values[0]` = the all-true row = the innermost region) are
  preserved exactly, because the geometric mapping depends on them.

### 2. Bijective spatial mapper — `src/geometry/Mapper.ts`

A constructive **bijection between truth-table rows and diagram regions**
that holds for every $N$:

- Drawing the $N$-th loop leaves an ordered trail of boundary points (the
  edges of the last serpentine). For each 4-point group — taken alternately in
  forward and reverse order — the mapper derives **pairs of seed points
  projected on either side of the boundary** (offset along the local normal),
  plus averaged midpoints, and distributes them into four lists corresponding
  to the diagram's **quadrant sectors** (each quarter of the truth table lands
  in one sector of the diagram).
- Each list is then **folded $\log_2 M$ times** — repeatedly pairing entries
  from the `front` and `end` pointers inward — and flattened, yielding
  `finalList`, where **index $i$ is the interior seed pixel of the region for
  truth-table row $i$**. Row $i$ true ⇒ flood-fill `finalList[i]`.
- For $N \le 3$, and for every $N$ in the smooth engine, seeds are produced
  directly (displacement-relative points, or the analytic region→row map),
  preserving the same bijection.

The same map powers the interactive layer in reverse: hovering any pixel of
the diagram reports its **minterm** ($5)\ A \land \lnot B \land C \to T$) and
highlights the corresponding table row.

### 3. Off-thread rasterization — `src/worker/`, `src/renderer/`

- **Everything geometric runs in a Web Worker** (`vennWorker.ts` hosts the
  complete engine): construction, mapping, filling, auto-zoom. The main thread
  stays at interactive frame rates during multi-second 10-set constructs, and
  a runaway job is cancellable (terminate → respawn → state restore).
- **Iterative flood fill** (`FloodFill.ts`): an **explicit-stack, 4-way
  iterative fill over a 32-bit `Uint32Array`** view of the pixel buffer — no
  recursion, no call-stack growth at any region size, verified by test.
- **Single-swap rendering:** the visible canvas changes exactly **once** per
  job. Intermediate auto-zoom rungs are narrated in a progress pill (with the
  live working-buffer size) but never flashed to the screen.
- **Tiled renderer** (`CanvasRenderer.ts`): browsers *silently blank* any
  canvas above an area cap (Chromium: $2^{28} \approx 268$ Mpx). Deep-zoomed
  diagrams would disappear into this. The buffer is blitted into ≤4096² tiles
  — only viewport-intersecting tiles draw per frame — with a
  `devicePixelRatio`-crisp backing store and a platform memory budget
  (268 Mpx desktop / 64 Mpx mobile).
- **Zoom is semantic, not optical**: zooming *re-runs the construction on a
  larger buffer* ($\text{width} \mathrel{+}= \text{ZOOM}$;
  $\text{ZOOM} \mathrel{+}= \text{ZOOMFACTOR}{+}{+}$), so curves stay 1-px
  crisp and new pixels appear *between* them. The UI layers instant
  view-space zoom on top and re-crisps in a single batched worker job once the
  user settles. When a construct leaves regions with no interior pixels, the
  engine **auto-zooms** — re-constructing at growing sizes until every region
  is fillable.

---

## Key features

- **Interactive viewport** — wheel / pinch / keyboard zoom with
  delta-proportional gain ($e^{-\Delta y \cdot k}$, trackpad-safe), drag pan,
  minimap with viewport rectangle, off-screen recovery, high-DPI rendering.
- **Virtualized truth table** — $2^{16}$-row tables scroll smoothly; main
  connective detection and highlighting, row numbers, alternating colors,
  T/F ↔ 1/0 display modes, row/column step-through evaluation, search by row
  number or truth pattern (`TFTF…`), tautology/contradiction classification.
- **Region ↔ row linking** — hover any region for its minterm; click to
  select and scroll the table; `[` / `]` walk regions from the keyboard.
- **View modes** — *Fills* (regions where the statement is true, classic
  orange) and *Sets* (each region tinted by its member sets, golden-angle
  palette, click a legend chip to solo one set).
- **Construction replay** — animates the inductive construction curve by
  curve.
- **Export suite** — PNG (full-resolution / 4096 px / 2048 px), vector SVG
  re-built from the recorded stroke ops, and the truth table as **CSV,
  Markdown, LaTeX tabular markup, or plain text**.
- **Shareable links** — the URL hash reproduces statement + display options.
- **Dark mode, full keyboard access, reduced-motion support.**

---

## Quickstart

```bash
git clone <repo-url>
cd venn-diagrams
npm install

npm run dev            # Vite dev server → http://localhost:5173
npm test               # 213-assertion engine parity suite (Node, no browser)
npm run build          # type-check (tsc -b, strict) + production build → dist/
npm run preview        # serve the production build

# optional
npm run bench          # engine benchmark: construct + zoom timings for n = 5…10
npm run e2e            # full-app E2E suite (headless Chromium against dist/)
npm run build:single   # self-contained single-file build (inline worker)
```

Requirements: Node ≥ 20 and any evergreen browser (Web Workers + ES2022).
Runtime dependencies are **react + react-dom only** — all parsing, geometry
and rasterization is first-party code.

### Formula syntax

Propositions `A`–`Z` · constants `1` (universal) / `0` (empty) · operators
`~` `!` `&` `^` `|` `+` `=>` `->` `<=>` `<->` · parentheses. Input is
case-insensitive and re-formatted canonically (`a&b` → `A & B`).

---

## Project structure

```
src/
├── logic/            Scanner, Parser (shunting-yard), TruthTable, tokens
├── geometry/         SmoothConstruction (analytic circular engine),
│                     VennsConstruction (rectilinear discretized engine),
│                     Mapper (quadrant-folding bijection)
├── renderer/         Raster (Bresenham strokes + vector op log), FloodFill (iterative),
│                     CanvasRenderer (tiled), overlays (Sets view mode)
├── worker/           vennWorker — the complete engine, off the main thread
├── app/              MainInterface (pipeline orchestration), analyze (instant table),
│                     DiagramMirror + snapshot (worker ⇄ UI transfer protocol), share links
├── exports/          CSV / Markdown / LaTeX / plain-text builders, PNG/SVG download
├── hooks/            useVennWorker (job queue, cancel), useViewport (pan/zoom/re-crisp),
│                     useTheme, useShareLink
└── components/       App shell, FormulaBar, VennCanvas, TruthTablePanel, HelpModal
scripts/
├── parity-tests.ts   213 assertions: logic + geometry parity with the reference engine
├── run-tests.mjs     test runner (esbuild bundle → Node)
├── run-bench.mjs     benchmark runner
├── inline-single-file.mjs   single-file build packer
└── dev/              verify-app (E2E), verify-stress, verify-tiles, verify-standalone,
                      bench, gen-logo (draws the app logo with the engine itself)
```

### Verification

`npm test` asserts parity with the reference engine: scanner error offsets,
postfix streams, truth-table row strings, evaluation classification,
structural geometry for both engines ($N \le 7$ region distinctness, full
coverage), auto-zoom behavior at $N = 10$, flood-fill invariants, export
golden samples. `npm run e2e` drives the production build in headless
Chromium: construct, single-swap rendering, one-swap zoom re-crisp, cancel &
respawn, view modes, search, replay, exports, dark mode — with zero tolerated
console errors. The tiled renderer is separately verified at 269 Mpx — past
the size where a single canvas silently blanks.

---

## Academic provenance & attribution

This repository is a TypeScript re-implementation and extension of the
following work:

- **Murad Rzazade** (2016). *Drawing Venn Diagrams for Arbitrary N-Sets*.
  BSc Project Report, School of Computer Science, **University of
  Manchester**. Supervised by **Dr. Ian Pratt-Hartmann**. — Contributed the
  arbitrary-$N$ drawing algorithm, the quadrant-folding truth-table↔region
  mapper, the buffer-growth zoom model, and the flood-fill integration. This
  port adds the smooth analytic engine, the Web Worker / tiled-canvas
  architecture, and the interactive analysis layer.
- **Brian S. Borowski** (2011). *Truth Table Constructor* —
  brian-borowski.com. The foundational open-source Java truth-table routines
  (scanner, parser, evaluator) that the 2016 project built upon and this
  repository re-implements in TypeScript, preserving their error-reporting
  semantics.

The inductive $N$-set construction both engines implement is John Venn's;
the two geometric realizations and all code in this repository are original.

## License

[MIT](LICENSE) © 2016–2026 Murad Rzazade
