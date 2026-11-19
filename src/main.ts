import './style.css';
import Dealer from './worker.ts?worker&inline';
import { pack, unpack, MAX_W, MAX_H, type Size } from './board.ts';
import { Game, PRESETS, type Hint, type Mode, type Opened, type Result } from './game.ts';
import { DAILY, dailySeed, dailyStart } from './gen.ts';
import { analyse, HIDDEN } from './solver.ts';
import { data, persist, record, statKey, type Settings } from './store.ts';
import * as sfx from './audio.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const board = $('board'), stage = $('stage');
const S = data.settings;
const coarse = matchMedia('(pointer: coarse)');

let game: Game;
let tool: 'dig' | 'flag' = 'dig';
let odds = false;
let prob: Float64Array | null = null;
let hint: Hint | null = null;
let better: number | null = null;
let cursor = 0;
let lastCell: number | null = null;
let els: HTMLElement[] = [];
let flip = false;
let zoom = 1;
let dealing = false;

// ---- Dealing -------------------------------------------------------------

const worker = new Dealer();
let reqId = 0;
const pending = new Map<number, (m: Uint8Array) => void>();
worker.onmessage = (e: MessageEvent<{ id: number; mines: Uint8Array }>) => { pending.get(e.data.id)?.(e.data.mines); pending.delete(e.data.id); };
function dealAsync(size: Size, start: number, seed: number, noGuess: boolean): Promise<Uint8Array> {
  const id = ++reqId;
  return new Promise((res) => { pending.set(id, res); worker.postMessage({ id, size, start, seed, noGuess }); });
}
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const today = () => new Date().toISOString().slice(0, 10);

// ---- Starting games ------------------------------------------------------

function sizeFor(mode: Mode): Size {
  if (mode === 'custom') return clampCustom(S.custom, S.noGuess);
  if (mode === 'daily') return DAILY;
  return PRESETS[mode as keyof typeof PRESETS];
}

function clampCustom(c: Size, noGuess: boolean): Size {
  const w = Math.max(5, Math.min(MAX_W, Math.round(c.w) || 5));
  const h = Math.max(5, Math.min(MAX_H, Math.round(c.h) || 5));
  // No-guess dealing gets rare past about a quarter of the board; classic only needs room for a safe start.
  const cap = noGuess ? Math.floor(w * h * 0.25) : w * h - 9;
  return { w, h, mines: Math.max(1, Math.min(cap, Math.round(c.mines) || 1)) };
}

function setGame(g: Game) {
  game = g;
  hint = null; better = null; prob = null; dealing = false;
  cursor = g.start ?? Math.floor(g.size.h / 2) * g.size.w + Math.floor(g.size.w / 2);
  $('end').hidden = true;
  document.body.classList.remove('ended');
  $('mode-name').textContent = modeLabel(g);
  zoom = 1;
  build();
  hud();
}

function newGame(mode: Mode = S.mode) {
  if (mode === 'daily') return startDaily();
  if (mode !== 'shared') { S.mode = mode; persist(); }
  setGame(new Game(mode, sizeFor(mode), S.noGuess));
  save();
  toast(coarse.matches ? 'First tap is always safe.' : 'First click is always safe.');
}

async function startDaily() {
  const date = today();
  const g = new Game('daily', DAILY, true, date);
  setGame(g);
  dealing = true;
  const start = dailyStart(DAILY);
  const mines = await dealAsync(DAILY, start, dailySeed(date), true);
  if (game !== g) return;
  dealing = false;
  apply(g.begin(mines, start, true));
  const done = data.daily[date];
  toast(done ? 'You\'ve played today\'s board. This run won\'t change your result.' : 'Today\'s board. It starts open around the ringed cell.');
  save();
}

function startShared(code: string) {
  const p = unpack(code);
  if (!p) return false;
  let m = 0;
  for (const x of p.mines) m += x;
  const g = new Game('shared', { w: p.w, h: p.h, mines: m }, false);
  setGame(g);
  apply(g.begin(p.mines, p.start, true));
  toast('Someone sent you this board. It starts open around the ringed cell.');
  save();
  return true;
}

