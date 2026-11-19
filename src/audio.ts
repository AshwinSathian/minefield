// Every sound is synthesised on the spot. Nothing to download, and the context only starts after a gesture.

let ctx: AudioContext | null = null;
let out: GainNode;
export let enabled = true;
export const setSound = (on: boolean) => { enabled = on; };

function ac(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    ctx = new AudioContext();
    out = ctx.createGain();
    out.gain.value = 0.22;
    out.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function blip(freq: number, dur: number, type: OscillatorType, vol: number, at = 0, glide = 0) {
  const c = ac();
  if (!c) return;
  const t = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glide) o.frequency.exponentialRampToValueAtTime(freq * glide, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** A soft wooden tap; bigger openings sound lower and a touch longer. */
export function open(cells: number) {
  const size = Math.min(1, Math.log2(cells + 1) / 7);
  blip(900 - size * 420, 0.05 + size * 0.08, 'triangle', 0.5, 0, 0.6);
  if (cells > 12) blip(220, 0.18, 'sine', 0.25 * size, 0.01, 0.7);
}

export function flag(on: boolean) { blip(on ? 520 : 380, 0.06, 'square', 0.12, 0, on ? 1.3 : 0.8); }
export function chord() { blip(640, 0.04, 'triangle', 0.35); }

export function boom() {
  const c = ac();
  if (!c) return;
  const len = Math.floor(c.sampleRate * 0.6);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = c.createBufferSource();
  src.buffer = buf;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1800, c.currentTime);
  lp.frequency.exponentialRampToValueAtTime(120, c.currentTime + 0.5);
  src.connect(lp).connect(out);
  src.start();
  blip(90, 0.45, 'sine', 0.8, 0, 0.5);
}

export function win() { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => blip(f, 0.32, 'triangle', 0.32, i * 0.085)); }
export function hint() { blip(1180, 0.08, 'sine', 0.22); blip(1580, 0.12, 'sine', 0.18, 0.06); }
