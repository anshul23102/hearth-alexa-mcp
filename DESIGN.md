# Design

<!-- Records the built visual world for the Hearth simulator and its MCP App view. -->

## World
A kitchen-counter display with a **thermal receipt printer** beside it. The product is a household ledger, so
answers literally print as receipts. Use scene: evening kitchen, glanceable from a few feet, hands busy.

## Color (drenched, one hot ink)
- Ground `#2236d9` cobalt, with a 7% noise grain so it reads as material, not a flat fill. Deep wells `#070f5c`.
- Receipt paper `#f3f6f8` (cool thermal white, deliberately not cream). Ink `#0c1230`.
- Thermal red `#cc2512` on paper / `#ff5a43` on cobalt: used only for overdue, recall and listening states.
- Secondary text on cobalt `#c9d3ff` (5.5:1); input placeholder `#d4dcff` (6.0:1); alert bar uses ink text on `#ff5a43` (5.9:1). All text pairs were computed against WCAG 4.5:1.

## Type
- Display: **Bricolage Grotesque** 700, tight tracking, for Alexa's spoken line and receipt headlines.
- Data: **Martian Mono** 400/600 for receipt lines, prices, the MCP wire. Mono is used because the content is
  measurement and protocol traffic, as on a real receipt.
- Self-hosted woff2 in `web/fonts/` (no network needed).

## Components
- **Light bar**: five segments, our own motif; states idle / thinking (sweep) / speaking (pulse) / listening (red).
- **Printer**: dark slot with LED; sheets feed in from the slot, newest on top, older sheets dimmed.
- **Slip**: paper with a torn bottom edge (conic-gradient mask), dotted leaders between item and price, a
  "print-in" reveal line by line. Buttons are hard-offset-shadow blocks that press flat.
- **Label-tape chips** for suggestions (notched left edge).
- **Range bar** per runway item: dotted 0-45 day track, ticks at today/7/14/30, whisker = likely window,
  dot = estimate. Red when due within a week or overdue.
- **Alert bar** (thermal red, drops in above the light bar): appears only when the server pushes a new recall alert.
- **Stamp** for recall match level: solid = likely, dashed = possible.
- **MCP wire** drawer: monospace JSON-RPC trace, direction-coded.

## Rules
- Never nest cards; one slip per answer. No gradient text, no side-stripe borders, no decorative glass.
- Motion is "paper feeds from the slot" plus the light bar; everything else is state change. All of it is off under
  `prefers-reduced-motion`.
- Spoken line is 1-2 sentences; detail lives on the slip.
- Every control has a visible focus ring (`outline: 3px`), and the card view works at phone width.