function modeLabel(g: Game) {
  switch (g.mode) {
    case 'custom': return `Custom ${g.size.w}×${g.size.h}`;
    case 'shared': return 'Shared board';
    default: return g.mode[0].toUpperCase() + g.mode.slice(1);
  }
}

// ---- Board DOM -------------------------------------------------------------

/** Rebuild the grid. Called on a new game or when the screen's long side changes. */
function build() {
  const { w, h } = game.size;
  flip = shouldFlip();
  const rows = flip ? w : h, cols = flip ? h : w;
  board.style.gridTemplateColumns = `repeat(${cols}, var(--cell))`;
  board.setAttribute('aria-rowcount', String(rows));
  board.setAttribute('aria-colcount', String(cols));
  const frag = document.createDocumentFragment();
  els = new Array(w * h);
  for (let r = 0; r < rows; r++) {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'row');
    for (let c = 0; c < cols; c++) {
      const i = flip ? c * w + r : r * w + c;
      const el = document.createElement('div');
      el.className = 'c';
      el.id = 'c' + i;
      el.dataset.i = String(i);
      el.setAttribute('role', 'gridcell');
      els[i] = el;
      row.append(el);
    }
    frag.append(row);
  }
  board.replaceChildren(frag);
  fit();
  renderAll();
}

/** Turn a wide board upright on a tall screen, and the other way round. */
function shouldFlip() {
  const { w, h } = game.size;
  if (w === h) return false;
  const r = stage.getBoundingClientRect();
  return (r.height > r.width) !== (h > w);
}

function fitCell() {
  const { w, h } = game.size;
  const rows = flip ? w : h, cols = flip ? h : w;
  const cs = getComputedStyle(stage);
  const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const cell = Math.min(aw / (cols * 1.06 + 0.12), ah / (rows * 1.06 + 0.12));
  // Phones show the whole board and pinch to zoom; below 20 px a tap is too easy to miss.
  return Math.max(coarse.matches ? 20 : 16, Math.min(60, Math.floor(cell)));
}

function fit() {
  const cell = Math.round(fitCell() * zoom);
  board.style.setProperty('--cell', cell + 'px');
  board.classList.toggle('tiny', cell < 26);
}

const touchesNumber = (i: number) => neighboursOf(i).some((j) => game.view[j] >= 0);

const LABEL = ['Empty', '1', '2', '3', '4', '5', '6', '7', '8'];

function renderCell(i: number) {
  const el = els[i];
  const v = game.view[i];
  const over = game.over;
  let s: string;
  if (v >= 0) s = v ? 'n' : 'o';
  else if (over && game.mines?.[i]) s = game.flag[i] ? 'f' : i === game.boom ? 'x' : 'm';
  else if (game.flag[i]) s = over && game.status === 'lost' && !game.mines![i] ? 'w' : 'f';
  else s = 'h';
  el.dataset.s = s;
  if (v > 0) { el.dataset.n = String(v); el.textContent = String(v); }
  else if (el.textContent) { delete el.dataset.n; el.textContent = ''; }
  const x = i % game.size.w, y = (i / game.size.w) | 0;
  const word = s === 'h' ? 'Hidden' : s === 'f' ? 'Flagged' : s === 'w' ? 'Wrong flag' : s === 'm' ? 'Mine' : s === 'x' ? 'Mine, exploded' : LABEL[v];
  el.setAttribute('aria-label', `${word}, row ${y + 1}, column ${x + 1}`);
  const cl = el.classList;
  cl.toggle('start', i === game.start && v < 0 && !over);
  cl.toggle('cursor', i === cursor);
  cl.toggle('hint', !!hint && 'cell' in hint && hint.cell === i);
  cl.toggle('safe', !!hint && hint.type === 'safe' && hint.cell === i);
  cl.toggle('why', !!hint && 'because' in hint && hint.because.includes(i));
  cl.toggle('better', better === i);
  if (prob && odds && v === HIDDEN && !over) {
    const p = Math.round(prob[i] * 100);
    // Numbers only where the board says something; the interior shares one value, given in the toast.
    el.dataset.p = touchesNumber(i) && p > 0 && p < 100 ? String(p) : '';
    el.style.setProperty('--pw', String(p));
    el.classList.toggle('zero', prob[i] === 0);
    el.classList.toggle('sure', prob[i] === 1);
  } else if (el.dataset.p !== undefined) { delete el.dataset.p; el.style.removeProperty('--pw'); el.classList.remove('zero', 'sure'); }
}

