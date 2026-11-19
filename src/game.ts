// One game of Minefield: rules, timing, counting, undo, save. No DOM.

import { bbbv, counts, neighbours, type Size } from './board.ts';
import { analyse, HIDDEN, type Move } from './solver.ts';

export type Mode = 'beginner' | 'intermediate' | 'expert' | 'custom' | 'daily' | 'shared';
export type Status = 'ready' | 'playing' | 'won' | 'lost';

export const PRESETS: Record<'beginner' | 'intermediate' | 'expert', Size> = {
  beginner: { w: 9, h: 9, mines: 10 },
  intermediate: { w: 16, h: 16, mines: 40 },
  expert: { w: 30, h: 16, mines: 99 },
};

/** A revealed cell and its distance in steps from the click, for the cascade animation. */
export interface Opened { cell: number; d: number }

export interface Result { opened: Opened[]; flagged?: number; boom?: number; changed: boolean }

export interface Saved {
  mode: Mode; size: Size; noGuess: boolean; date?: string;
  start: number | null; mines: string | null; view: string; flag: string;
  status: Status; clicks: number; elapsed: number; assisted: boolean; recorded: boolean; boom: number | null;
}

export class Game {
  readonly n: number;
  mines: Uint8Array | null = null;
  num: Uint8Array = new Uint8Array(0);
  /** What the player sees: -1 hidden, 0..8 revealed number. */
  view: Int8Array;
  flag: Uint8Array;
  status: Status = 'ready';
  clicks = 0;
  assisted = false;
  /** Stats already counted this game (a loss stays a loss after a take-back). */
  recorded = false;
  boom: number | null = null;
  /** Fixed start cell for daily and shared boards, or the first click. */
  start: number | null = null;
  private left = 0;
  private elapsedMs = 0;
  private since: number | null = null;
  private undo: { view: Int8Array; flag: Uint8Array; left: number; clicks: number } | null = null;

  readonly mode: Mode;
  readonly size: Size;
  readonly noGuess: boolean;
  readonly date?: string;

  constructor(mode: Mode, size: Size, noGuess: boolean, date?: string) {
    this.mode = mode; this.size = size; this.noGuess = noGuess; this.date = date;
    this.n = size.w * size.h;
    this.view = new Int8Array(this.n).fill(HIDDEN);
    this.flag = new Uint8Array(this.n);
  }

  get flagsLeft() { let f = 0; for (const x of this.flag) f += x; return this.size.mines - f; }
  get over() { return this.status === 'won' || this.status === 'lost'; }
  get elapsed() { return this.elapsedMs + (this.since === null ? 0 : performance.now() - this.since); }
  get bbbv() { return this.mines ? bbbv(this.size.w, this.size.h, this.mines) : 0; }

  /** Lay the mines. For fixed-start boards the start opens straight away and the clock waits for the first move. */
  begin(mines: Uint8Array, start: number, openStart: boolean): Result {
    this.mines = mines;
    this.num = counts(this.size.w, this.size.h, mines);
    this.left = this.n - this.size.mines;
    this.start = start;
    this.status = 'playing';
    if (!openStart) return { opened: [], changed: false };
    return { opened: this.flood([start]), changed: true };
  }

  pause() { if (this.since !== null) { this.elapsedMs += performance.now() - this.since; this.since = null; } }
  resume() { if (this.status === 'playing' && this.since === null && this.clicks > 0) this.since = performance.now(); }

  private tick() { if (this.since === null) this.since = performance.now(); }
  private snapshot() { this.undo = { view: this.view.slice(), flag: this.flag.slice(), left: this.left, clicks: this.clicks }; }

  reveal(cell: number): Result {
    if (this.status !== 'playing' || this.view[cell] !== HIDDEN || this.flag[cell]) return { opened: [], changed: false };
    this.snapshot();
    this.tick();
    this.clicks++;
    if (this.mines![cell]) return this.lose(cell);
    const opened = this.flood([cell]);
    this.checkWin();
    return { opened, changed: true };
  }

  /** Open every unflagged neighbour of a number whose flags are all placed. */
  chord(cell: number): Result {
    const v = this.view[cell];
    if (this.status !== 'playing' || v <= 0) return { opened: [], changed: false };
    const nb = neighbours(this.size.w, this.size.h)[cell];
    let flags = 0, hidden = 0;
    for (const j of nb) { if (this.flag[j]) flags++; else if (this.view[j] === HIDDEN) hidden++; }
    if (flags !== v || !hidden) return { opened: [], changed: false };
    this.snapshot();
    this.tick();
    this.clicks++;
    const targets = [...nb].filter((j) => !this.flag[j] && this.view[j] === HIDDEN);
    const hit = targets.find((j) => this.mines![j]);
    if (hit !== undefined) return this.lose(hit);
    const opened = this.flood(targets);
    this.checkWin();
    return { opened, changed: true };
  }

  toggleFlag(cell: number): Result {
    if (this.status !== 'playing' || this.view[cell] !== HIDDEN) return { opened: [], changed: false };
    this.tick();
    this.clicks++;
    this.flag[cell] ^= 1;
    return { opened: [], flagged: cell, changed: true };
  }

  /** Breadth-first so each opened cell knows how far it is from where the player clicked. */
  private flood(from: number[]): Opened[] {
    const nb = neighbours(this.size.w, this.size.h);
    const out: Opened[] = [];
    let frontier = from.filter((c) => this.view[c] === HIDDEN);
    for (const c of frontier) this.view[c] = -2; // queued
    for (let d = 0; frontier.length; d++) {
      const next: number[] = [];
      for (const c of frontier) {
        this.view[c] = this.num[c];
        this.flag[c] = 0;
        this.left--;
        out.push({ cell: c, d });
        if (this.num[c] === 0) for (const j of nb[c]) if (this.view[j] === HIDDEN) { this.view[j] = -2; next.push(j); }
      }
      frontier = next;
    }
    return out;
  }

