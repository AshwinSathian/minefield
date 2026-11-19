// Screenshots at the sizes we care about, in both themes, plus console errors.
// Usage: node scripts/shoot.ts [url] [outdir]. ONLY=phone,desktop limits sizes; MODE=expert picks the board.
import { chromium, type Page } from 'playwright';
const url = process.argv[2] ?? 'http://localhost:4173/';
const out = process.argv[3] ?? 'docs/shots';
const sizes: [string, number, number, number, boolean][] = [
  ['phone', 390, 844, 3, true], ['phone-land', 844, 390, 3, true], ['tablet', 820, 1180, 2, true], ['desktop', 1440, 900, 1, false],
];
const only = process.env.ONLY?.split(',');
const mode = process.env.MODE ?? 'expert';
const browser = await chromium.launch();

async function cellCenter(page: Page, i: number) {
  const box = (await page.locator(`#c${i}`).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

for (const scheme of ['light', 'dark'] as const) {
  for (const [name, w, h, dpr, touch] of sizes) {
    if (only && !only.includes(name)) continue;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, hasTouch: touch, isMobile: touch, colorScheme: scheme });
    const page = await ctx.newPage();
    const errs: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push(String(e.stack)));
    await page.addInitScript((m) => localStorage.setItem('minefield:v1', JSON.stringify({ v: 1, settings: { mode: m } })), mode);
    await page.goto(url);
    await page.waitForTimeout(400);
    const tag = `${out}/${name}-${scheme}`;
    await page.screenshot({ path: `${tag}-start.png` });
    const c = await cellCenter(page, Number(await page.evaluate(() => (document.querySelector('#board') as HTMLElement).getAttribute('aria-activedescendant')!.slice(1))));
    if (touch) await page.touchscreen.tap(c.x, c.y); else await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${tag}-play.png` });
    await page.keyboard.press('h');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${tag}-hint.png` });
    await page.keyboard.press('o');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${tag}-odds.png` });
    await page.keyboard.press('o');
    await page.click('#menu');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${tag}-menu.png` });
    console.log(name, scheme, errs.length ? errs.slice(0, 5).join('\n  ') : 'no errors');
    await ctx.close();
  }
}
await browser.close();
