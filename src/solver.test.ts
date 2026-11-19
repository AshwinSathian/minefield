import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, HIDDEN, type Position } from './solver.ts';
import { counts, neighbours, place, rng, bbbv, pack, unpack } from './board.ts';

/** Reveal `cell` like the game does: zeros flood outward. */
function open(view: Int8Array, c: Uint8Array, w: number, h: number, cell: number) {
  const nb = neighbours(w, h);
  const stack = [cell];
  while (stack.length) {
    const k = stack.pop()!;
    if (view[k] !== HIDDEN) continue;
    view[k] = c[k];
    if (c[k] === 0) stack.push(...nb[k]);
  }
}

/** Every placement of the remaining mines over the hidden cells that agrees with every number. */
function brute(pos: Position): Float64Array | null {
  const { w, h, view, mines } = pos;
  const nb = neighbours(w, h);
  const hidden = [...view.keys()].filter((i) => view[i] === HIDDEN);
  const hits = new Float64Array(w * h);
  let total = 0;
  const pick: number[] = [];
  const isMine = new Uint8Array(w * h);
  const check = () => {
    for (let i = 0; i < w * h; i++) {
      if (view[i] < 0) continue;
      let m = 0;
      for (const j of nb[i]) m += isMine[j];
      if (m !== view[i]) return false;
    }
    return true;
  };
  const rec = (from: number) => {
    if (pick.length === mines) {
      if (check()) { total++; for (const j of pick) hits[j]++; }
      return;
    }
    for (let t = from; t <= hidden.length - (mines - pick.length); t++) {
      pick.push(hidden[t]); isMine[hidden[t]] = 1;
      rec(t + 1);
      pick.pop(); isMine[hidden[t]] = 0;
    }
  };
  rec(0);
  if (!total) return null;
  return hits.map((x) => x / total);
}

test('probabilities and certainties match brute force', () => {
  const rand = rng(7);
  let checked = 0;
  for (let round = 0; round < 400; round++) {
    const w = 5 + Math.floor(rand() * 3), h = 5, M = 4 + Math.floor(rand() * 5);
    const mines = place({ w, h, mines: M }, [], rand);
    const c = counts(w, h, mines);
    const view = new Int8Array(w * h).fill(HIDDEN);
    const safe = [...mines.keys()].filter((i) => !mines[i]);
    const reveals = 1 + Math.floor(rand() * 4);
    for (let r = 0; r < reveals; r++) open(view, c, w, h, safe[Math.floor(rand() * safe.length)]);
    const pos = { w, h, mines: M, view };
    const hiddenCount = view.filter((v) => v === HIDDEN).length;
    if (hiddenCount > 22) continue;
    const want = brute(pos)!;
    const got = analyse(pos, { prob: true });
    assert.ok(got.prob, 'enumeration ran');
    for (let i = 0; i < w * h; i++) {
      if (view[i] !== HIDDEN) continue;
      assert.ok(Math.abs(got.prob![i] - want[i]) < 1e-9, `cell ${i}: ${got.prob![i]} vs ${want[i]}`);
      const fate = want[i] === 0 ? 1 : want[i] === 1 ? 2 : 0;
      assert.equal(got.fate[i], fate, `fate of cell ${i}`);
    }
    checked++;
  }
  assert.ok(checked > 150, `only ${checked} positions checked`);
});

test('a single 1 with one hidden neighbour is a mine, by the single rule', () => {
  // 3x3 corner: reveal everything except one cell next to a 1.
  const w = 5, h = 5;
  const mines = new Uint8Array(25); mines[0] = 1;
  const c = counts(w, h, mines);
  const view = new Int8Array(25).fill(HIDDEN);
  open(view, c, w, h, 24);
  const a = analyse({ w, h, mines: 1, view });
  assert.equal(a.fate[0], 2);
  assert.equal(a.moves[0].kind, 'single');
});

test('3BV of a known board', () => {
  // One mine in the corner of a 3x3-free 5x5: one opening covers every safe cell.
  const mines = new Uint8Array(25); mines[0] = 1;
  assert.equal(bbbv(5, 5, mines), 1);
  // Mines down the middle column split the board: each side is its own opening, but the numbered
  // column cells beside the mines are reached by those openings, so 2 total.
  const m2 = new Uint8Array(25); for (let y = 0; y < 5; y++) m2[y * 5 + 2] = 1;
  assert.equal(bbbv(5, 5, m2), 2);
});

test('share codec round-trips and rejects junk', () => {
  const mines = place({ w: 30, h: 16, mines: 99 }, [17], rng(3));
  const code = pack({ w: 30, h: 16, start: 17, mines });
  const back = unpack(code)!;
  assert.deepEqual([back.w, back.h, back.start], [30, 16, 17]);
  assert.deepEqual(back.mines, mines);
  assert.equal(unpack('nope'), null);
  assert.equal(unpack(code.slice(0, -3)), null);
});

test('dealt no-guess boards are cleared by hints alone through the game rules', async () => {
  const { deal } = await import('./gen.ts');
  const { Game, PRESETS } = await import('./game.ts');
  const rand = rng(11);
  for (const size of [PRESETS.beginner, PRESETS.intermediate, PRESETS.expert]) {
    for (let k = 0; k < 15; k++) {
      const start = Math.floor(rand() * size.w * size.h);
      const d = deal(size, start, rand, true);
      assert.ok(d.noGuess);
      const g = new Game('expert', size, true);
      g.begin(d.mines, start, false);
      g.reveal(start);
      for (let steps = 0; g.status === 'playing'; steps++) {
        assert.ok(steps < 2000, 'stalled');
        const h = g.hint(null);
        assert.ok(h.type === 'safe' || h.type === 'mine', `hint was ${h.type}`);
        if (h.type === 'safe') g.reveal(h.cell); else g.toggleFlag(h.cell);
      }
      assert.equal(g.status, 'won');
    }
  }
});

test('take back after a loss restores the position and marks the game assisted', async () => {
  const { Game } = await import('./game.ts');
  const mines = new Uint8Array(25); mines[0] = 1; mines[24] = 1;
  const g = new Game('custom', { w: 5, h: 5, mines: 2 }, false);
  g.begin(mines, 1, false);
  g.reveal(1);
  assert.equal(g.status, 'playing');
  g.reveal(24);
  assert.equal(g.status, 'lost');
  const r = g.review()!;
  assert.equal(r.verdict, 'guess');
  assert.ok(g.takeBack());
  assert.equal(g.status, 'playing');
  assert.equal(g.view[24], HIDDEN);
  assert.ok(g.assisted);
});