  private checkWin() {
    if (this.left > 0) return;
    this.status = 'won';
    this.pause();
    for (let i = 0; i < this.n; i++) if (this.mines![i]) this.flag[i] = 1;
  }

  private lose(cell: number): Result {
    this.status = 'lost';
    this.boom = cell;
    this.pause();
    return { opened: [], boom: cell, changed: true };
  }

  /** Back to the position before the losing move. The game no longer counts as clean. */
  takeBack(): boolean {
    if (this.status !== 'lost' || !this.undo) return false;
    Object.assign(this, { view: this.undo.view, flag: this.undo.flag, left: this.undo.left, clicks: this.undo.clicks });
    this.undo = null;
    this.status = 'playing';
    this.boom = null;
    this.assisted = true;
    this.resume();
    return true;
  }

  /** What the player could have known before the losing move. */
  review(): { verdict: 'mistake' | 'guess'; odds: number; better: number | null } | null {
    if (this.status !== 'lost' || !this.undo || this.boom === null) return null;
    const a = analyse({ ...this.size, view: this.undo.view }, { prob: true });
    const safe = a.moves.find((m) => !m.mine && this.undo!.view[m.cell] === HIDDEN);
    const odds = a.prob ? a.prob[this.boom] : NaN;
    if (safe) return { verdict: 'mistake', odds, better: nearest(a.moves.filter((m) => !m.mine).map((m) => m.cell), this.boom, this.size.w) };
    let best: number | null = null;
    if (a.prob) for (let i = 0; i < this.n; i++) if (this.undo.view[i] === HIDDEN && (best === null || a.prob[i] < a.prob[best])) best = i;
    return { verdict: 'guess', odds, better: best !== null && a.prob![best] < odds - 1e-9 ? best : null };
  }

  /** The next thing worth telling the player, cheapest reasoning first. */
  hint(near: number | null): Hint {
    if (this.status !== 'playing') return { type: 'none' };
    const a = analyse({ ...this.size, view: this.view }, { prob: true });
    this.assisted = true;
    for (let i = 0; i < this.n; i++) if (this.flag[i] && a.fate[i] === 1) return { type: 'wrong-flag', cell: i, because: [] };
    const rank: Record<Move['kind'], number> = { single: 0, pair: 1, enum: 2, count: 3 };
    const pick = (ms: Move[]) => {
      if (!ms.length) return null;
      const top = Math.min(...ms.map((m) => rank[m.kind]));
      const tier = ms.filter((m) => rank[m.kind] === top);
      const c = near === null ? tier[0].cell : nearest(tier.map((m) => m.cell), near, this.size.w);
      return tier.find((m) => m.cell === c)!;
    };
    const safe = pick(a.moves.filter((m) => !m.mine && this.view[m.cell] === HIDDEN));
    if (safe) return { type: 'safe', cell: safe.cell, kind: safe.kind, because: safe.because };
    const mine = pick(a.moves.filter((m) => m.mine && !this.flag[m.cell]));
    if (mine) return { type: 'mine', cell: mine.cell, kind: mine.kind, because: mine.because };
    if (!a.prob) return { type: 'none' };
    let best = -1;
    for (let i = 0; i < this.n; i++) if (this.view[i] === HIDDEN && !this.flag[i] && (best < 0 || a.prob[i] < a.prob[best])) best = i;
    return best < 0 ? { type: 'none' } : { type: 'guess', cell: best, odds: a.prob[best], because: [] };
  }

  save(): Saved {
    return {
      mode: this.mode, size: this.size, noGuess: this.noGuess, date: this.date, start: this.start,
      mines: this.mines && b64(this.mines), view: b64(new Uint8Array(this.view.buffer)), flag: b64(this.flag),
      status: this.status, clicks: this.clicks, elapsed: this.elapsed, assisted: this.assisted, recorded: this.recorded, boom: this.boom,
    };
  }

  static load(s: Saved): Game {
    const g = new Game(s.mode, s.size, s.noGuess, s.date);
    if (s.mines) {
      g.mines = unb64(s.mines);
      g.num = counts(s.size.w, s.size.h, g.mines);
    }
    g.view = new Int8Array(unb64(s.view).buffer);
    g.flag = unb64(s.flag);
    if (g.view.length !== g.n || g.flag.length !== g.n || (g.mines && g.mines.length !== g.n)) throw new Error('bad save');
    g.start = s.start;
    g.status = s.status;
    g.clicks = s.clicks;
    g.elapsedMs = s.elapsed;
    g.assisted = s.assisted;
    g.recorded = s.recorded;
    g.boom = s.boom;
    g.left = g.n - s.size.mines - g.view.filter((v) => v >= 0).length;
    return g;
  }
}

export type Hint =
  | { type: 'none' }
  | { type: 'safe' | 'mine'; cell: number; kind: Move['kind']; because: number[] }
  | { type: 'wrong-flag'; cell: number; because: number[] }
  | { type: 'guess'; cell: number; odds: number; because: number[] };

function nearest(cells: number[], to: number, w: number): number {
  const tx = to % w, ty = (to / w) | 0;
  let best = cells[0], bd = Infinity;
  for (const c of cells) {
    const d = Math.max(Math.abs((c % w) - tx), Math.abs(((c / w) | 0) - ty));
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

const b64 = (a: Uint8Array) => btoa(String.fromCharCode(...a));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