function renderAll() {
  for (let i = 0; i < els.length; i++) renderCell(i);
  board.dataset.state = dealing ? 'ready' : game.status;
  board.classList.toggle('odds', odds && !!prob);
  board.setAttribute('aria-activedescendant', 'c' + cursor);
}

function animate(cells: Opened[], cls: string) {
  for (const { cell, d } of cells) {
    const el = els[cell];
    el.classList.remove('pop', 'reveal', 'drop');
    el.style.setProperty('--d', String(d));
    void el.offsetWidth;
    el.classList.add(cls);
  }
}

// ---- Moves -----------------------------------------------------------------

async function act(cell: number, action: 'dig' | 'flag') {
  if (dealing || game.over) return;
  lastCell = cell;
  if (game.status === 'ready') {
    if (action !== 'dig') return;
    const g = game;
    dealing = true;
    board.dataset.state = 'ready';
    els[cell].classList.add('press');
    const mines = await dealAsync(g.size, cell, randomSeed(), g.noGuess);
    if (game !== g) return;
    dealing = false;
    els[cell].classList.remove('press');
    g.begin(mines, cell, false);
    return apply(g.reveal(cell));
  }
  const v = game.view[cell];
  if (v > 0) { const r = game.chord(cell); if (r.changed) sfx.chord(); return apply(r); }
  if (v !== HIDDEN) return;
  apply(action === 'flag' ? game.toggleFlag(cell) : game.reveal(cell));
}

function apply(r: Result) {
  if (!r.changed) return;
  $('toast').classList.remove('on');
  hint = null;
  better = null;
  if (r.opened.length) { sfx.open(r.opened.length); announce(r.opened.length === 1 ? 'Opened 1 cell' : `Opened ${r.opened.length} cells`); }
  if (r.flagged !== undefined) {
    const on = !!game.flag[r.flagged];
    sfx.flag(on);
    announce(on ? `Flagged. ${game.flagsLeft} mines left` : 'Flag removed');
  }
  if (odds && !game.over) prob = analyse({ ...game.size, view: game.view }, { prob: true }).prob;
  renderAll();
  if (r.opened.length) animate(r.opened, 'pop');
  if (game.status === 'lost') lost();
  else if (game.status === 'won') won();
  hud();
  save();
}

function lost() {
  sfx.boom();
  vibrate(60);
  const b = game.boom!;
  const w = game.size.w;
  const dist = (i: number) => Math.max(Math.abs((i % w) - (b % w)), Math.abs(((i / w) | 0) - ((b / w) | 0)));
  const mines: Opened[] = [];
  for (let i = 0; i < game.n; i++) if (game.mines![i] && i !== b && !game.flag[i]) mines.push({ cell: i, d: dist(i) });
  animate(mines, 'reveal');
  const rv = game.review();
  better = rv?.better ?? null;
  renderAll();
  if (!game.recorded) { game.recorded = true; if (game.mode !== 'shared') record(statKey(game.mode, game.noGuess), false, 0, 0, false); dailyResult(false); }
  const pct = (p: number) => `${Math.max(1, Math.round(p * 100))}%`;
  let note = '';
  if (rv?.verdict === 'mistake') note = 'There was a safe move open. It\'s outlined in green.';
  else if (rv && !Number.isNaN(rv.odds)) {
    note = `No safe move was left. That cell had a ${pct(rv.odds)} chance of being a mine.`;
    if (rv.better !== null) note += ' The outlined cell was a better bet.';
  }
  showEnd({ title: 'You hit a mine', note, canTakeBack: true });
  announce('You hit a mine. ' + note);
}

