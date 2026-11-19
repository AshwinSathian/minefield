# Minefield: plan

Minesweeper for the browser. Live at minefield.ashwinsathian.com. Built to be played on a phone, a tablet and a desktop, and to load in one request.

## What makes it different

1. **No-guess boards, proven.** With "No guessing" on (the default), a board is only dealt after the solver has cleared it from your first click without a single guess. The check uses the same solver as hints, so the guarantee is exactly as strong as the solver.
2. **An exact solver.** Three layers, cheapest first:
   - single-number rules (a 1 with one hidden neighbour),
   - pair rules (one number's cells are a subset of, or overlap, another's),
   - full enumeration of every mine arrangement on each frontier component, combined across components and weighted by how many ways the leftover mines fit in the unexplored interior (log-binomial weights, so large boards don't overflow). This gives exact mine probabilities and uses the global mine count.
3. **Hints that explain themselves.** A hint shows one certain move and the numbers that force it, in one sentence.
4. **Odds lens.** Toggle a heat overlay of the exact mine probability of every hidden cell.
5. **Loss review.** After a loss the game says whether a safe move was available (and shows it) or whether you were forced to guess, with the odds you had. You can take the click back; the game is then marked assisted.
6. **Daily board.** One no-guess Expert board per UTC day, the same for everyone, with a fixed start cell. Result can be shared as text.
7. **Shareable boards.** Any board can be sent as a link: the exact mine layout and start cell packed into the URL hash.
8. **Competitive stats.** 3BV, 3BV/s, clicks and efficiency on every finish; per-mode best times, win rate and streaks.

## Engineering

- Vite + TypeScript, no runtime dependencies. The page is one inlined HTML file served from Cloudflare's edge (static assets on Workers). No web fonts: system rounded face (SF Pro Rounded on Apple), so nothing blocks first paint.
- Board generation runs in an inline Web Worker, so dealing a no-guess Expert board never blocks input.
- Seeded PRNG (sfc32) keeps the daily board and generator deterministic and testable.
- Game state lives in typed arrays. The DOM board is one grid with event delegation; only changed cells are touched per move. Reveal cascades animate by BFS distance through a CSS custom property, so there's no JS animation loop.
- Board orientation follows the screen: a 30×16 board turns to 16×30 on a portrait phone. Logic stays in board coordinates; only the view transposes.
- In-progress games are saved after every move and resume on reload. The timer pauses when the tab is hidden.
- PWA: service worker and manifest, so it installs and plays offline.

## Input

- Mouse: left reveals, right flags, clicking a satisfied number opens its neighbours (chord).
- Touch: tap uses the current tool (Dig or Flag, thumb switch at the bottom), long-press uses the other one with a haptic tick. Tap a number to chord. Pinch to zoom on big boards; the board scrolls natively.
- Keyboard: arrows move, Space/Enter dig or chord, F flags, H hint, N new game, U undo after a loss.
- Screen readers: the board is an ARIA grid with one tab stop (aria-activedescendant), cells labelled by row, column and state; results go to a live region.

## Modes

Beginner 9×9 / 10, Intermediate 16×16 / 40, Expert 30×16 / 99, Custom (up to 60×40), Daily. "No guessing" applies to all but Daily, which is always no-guess.

## Look

A field-survey sheet. Warm paper in light mode, graphite in dark. Raised tiles for hidden cells, flat recessed paper once open. One accent: survey-marker vermilion for flags and the start ring. Number colours tuned per theme and also told apart by weight, so they don't rely on hue alone. Motion respects reduced-motion.

## Verification

- `node --test`: solver probabilities match brute-force enumeration on random small positions; no-guess boards are re-solved independently; 3BV and the board codec round-trip.
- Playwright: screenshots at phone, phone landscape, tablet, desktop in both themes; a scripted full game won by the solver through the real UI; console errors checked.
- Design review with loupe from the screenshots.

## Out of scope

Online leaderboards (Coil has one; this game stays backend-free), question-mark flags, skins.
