// Board geometry, seeded randomness, 3BV and the share-link codec. Pure, no DOM.

export interface Size { w: number; h: number; mines: number }

/** sfc32: small, fast, and good enough statistically for dealing mines. */
export function rng(seed: number): () => number {
  let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

/** Neighbour lists for every cell, built once per board size. */
const nbCache = new Map<string, Int32Array[]>();
export function neighbours(w: number, h: number): Int32Array[] {
  const key = w + 'x' + h;
  let nb = nbCache.get(key);
  if (nb) return nb;
  nb = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const list: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) list.push(ny * w + nx);
    }
    nb.push(Int32Array.from(list));
  }
  nbCache.set(key, nb);
  return nb;
}

/** Number of adjacent mines per cell; 9 marks a mine. */
export function counts(w: number, h: number, mines: Uint8Array): Uint8Array {
  const nb = neighbours(w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (mines[i]) { out[i] = 9; continue; }
    let n = 0;
    for (const j of nb[i]) n += mines[j];
    out[i] = n;
  }
  return out;
}

/** Uniformly place mines, keeping `keep` cells clear (Fisher-Yates over the allowed cells). */
export function place(size: Size, keep: Iterable<number>, rand: () => number): Uint8Array {
  const n = size.w * size.h;
  const banned = new Uint8Array(n);
  for (const k of keep) banned[k] = 1;
  const pool: number[] = [];
  for (let i = 0; i < n; i++) if (!banned[i]) pool.push(i);
  const mines = new Uint8Array(n);
  for (let k = 0; k < size.mines; k++) {
    const j = k + Math.floor(rand() * (pool.length - k));
    [pool[k], pool[j]] = [pool[j], pool[k]];
    mines[pool[k]] = 1;
  }
  return mines;
}

/** Cells kept free of mines around the first click: the 3x3 block if the board has room, else the cell alone. */
export function safeZone(size: Size, start: number): number[] {
  const zone = [start, ...neighbours(size.w, size.h)[start]];
  return size.w * size.h - zone.length >= size.mines ? zone : [start];
}

/**
 * 3BV: the fewest clicks that clear the board without flags.
 * One click per opening (connected zeros plus their border), one per numbered cell no opening touches.
 */
export function bbbv(w: number, h: number, mines: Uint8Array): number {
  const c = counts(w, h, mines);
  const nb = neighbours(w, h);
  const seen = new Uint8Array(w * h);
  let total = 0;
  for (let i = 0; i < w * h; i++) {
    if (c[i] !== 0 || seen[i]) continue;
    total++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      if (c[k] !== 0) continue;
      for (const j of nb[k]) if (!seen[j]) { seen[j] = 1; stack.push(j); }
    }
  }
  for (let i = 0; i < w * h; i++) if (!seen[i] && c[i] !== 9) total++;
  return total;
}

// Share codec: version byte, w, h, start (2 bytes), then the mine bitset. base64url.
export interface Packed { w: number; h: number; start: number; mines: Uint8Array }

export function pack(p: Packed): string {
  const n = p.w * p.h;
  const bytes = new Uint8Array(5 + Math.ceil(n / 8));
  bytes.set([1, p.w, p.h, p.start >> 8, p.start & 255]);
  for (let i = 0; i < n; i++) if (p.mines[i]) bytes[5 + (i >> 3)] |= 1 << (i & 7);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns null for anything that isn't a well-formed board, since links come from strangers. */
export function unpack(code: string): Packed | null {
  try {
    const bin = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const [v, w, h, s1, s2] = bytes;
    const start = (s1 << 8) | s2;
    if (v !== 1 || w < 5 || h < 5 || w > MAX_W || h > MAX_H || start >= w * h) return null;
    if (bytes.length !== 5 + Math.ceil((w * h) / 8)) return null;
    const mines = new Uint8Array(w * h);
    let m = 0;
    for (let i = 0; i < w * h; i++) m += mines[i] = (bytes[5 + (i >> 3)] >> (i & 7)) & 1;
    if (m < 1 || mines[start] || m > w * h - 1) return null;
    return { w, h, start, mines };
  } catch {
    return null;
  }
}

export const MAX_W = 60, MAX_H = 40;