function won() {
  sfx.win();
  const flags: Opened[] = [];
  const w = game.size.w;
  for (let i = 0; i < game.n; i++) if (game.mines![i]) flags.push({ cell: i, d: (i % w) + ((i / w) | 0) });
  animate(flags, 'drop');
  const t = game.elapsed, b3 = game.bbbv;
  const rate = b3 / Math.max(t / 1000, 0.001);
  let newBest = false;
  if (!game.recorded) {
    game.recorded = true;
    // Shared boards can be crafted by anyone, and a win under a second is a board that solved itself.
    if (game.mode !== 'shared') newBest = record(statKey(game.mode, game.noGuess), true, t, rate, !game.assisted && t >= 1000).newBest;
    dailyResult(true);
  }
  showEnd({
    title: game.mode === 'daily' ? 'Today\'s board, cleared' : 'Cleared',
    time: fmt(t, true),
    badge: newBest,
    note: game.assisted ? 'Assisted, so it won\'t count toward best times.' : '',
    stats: game.clicks ? [['3BV', String(b3)], ['3BV/s', rate.toFixed(2)], ['Clicks', String(game.clicks)], ['Efficiency', Math.round((b3 / game.clicks) * 100) + '%']] : [],
  });
  announce(`Cleared in ${fmt(t, true)}`);
}

function dailyResult(won: boolean) {
  if (game.mode !== 'daily' || !game.date || data.daily[game.date]) return;
  data.daily[game.date] = { won, t: game.elapsed, bbbv: game.bbbv, clicks: game.clicks, assisted: game.assisted };
  persist();
}

// ---- End card ----------------------------------------------------------------

function showEnd(o: { title: string; time?: string; note?: string; badge?: boolean; canTakeBack?: boolean; stats?: [string, string][] }) {
  $('end-title').textContent = o.title;
  $('end-time').textContent = o.time ?? '';
  $('end-note').textContent = o.note ?? '';
  $('end-badge').hidden = !o.badge;
  $('end-stats').replaceChildren(...(o.stats ?? []).map(([k, v]) => {
    const d = document.createElement('div');
    d.innerHTML = '<dt></dt><dd></dd>';
    d.children[0].textContent = k;
    d.children[1].textContent = v;
    return d;
  }));
  $('end-back').hidden = !o.canTakeBack;
  $('end-share').textContent = 'Share';
  $('end').hidden = false;
  document.body.classList.add('ended');
}

$('end-again').onclick = () => newGame(game.mode === 'daily' || game.mode === 'shared' ? S.mode : game.mode);
$('end-back').onclick = takeBack;
$('end-share').onclick = share;

function takeBack() {
  if (!game.takeBack()) return;
  $('end').hidden = true;
  document.body.classList.remove('ended');
  better = null;
  renderAll();
  hud();
  save();
  toast('Took back the last move. This game no longer counts toward best times.');
}

