// How often each solver layer is needed, and how many random boards are no-guess.
// Usage: node scripts/layers.ts [boards]
import { counts, neighbours, place, rng, safeZone } from '../src/board.ts';
import { PRESETS } from '../src/game.ts';
import { analyse, HIDDEN, type Kind } from '../src/solver.ts';

const N = Number(process.argv[2] ?? 1000);
for (const [name, size] of Object.entries(PRESETS)) {
  const rand = rng(42);
  const { w, h } = size;
  const nb = neighbours(w, h);
  let solved = 0, overBudget = 0;
  const stuckAt: number[] = [];
  const kinds: Record<Kind, number> = { single: 0, pair: 0, enum: 0, count: 0 };
  let needEnum = 0;
  let ms = 0;
  for (let b = 0; b < N; b++) {
    const start = Math.floor(h / 2) * w + Math.floor(w / 2);
    const mines = place(size, safeZone(size, start), rand);
    const c = counts(w, h, mines);
    const view = new Int8Array(w * h).fill(HIDDEN);
    let left = w * h - size.mines;
    const open = (cell: number) => {
      const st = [cell];
      while (st.length) { const k = st.pop()!; if (view[k] !== HIDDEN) continue; view[k] = c[k]; left--; if (!c[k]) st.push(...nb[k]); }
    };
    open(start);
    let usedEnum = false;
    const t = performance.now();
    while (left > 0) {
      const a = analyse({ ...size, view }, { stopEarly: true });
      const safe = a.moves.filter((m) => !m.mine && view[m.cell] === HIDDEN);
      if (!safe.length) {
        if (!analyse({ ...size, view }, { prob: true }).prob) overBudget++;
        stuckAt.push(1 - left / (w * h - size.mines));
        break;
      }
      for (const m of safe) { kinds[m.kind]++; if (m.kind === 'enum' || m.kind === 'count') usedEnum = true; open(m.cell); }
    }
    ms += performance.now() - t;
    if (left === 0) { solved++; if (usedEnum) needEnum++; }
  }
  const total = Object.values(kinds).reduce((a, b) => a + b, 0);
  const pct = (x: number) => ((x / total) * 100).toFixed(1) + '%';
  stuckAt.sort((a, b) => a - b);
  console.log(`${name}: ${solved}/${N} random boards are no-guess (${((solved / N) * 100).toFixed(1)}%); ` +
    `${needEnum} of those need enumeration; ${overBudget} stalls hit the budget; median stall at ${((stuckAt[stuckAt.length >> 1] ?? 0) * 100).toFixed(0)}% cleared; ` +
    `${(ms / N).toFixed(2)} ms per board`);
  console.log(`  safe cells found by: single ${pct(kinds.single)}, pair ${pct(kinds.pair)}, enum ${pct(kinds.enum)}, count ${pct(kinds.count)}`);
}
