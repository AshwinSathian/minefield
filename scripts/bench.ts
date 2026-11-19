// Times no-guess dealing per difficulty. Usage: node scripts/bench.ts
import { deal } from '../src/gen.ts';
import { rng } from '../src/board.ts';

const sizes = [['beginner', 9, 9, 10], ['intermediate', 16, 16, 40], ['expert', 30, 16, 99], ['big', 60, 40, 480]] as const;
for (const [name, w, h, mines] of sizes) {
  const rand = rng(1);
  const N = name === 'big' ? 10 : 100;
  const times: number[] = [];
  let tries = 0, fails = 0;
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const d = deal({ w, h, mines }, Math.floor(h / 2) * w + Math.floor(w / 2), rand, true);
    times.push(performance.now() - t);
    tries += d.tries;
    if (!d.noGuess) fails++;
  }
  times.sort((a, b) => a - b);
  const q = (p: number) => times[Math.min(N - 1, Math.floor(N * p))].toFixed(1);
  console.log(`${name}: median ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${q(1)} ms, ${(tries / N).toFixed(1)} tries per board, ${fails} fails`);
}