async function share() {
  const url = `${location.origin}/#b=${pack({ w: game.size.w, h: game.size.h, start: game.start!, mines: game.mines! })}`;
  let text: string;
  if (game.mode === 'daily' && game.status === 'won') {
    const d = new Date(game.date + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
    text = `Minefield daily, ${d}: cleared in ${fmt(game.elapsed, true)}, ${(game.bbbv / (game.elapsed / 1000)).toFixed(2)} 3BV/s${game.assisted ? ' (with help)' : ''}.\n${location.origin}/#daily`;
  } else text = `Try this Minefield board (${game.size.w}×${game.size.h}, ${game.size.mines} mines): ${url}`;
  try {
    if (navigator.share && coarse.matches) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Copied to the clipboard.'); }
  } catch { /* the share sheet was dismissed */ }
}

// ---- Hints and odds ----------------------------------------------------------

const HINT_TEXT: Record<string, [string, string]> = {
  single: ['That number already has all its mines, so this cell is clear.', 'That number needs every hidden cell around it, so this one is a mine.'],
  pair: ['Read the two ringed numbers together: they leave this cell clear.', 'Read the two ringed numbers together: they force a mine here.'],
  enum: ['Every way the mines can sit around the ringed numbers leaves this cell clear.', 'Every way the mines can sit around the ringed numbers puts one here.'],
  count: ['Counting the mines that are left settles it: this cell is clear.', 'Counting the mines that are left settles it: this cell is a mine.'],
};

function showHint() {
  if (game.status === 'ready') return toast(coarse.matches ? 'First tap is always safe.' : 'First click is always safe.');
  if (game.over) return;
  hint = game.hint(lastCell);
  sfx.hint();
  let text = '';
  switch (hint.type) {
    case 'safe': text = HINT_TEXT[hint.kind][0]; break;
    case 'mine': text = HINT_TEXT[hint.kind][1]; break;
    case 'wrong-flag': text = 'This flag is on a safe cell.'; break;
    case 'guess': text = `No sure move here. The outlined cell is the best bet, with a ${Math.max(1, Math.round(hint.odds * 100))}% chance of a mine.`; break;
    default: text = 'Too many possibilities to work through here.';
  }
  renderAll();
  if ('cell' in hint) els[hint.cell].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  toast(text, 5000);
  announce(text);
  save();
}

function toggleOdds() {
  odds = !odds;
  for (const b of [$('odds'), $('odds2')]) b.setAttribute('aria-pressed', String(odds));
  if (odds && game.status === 'playing') {
    game.assisted = true;
    prob = analyse({ ...game.size, view: game.view }, { prob: true }).prob;
    if (!prob) toast('Too many possibilities to count here.');
    else {
      const inner = [...game.view.keys()].find((i) => game.view[i] === HIDDEN && !touchesNumber(i));
      toast(inner === undefined ? 'Odds on.' : `Odds on. Cells away from the numbers: ${Math.round(prob[inner] * 100)}%.`, 4500);
    }
    save();
  }
  renderAll();
}

// ---- HUD, toast, timer -----------------------------------------------------------

function fmt(ms: number, tenths = false) {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const sec = tenths ? (s % 60).toFixed(1).padStart(4, '0') : String(Math.floor(s % 60)).padStart(2, '0');
  return `${m}:${sec}`;
}

function hud() {
  $('left').textContent = String(game.flagsLeft);
  $('time').textContent = fmt(game.elapsed);
}
setInterval(() => { if (game.status === 'playing') $('time').textContent = fmt(game.elapsed); }, 250);

let toastTimer = 0;
function toast(text: string, ms = 3200) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('on'), ms);
}
const announce = (text: string) => { $('sr').textContent = text; };
const vibrate = (ms: number) => { if (S.haptics) navigator.vibrate?.(ms); };

function save() { data.save = game.over ? null : game.save(); persist(); }

// ---- Pointer input -------------------------------------------------------------

const cellAt = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('.c');
let press: { cell: number; x: number; y: number; timer: number; fired: boolean; id: number } | null = null;
const touches = new Map<number, { x: number; y: number }>();
let pinch: { d: number; zoom: number } | null = null;

const spread = () => { const [a, b] = [...touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
const otherTool = () => (tool === 'dig' ? 'flag' : 'dig');

function pressVisual(cell: number, on: boolean) {
  const targets = game.view[cell] > 0 ? [...neighboursOf(cell)].filter((j) => game.view[j] === HIDDEN && !game.flag[j]) : game.view[cell] === HIDDEN && !game.flag[cell] ? [cell] : [];
  for (const j of targets) els[j].classList.toggle('press', on && !game.over);
}
function neighboursOf(i: number) {
  const { w, h } = game.size, x = i % w, y = (i / w) | 0, out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) out.push(ny * w + nx);
  }
  return out;
}

function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  pressVisual(press.cell, false);
  press = null;
}

