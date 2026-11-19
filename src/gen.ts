// Dealing boards. A no-guess board is one the solver clears from the start cell without ever guessing.

import { counts, neighbours, place, safeZone, type Size } from './board.ts';
import { analyse, HIDDEN } from './solver.ts';

/** Plays the board with the solver from `start`. True if every safe cell gets revealed. */
export function solvable(size: Size, mines: Uint8Array, start: number): boolean {
  const { w, h } = size;
  const c = counts(w, h, mines);
  const nb = neighbours(w, h);
  const view = new Int8Array(w * h).fill(HIDDEN);
  let left = w * h - size.mines;
  const open = (cell: number) => {
    const stack = [cell];
    while (stack.length) {
      const k = stack.pop()!;
      if (view[k] !== HIDDEN) continue;
      view[k] = c[k];
      left--;
      if (c[k] === 0) for (const j of nb[k]) if (view[j] === HIDDEN) stack.push(j);
    }
  };
  open(start);
  while (left > 0) {
    const a = analyse({ w, h, mines: size.mines, view }, { stopEarly: true });
    let progressed = false;
    for (const m of a.moves) if (!m.mine && view[m.cell] === HIDDEN) { open(m.cell); progressed = true; }
    if (!progressed) return false;
  }
  return true;
}

export interface Dealt { mines: Uint8Array; tries: number; noGuess: boolean }

/**
 * Random boards until one is solvable. Expert takes a few dozen tries on average, a few ms each.
 * Dense custom boards may never succeed, so after `maxTries` the last board is returned with noGuess false.
 */
export function deal(size: Size, start: number, rand: () => number, noGuess: boolean, maxTries = 4000): Dealt {
  const keep = safeZone(size, start);
  for (let tries = 1; ; tries++) {
    const mines = place(size, keep, rand);
    if (!noGuess) return { mines, tries, noGuess: false };
    if (solvable(size, mines, start)) return { mines, tries, noGuess: true };
    if (tries >= maxTries) return { mines, tries, noGuess: false };
  }
}

/** The daily board: Expert, no-guess, the same for everyone on a UTC date. */
export const DAILY: Size = { w: 30, h: 16, mines: 99 };
export function dailySeed(date: string): number {
  let x = 0x811c9dc5;
  for (const ch of 'minefield/' + date) x = Math.imul(x ^ ch.charCodeAt(0), 0x01000193);
  return x >>> 0;
}
export const dailyStart = (size: Size) => Math.floor(size.h / 2) * size.w + Math.floor(size.w / 2);
