// Everything kept between visits, in one localStorage key. Reads and writes never throw:
// private windows and blocked storage just mean nothing is remembered.

import type { Mode, Saved } from './game.ts';

export interface Settings {
  theme: 'auto' | 'light' | 'dark';
  sound: boolean;
  haptics: boolean;
  noGuess: boolean;
  mode: Exclude<Mode, 'daily' | 'shared'>;
  custom: { w: number; h: number; mines: number };
}

export interface Best { t: number; date: string; bbbvs: number }
export interface Record { played: number; won: number; streak: number; bestStreak: number; best: Best[] }
export interface DailyResult { won: boolean; t: number; bbbv: number; clicks: number; assisted: boolean }

interface Data {
  v: 1;
  settings: Settings;
  stats: { [key: string]: Record };
  daily: { [date: string]: DailyResult };
  save: Saved | null;
}

const KEY = 'minefield:v1';
const fresh = (): Data => ({
  v: 1,
  settings: { theme: 'auto', sound: true, haptics: true, noGuess: true, mode: 'beginner', custom: { w: 24, h: 20, mines: 90 } },
  stats: {},
  daily: {},
  save: null,
});

function read(): Data {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const d = JSON.parse(raw) as Data;
    if (d.v !== 1) return fresh();
    return { ...fresh(), ...d, settings: { ...fresh().settings, ...d.settings } };
  } catch {
    return fresh();
  }
}

export const data = read();

export function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* storage full or blocked: keep playing */ }
}

/** Stats key: classic boards are kept apart from no-guess ones, since they're different games. */
export const statKey = (mode: Mode, noGuess: boolean) => (mode === 'daily' ? 'daily' : mode + (noGuess ? '' : '-classic'));

export function record(key: string, won: boolean, t: number, bbbvs: number, clean: boolean): { newBest: boolean } {
  const r = (data.stats[key] ??= { played: 0, won: 0, streak: 0, bestStreak: 0, best: [] });
  r.played++;
  let newBest = false;
  if (won) {
    r.won++;
    r.streak++;
    r.bestStreak = Math.max(r.bestStreak, r.streak);
    if (clean) {
      newBest = !r.best.length || t < r.best[0].t;
      r.best.push({ t, date: new Date().toISOString().slice(0, 10), bbbvs });
      r.best.sort((a, b) => a.t - b.t);
      r.best.length = Math.min(r.best.length, 5);
    }
  } else r.streak = 0;
  persist();
  return { newBest };
}