board.addEventListener('pointerdown', (e) => {
  const el = cellAt(e);
  if (e.pointerType !== 'mouse') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) { cancelPress(); pinch = { d: spread(), zoom }; return; }
  }
  if (!el) return;
  const cell = Number(el.dataset.i);
  cursor = cell;
  board.classList.remove('kbd');
  if (e.pointerType === 'mouse') {
    if (e.button === 2) { act(cell, 'flag'); return; }
    if (e.button === 1) { e.preventDefault(); act(cell, 'dig'); return; }
    if (e.button !== 0) return;
    press = { cell, x: e.clientX, y: e.clientY, timer: 0, fired: false, id: e.pointerId };
    pressVisual(cell, tool === 'dig' || game.view[cell] > 0);
    return;
  }
  press = {
    cell, x: e.clientX, y: e.clientY, fired: false, id: e.pointerId,
    timer: window.setTimeout(() => {
      if (!press || game.view[cell] !== HIDDEN) return;
      press.fired = true;
      pressVisual(cell, false);
      vibrate(12);
      act(cell, otherTool());
    }, 340),
  };
  pressVisual(cell, tool === 'dig' || game.view[cell] > 0);
});

board.addEventListener('pointermove', (e) => {
  if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && touches.size === 2) {
    const next = Math.max(1, Math.min(3, pinch.zoom * (spread() / pinch.d)));
    const [a, b] = [...touches.values()];
    zoomTo(next, (a.x + b.x) / 2, (a.y + b.y) / 2);
    return;
  }
  if (press && press.id === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
});

function endPointer(e: PointerEvent, commit: boolean) {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinch = null;
  if (!press || press.id !== e.pointerId) return;
  const p = press;
  cancelPress();
  if (!commit || p.fired) return;
  const el = cellAt(e);
  if (e.pointerType === 'mouse' && (!el || Number(el.dataset.i) !== p.cell)) return;
  act(p.cell, e.pointerType === 'mouse' ? 'dig' : tool);
}
board.addEventListener('pointerup', (e) => endPointer(e, true));
board.addEventListener('pointercancel', (e) => endPointer(e, false));
board.addEventListener('contextmenu', (e) => e.preventDefault());

function zoomTo(z: number, cx: number, cy: number) {
  const before = parseFloat(board.style.getPropertyValue('--cell'));
  zoom = z;
  fit();
  const after = parseFloat(board.style.getPropertyValue('--cell'));
  if (before === after) return;
  const r = stage.getBoundingClientRect();
  const mx = cx - r.left, my = cy - r.top;
  stage.scrollLeft = ((stage.scrollLeft + mx) * after) / before - mx;
  stage.scrollTop = ((stage.scrollTop + my) * after) / before - my;
}

// ---- Keyboard ----------------------------------------------------------------------

board.addEventListener('keydown', (e) => {
  const { w, h } = game.size;
  let x = cursor % w, y = (cursor / w) | 0;
  // Arrow keys follow the screen, so they swap axes when the board is turned.
  const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (step[e.key]) {
    let [dx, dy] = step[e.key];
    if (flip) [dx, dy] = [dy, dx];
    x = Math.max(0, Math.min(w - 1, x + dx));
    y = Math.max(0, Math.min(h - 1, y + dy));
    board.classList.add('kbd');
    const prev = cursor;
    cursor = y * w + x;
    renderCell(prev); renderCell(cursor);
    board.setAttribute('aria-activedescendant', 'c' + cursor);
    els[cursor].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    e.preventDefault();
  } else if (e.key === ' ' || e.key === 'Enter') { act(cursor, 'dig'); e.preventDefault(); }
  else if (e.key === 'f' || e.key === 'F') { act(cursor, 'flag'); e.preventDefault(); }
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.target as HTMLElement).closest('input, dialog')) return;
  const k = e.key.toLowerCase();
  if (k === 'h') showHint();
  else if (k === 'o') toggleOdds();
  else if (k === 'n') newGame(game.mode === 'daily' || game.mode === 'shared' ? S.mode : game.mode);
  else if (k === 'u') takeBack();
  else if (k === 'escape' && hint) { hint = null; renderAll(); }
});

