// Colour tokens must keep their contrast in both themes (WCAG 2.2: 3:1 for flags and numbers, 4.5:1 for text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const block = (start: string) => {
  const from = css.indexOf(start);
  return css.slice(from, css.indexOf('}', from));
};
const tokens = (src: string) => Object.fromEntries([...src.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const light = tokens(block(':root {'));
const dark = { ...light, ...tokens(block(':root[data-theme="dark"]')) };

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

for (const [name, t] of [['light', light], ['dark', dark]] as const) {
  test(`${name} theme contrast`, () => {
    const check = (fg: string, bg: string, min: number) => assert.ok(ratio(t[fg], t[bg]) >= min, `${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)} < ${min}`);
    check('accent', 'tile', 3);       // flags on hidden tiles
    check('accent-ink', 'accent', 4.5); // text on the Flag tool
    check('ink', 'bg', 4.5);
    check('muted', 'panel', 4.5);
    for (const n of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']) check(n, 'open', 3);
  });
}
