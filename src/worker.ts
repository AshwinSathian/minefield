// Deals boards off the main thread so a large no-guess board never stalls input.
import { deal } from './gen.ts';
import { rng, type Size } from './board.ts';

export interface DealRequest { id: number; size: Size; start: number; seed: number; noGuess: boolean }

self.onmessage = (e: MessageEvent<DealRequest>) => {
  const { id, size, start, seed, noGuess } = e.data;
  const d = deal(size, start, rng(seed), noGuess);
  self.postMessage({ id, mines: d.mines, noGuess: d.noGuess }, { transfer: [d.mines.buffer] });
};