// ---- Toolbar ----------------------------------------------------------------------

function setTool(t: 'dig' | 'flag') {
  tool = t;
  $('t-dig').setAttribute('aria-checked', String(t === 'dig'));
  $('t-flag').setAttribute('aria-checked', String(t === 'flag'));
}
$('t-dig').onclick = () => setTool('dig');
$('t-flag').onclick = () => setTool('flag');
$('hint').onclick = $('hint2').onclick = showHint;
$('odds').onclick = $('odds2').onclick = toggleOdds;

let armedNew = 0;
$('new').onclick = () => {
  // A stray tap shouldn't throw away a long game.
  if (game.status === 'playing' && game.clicks > 4 && Date.now() - armedNew > 2500) {
    armedNew = Date.now();
    return toast('Tap again to start a new game.');
  }
  newGame(game.mode === 'daily' || game.mode === 'shared' ? S.mode : game.mode);
};

// ---- Sheet ----------------------------------------------------------------------------

const sheet = $<HTMLDialogElement>('sheet');
function openSheet(tab = 'play') {
  selectTab(tab);
  refreshSheet();
  sheet.showModal();
}
function capLine() {
  const v = (id: string) => Number(($(id) as HTMLInputElement).value);
  const c = clampCustom({ w: v('cw'), h: v('ch'), mines: 1e9 }, S.noGuess);
  ($('cm') as HTMLInputElement).max = String(c.mines);
  $('cap').textContent = `Up to ${c.mines} mines on ${c.w} × ${c.h}${S.noGuess ? ' with No guessing on' : ''}.`;
}
for (const id of ['cw', 'ch']) $(id).addEventListener('input', capLine);

