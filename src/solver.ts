// The solver. Given what a player can see, it finds every cell that is certainly safe or certainly a mine,
// and the exact mine probability of every hidden cell. Flags are ignored: the solver trusts only numbers.
//
// Layers, cheapest first:
//   single  one number decides all its hidden neighbours
//   pair    two overlapping numbers decide the cells only one of them touches
//   enum    every mine arrangement on a frontier component is counted, components are combined, and the
//           leftover mines are spread over the unexplored interior. Weights are log-binomials, so this is
//           exact for any board size. Certainty is decided from which totals are feasible, never from floats.

import { neighbours } from './board.ts';

export const HIDDEN = -1;

export interface Position {
  w: number;
  h: number;
  mines: number;
  /** -1 hidden, 0..8 revealed number. */
  view: Int8Array;
}

export type Kind = 'single' | 'pair' | 'enum' | 'count';

export interface Move {
  cell: number;
  mine: boolean;
  kind: Kind;
  /** Revealed numbers that force this move. */
  because: number[];
}

export interface Analysis {
  /** 0 unknown, 1 certainly safe, 2 certainly mine; only meaningful for hidden cells. */
  fate: Uint8Array;
  /** One entry per certain cell, cheapest reason first. */
  moves: Move[];
  /** Mine probability per hidden cell, or null if enumeration was skipped or ran over budget. */
  prob: Float64Array | null;
}

const SAFE = 1, MINE = 2;
const BUDGET = 400_000;

interface Constraint { cells: number[]; need: number; src: number }

export function analyse(pos: Position, opts: { prob?: boolean; stopEarly?: boolean } = {}): Analysis {
  const { w, h, view } = pos;
  const n = w * h;
  const nb = neighbours(w, h);
  const fate = new Uint8Array(n);
  const moves: Move[] = [];

  const decide = (cell: number, f: number, kind: Kind, because: number[]) => {
    if (fate[cell]) return;
    fate[cell] = f;
    moves.push({ cell, mine: f === MINE, kind, because });
  };

  const build = (): Constraint[] => {
    const out: Constraint[] = [];
    for (let i = 0; i < n; i++) {
      const v = view[i];
      if (v <= 0) continue;
      let need = v;
      const cells: number[] = [];
      for (const j of nb[i]) {
        if (view[j] !== HIDDEN) continue;
        if (fate[j] === MINE) need--;
        else if (fate[j] !== SAFE) cells.push(j);
      }
      if (cells.length) out.push({ cells, need, src: i });
    }
    return out;
  };

  // Local rules to a fixpoint.
  for (;;) {
    const cs = build();
    let found = false;
    for (const c of cs) {
      if (c.need === 0) for (const j of c.cells) { decide(j, SAFE, 'single', [c.src]); found = true; }
      else if (c.need === c.cells.length) for (const j of c.cells) { decide(j, MINE, 'single', [c.src]); found = true; }
    }
    if (found) { if (opts.stopEarly && hasSafe(moves)) break; continue; }

    const byCell = new Map<number, number[]>();
    cs.forEach((c, k) => { for (const j of c.cells) (byCell.get(j) ?? byCell.set(j, []).get(j)!).push(k); });
    const mark = new Uint8Array(n);
    outer: for (let a = 0; a < cs.length; a++) {
      const A = cs[a];
      const partners = new Set<number>();
      for (const j of A.cells) for (const b of byCell.get(j)!) if (b !== a) partners.add(b);
      for (const b of partners) {
        const B = cs[b];
        for (const j of A.cells) mark[j] = 1;
        const onlyB = B.cells.filter((j) => !mark[j]);
        for (const j of A.cells) mark[j] = 0;
        for (const j of B.cells) mark[j] = 1;
        const onlyA = A.cells.filter((j) => !mark[j]);
        for (const j of B.cells) mark[j] = 0;
        // Mines in B outside A are at least need_B - need_A. If that fills them, A's own cells are clear.
        if (onlyB.length && B.need - A.need === onlyB.length) {
          for (const j of onlyB) decide(j, MINE, 'pair', [A.src, B.src]);
          for (const j of onlyA) decide(j, SAFE, 'pair', [A.src, B.src]);
          found = true;
          break outer;
        }
      }
    }
    if (!found) break;
    if (opts.stopEarly && hasSafe(moves)) break;
  }

  if (opts.stopEarly && hasSafe(moves) && !opts.prob) return { fate, moves, prob: null };
  const prob = enumerate(pos, fate, build(), decide);
  return { fate, moves, prob: opts.prob ? prob : null };
}

const hasSafe = (moves: Move[]) => moves.some((m) => !m.mine);

interface Comp {
  cells: number[];
  srcs: number[];
  /** cnt[k]: arrangements with k mines. */
  cnt: number[];
  /** per[k][i]: arrangements with k mines where cells[i] is a mine. */
  per: number[][];
}

function enumerate(pos: Position, fate: Uint8Array, cs: Constraint[], decide: (c: number, f: number, k: Kind, b: number[]) => void): Float64Array | null {
  const { view, w, h } = pos;
  const n = w * h;
  let knownMines = 0, hiddenUnknown = 0;
  for (let i = 0; i < n; i++) if (view[i] === HIDDEN) { if (fate[i] === MINE) knownMines++; else if (!fate[i]) hiddenUnknown++; }
  const R = pos.mines - knownMines;

  // Components: constraints joined through shared cells.
  const owner = new Map<number, number>();
  const parent = cs.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  cs.forEach((c, k) => { for (const j of c.cells) { const o = owner.get(j); if (o === undefined) owner.set(j, k); else parent[find(o)] = find(k); } });
  const groups = new Map<number, number[]>();
  cs.forEach((_, k) => { const r = find(k); (groups.get(r) ?? groups.set(r, []).get(r)!).push(k); });

  const comps: Comp[] = [];
  let budget = BUDGET;
  for (const ks of groups.values()) {
    const c = count(ks.map((k) => cs[k]), budget);
    if (!c) return null;
    budget -= c.used;
    comps.push(c.comp);
  }
  const frontier = comps.reduce((s, c) => s + c.cells.length, 0);
  const I = hiddenUnknown - frontier;

  // Feasible totals: which frontier mine counts K can sit alongside 0..I interior mines.
  const okRest = (K: number) => R - K >= 0 && R - K <= I;
  const supports = comps.map((c) => c.cnt.map((v) => v > 0));
  const conv = (skip: number) => {
    let s = [true];
    comps.forEach((_, ci) => {
      if (ci === skip) return;
      const t = new Array(s.length + supports[ci].length - 1).fill(false);
      s.forEach((a, i) => { if (a) supports[ci].forEach((b, j) => { if (b) t[i + j] = true; }); });
      s = t;
    });
    return s;
  };
  const all = conv(-1);
  if (!all.some((v, K) => v && okRest(K))) return null; // inconsistent view; nothing safe to say

  // Certainty from support, checked once with and once without the global mine count.
  comps.forEach((c, ci) => {
    const others = conv(ci);
    const feasible = c.cnt.map((v, k) => v > 0 && others.some((o, K) => o && okRest(k + K)));
    c.cells.forEach((cell, i) => {
      let alwaysMine = true, neverMine = true, localMine = true, localSafe = true;
      c.cnt.forEach((v, k) => {
        if (!v) return;
        const m = c.per[k][i];
        if (m !== v) localMine = false;
        if (m !== 0) localSafe = false;
        if (!feasible[k]) return;
        if (m !== v) alwaysMine = false;
        if (m !== 0) neverMine = false;
      });
      if (neverMine) decide(cell, SAFE, localSafe ? 'enum' : 'count', c.srcs);
      else if (alwaysMine) decide(cell, MINE, localMine ? 'enum' : 'count', c.srcs);
    });
  });
  if (I > 0) {
    const restCounts = all.map((v, K) => (v && okRest(K) ? R - K : -1)).filter((x) => x >= 0);
    const interior: number[] = [];
    for (let i = 0; i < n; i++) if (view[i] === HIDDEN && !fate[i] && !owner.has(i)) interior.push(i);
    if (restCounts.every((r) => r === 0)) for (const i of interior) decide(i, SAFE, 'count', []);
    else if (restCounts.every((r) => r === I)) for (const i of interior) decide(i, MINE, 'count', []);
  }

  // Probabilities. Each interior choice C(I, R-K) is taken in log space and scaled by the largest one.
  const logC = (k: number) => (k < 0 || k > I ? -Infinity : lfact(I) - lfact(k) - lfact(I - k));
  const prob = new Float64Array(n);
  for (let i = 0; i < n; i++) if (view[i] === HIDDEN && fate[i] === MINE) prob[i] = 1;
  const dists = comps.map((c) => { const m = Math.max(...c.cnt); return c.cnt.map((v) => v / m); });
  const convW = (skip: number) => {
    let s = [1];
    dists.forEach((d, ci) => {
      if (ci === skip) return;
      const t = new Array(s.length + d.length - 1).fill(0);
      s.forEach((a, i) => { if (a) d.forEach((b, j) => { if (b) t[i + j] += a * b; }); });
      const m = Math.max(...t);
      s = t.map((x) => x / m);
    });
    return s;
  };
  let maxL = -Infinity;
  for (let K = 0; K <= R; K++) maxL = Math.max(maxL, logC(R - K));
  const wInt = (K: number) => Math.exp(logC(R - K) - maxL);

  comps.forEach((c, ci) => {
    const others = convW(ci);
    const m = Math.max(...c.cnt);
    const tot = c.cnt.map((v, k) => (v / m) * others.reduce((s, o, K) => s + o * wInt(k + K), 0));
    const Z = tot.reduce((a, b) => a + b, 0);
    c.cells.forEach((cell, i) => {
      if (fate[cell]) { prob[cell] = fate[cell] === MINE ? 1 : 0; return; }
      let mw = 0;
      c.cnt.forEach((v, k) => { if (v) mw += tot[k] * (c.per[k][i] / v); });
      prob[cell] = Z > 0 ? mw / Z : 0;
    });
  });
  if (I > 0) {
    const full = convW(-1);
    let Z = 0, E = 0;
    full.forEach((v, K) => { const wt = v * wInt(K); Z += wt; if (wt) E += wt * (R - K); });
    const p = Z > 0 ? E / Z / I : 0;
    for (let i = 0; i < n; i++) if (view[i] === HIDDEN && !owner.has(i) && fate[i] !== MINE) prob[i] = fate[i] === SAFE ? 0 : p;
  }
  return prob;
}