function selectTab(tab: string) {
  for (const b of sheet.querySelectorAll<HTMLElement>('[role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of sheet.querySelectorAll<HTMLElement>('.pane')) p.hidden = p.dataset.pane !== tab;
  if (tab === 'stats') renderStats();
}
$('menu').onclick = () => openSheet();
$('sheet-close').onclick = () => sheet.close();
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
const tabs = [...sheet.querySelectorAll<HTMLElement>('[role=tab]')];
for (const b of tabs) {
  b.onclick = () => selectTab(b.dataset.tab!);
  b.onkeydown = (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    const next = tabs[(tabs.indexOf(b) + d + tabs.length) % tabs.length];
    selectTab(next.dataset.tab!);
    next.focus();
  };
}

function refreshSheet() {
  for (const b of sheet.querySelectorAll<HTMLElement>('.mode')) b.classList.toggle('current', b.dataset.mode === game.mode);
  const c = clampCustom(S.custom, S.noGuess);
  $('custom-sub').textContent = `${c.w} × ${c.h} · ${c.mines} mines`;
  ($('cw') as HTMLInputElement).value = String(c.w);
  ($('ch') as HTMLInputElement).value = String(c.h);
  ($('cm') as HTMLInputElement).value = String(c.mines);
  const d = data.daily[today()];
  const next = new Date(); next.setUTCHours(24, 0, 0, 0);
  const at = next.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  $('daily-sub').textContent = !d ? 'Same Expert board for everyone today' : d.won ? `Cleared today in ${fmt(d.t, true)}` : `Lost today's board. A new one at ${at}`;
  capLine();
  ($('ng') as HTMLInputElement).checked = S.noGuess;
  ($('snd') as HTMLInputElement).checked = S.sound;
  ($('hap') as HTMLInputElement).checked = S.haptics;
  for (const b of sheet.querySelectorAll<HTMLElement>('[data-theme-set]')) b.setAttribute('aria-checked', String(b.dataset.themeSet === S.theme));
}

for (const b of sheet.querySelectorAll<HTMLElement>('.mode')) {
  b.onclick = () => {
    const m = b.dataset.mode as Mode;
    if (m === 'custom') { b.setAttribute('aria-expanded', String(b.parentElement!.classList.toggle('open'))); capLine(); return; }
    sheet.close();
    newGame(m);
  };
}
$('cstart').onclick = () => {
  const v = (id: string) => Number(($(id) as HTMLInputElement).value);
  S.custom = clampCustom({ w: v('cw'), h: v('ch'), mines: v('cm') }, S.noGuess);
  sheet.close();
  newGame('custom');
};
($('ng') as HTMLInputElement).onchange = (e) => {
  S.noGuess = (e.target as HTMLInputElement).checked;
  persist();
  refreshSheet();
  toast(S.noGuess ? 'No guessing from the next game.' : 'Classic boards from the next game. Some will need a guess.');
};
($('snd') as HTMLInputElement).onchange = (e) => { S.sound = (e.target as HTMLInputElement).checked; sfx.setSound(S.sound); persist(); };
($('hap') as HTMLInputElement).onchange = (e) => { S.haptics = (e.target as HTMLInputElement).checked; persist(); vibrate(12); };
for (const b of sheet.querySelectorAll<HTMLElement>('[data-theme-set]')) {
  b.onclick = () => { S.theme = b.dataset.themeSet as Settings['theme']; applyTheme(); persist(); refreshSheet(); };
}
let armedReset = 0;
$('reset').onclick = () => {
  if (Date.now() - armedReset > 3000) { armedReset = Date.now(); $('reset').textContent = 'Tap again to erase every record'; return; }
  data.stats = {};
  data.daily = {};
  persist();
  $('reset').textContent = 'Reset statistics';
  renderStats();
  toast('Statistics erased.');
};

const NAMES: Record<string, string> = { beginner: 'Beginner', intermediate: 'Intermediate', expert: 'Expert', custom: 'Custom', daily: 'Daily', shared: 'Shared boards' };
function renderStats() {
  const keys = Object.keys(data.stats);
  const box = $('stats');
  if (!keys.length) { box.innerHTML = '<p class="empty">Finish a game and your times show up here.</p>'; return; }
  const order = ['beginner', 'intermediate', 'expert', 'daily', 'custom', 'shared'];
  keys.sort((a, b) => order.indexOf(a.replace('-classic', '')) - order.indexOf(b.replace('-classic', '')) || a.length - b.length);
  const rows = keys.map((k) => {
    const r = data.stats[k];
    const [base, classic] = k.split('-');
    const best = r.best[0];
    return `<tr><td>${NAMES[base]}${classic ? '<small>Classic boards</small>' : ''}</td><td>${r.played}</td><td>${Math.round((r.won / r.played) * 100)}%</td>` +
      `<td>${best ? fmt(best.t, true) + `<small>${best.bbbvs.toFixed(2)} 3BV/s</small>` : '–'}</td><td>${r.streak}<small>best ${r.bestStreak}</small></td></tr>`;
  });
  box.innerHTML = `<table class="stat-table"><thead><tr><th>Mode</th><th>Played</th><th>Won</th><th>Best</th><th>Streak</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function applyTheme() {
  if (S.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = S.theme;
  const dark = S.theme === 'dark' || (S.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  for (const m of document.querySelectorAll('meta[name=theme-color]')) (m as HTMLMetaElement).content = dark ? '#121417' : '#ECE7DB';
}

// ---- Lifecycle ----------------------------------------------------------------------------

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { game.pause(); save(); } else game.resume();
});

let lastFlip: boolean | null = null;
new ResizeObserver(() => {
  if (!game) return;
  const f = shouldFlip();
  if (f !== lastFlip) { lastFlip = f; build(); } else fit();
}).observe(stage);

function boot() {
  applyTheme();
  sfx.setSound(S.sound);
  const hash = location.hash.slice(1);
  if (hash) history.replaceState(null, '', location.pathname);
  if (hash.startsWith('b=') && startShared(hash.slice(2))) return;
  if (hash === 'daily') return void startDaily();
  if (data.save) {
    try {
      const g = Game.load(data.save);
      if (!g.over && !(g.mode === 'daily' && g.date !== today())) {
        setGame(g);
        return;
      }
    } catch { /* a save from an older build: start fresh */ }
  }
  newGame();
}
boot();

if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js');