/** Backtracking count of every arrangement on one component, with bounds pruning. */
function count(cs: Constraint[], budget: number): { comp: Comp; used: number } | null {
  // Order cells so each constraint closes as early as possible: walk constraints breadth-first.
  const cells: number[] = [];
  const idx = new Map<number, number>();
  const byCell = new Map<number, number[]>();
  cs.forEach((c, k) => { for (const j of c.cells) (byCell.get(j) ?? byCell.set(j, []).get(j)!).push(k); });
  const seenC = new Uint8Array(cs.length);
  const queue = [0];
  seenC[0] = 1;
  while (queue.length) {
    const k = queue.shift()!;
    for (const j of cs[k].cells) {
      if (idx.has(j)) continue;
      idx.set(j, cells.length);
      cells.push(j);
      for (const o of byCell.get(j)!) if (!seenC[o]) { seenC[o] = 1; queue.push(o); }
    }
  }
  const N = cells.length;
  const cellCons = cells.map((j) => byCell.get(j)!);
  const need = cs.map((c) => c.need);
  const left = cs.map((c) => c.cells.length);
  const have = cs.map(() => 0);
  const cnt = new Array(N + 1).fill(0);
  const per: number[][] = Array.from({ length: N + 1 }, () => new Array(N).fill(0));
  const assign = new Uint8Array(N);
  let used = 0, over = false;

  const rec = (i: number, k: number) => {
    if (++used > budget) { over = true; return; }
    if (i === N) {
      cnt[k]++;
      const row = per[k];
      for (let t = 0; t < N; t++) if (assign[t]) row[t]++;
      return;
    }
    const cons = cellCons[i];
    for (let v = 0; v <= 1 && !over; v++) {
      let ok = true;
      for (const c of cons) {
        left[c]--; have[c] += v;
        if (have[c] > need[c] || have[c] + left[c] < need[c]) ok = false;
      }
      assign[i] = v;
      if (ok) rec(i + 1, k + v);
      for (const c of cons) { left[c]++; have[c] -= v; }
    }
    assign[i] = 0;
  };
  rec(0, 0);
  if (over) return null;
  return { comp: { cells, srcs: [...new Set(cs.map((c) => c.src))], cnt, per }, used };
}

const lf: number[] = [0];
function lfact(k: number): number {
  for (let i = lf.length; i <= k; i++) lf[i] = lf[i - 1] + Math.log(i);
  return lf[k];
}
