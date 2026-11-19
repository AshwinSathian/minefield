// README and social images: a phone game cleared by hints (video, turned into docs/demo.gif with ffmpeg),
// a dark desktop shot with the odds view, and a light shot with a hint for the OG card and portfolio hero.
// Usage: node scripts/media.ts [url]
import { chromium, type Page } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const url = process.argv[2] ?? 'http://localhost:4173/';
const browser = await chromium.launch();

async function open(w: number, h: number, scheme: 'light' | 'dark', mode: string, touch: boolean, video?: string) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: video ? 1 : 2, colorScheme: scheme, hasTouch: touch, isMobile: touch, ...(video ? { recordVideo: { dir: video, size: { width: w, height: h } } } : {}) });
  const page = await ctx.newPage();
  await page.addInitScript((m) => localStorage.setItem('minefield:v1', JSON.stringify({ v: 1, settings: { mode: m, sound: false } })), mode);
  await page.goto(url);
  await page.waitForTimeout(500);
  return page;
}
const tapCentre = async (page: Page) => {
  const id = await page.evaluate(() => document.querySelector('#board')!.getAttribute('aria-activedescendant')!);
  await page.click('#' + id);
  await page.waitForTimeout(900);
};
/** Follow hints; stop after `limit` moves. */
async function follow(page: Page, limit: number, pause: number) {
  for (let i = 0; i < limit && !(await page.locator('#end').isVisible()); i++) {
    await page.keyboard.press('h');
    await page.waitForTimeout(pause);
    const h = await page.evaluate(() => { const e = document.querySelector('.c.hint') as HTMLElement | null; return e && { id: e.id, safe: e.classList.contains('safe') }; });
    if (!h) return;
    await page.click('#' + h.id, { button: h.safe ? 'left' : 'right', force: true });
    await page.waitForTimeout(pause / 2);
  }
}

// Demo video: Intermediate on a phone.
const dir = mkdtempSync(join(tmpdir(), 'minefield-video-'));
if (!process.env.SKIP_VIDEO) {
  const page = await open(390, 760, 'light', 'intermediate', false, dir);
  await tapCentre(page);
  await follow(page, 400, 420);
  await page.waitForTimeout(2200);
  await page.context().close();
  const file = join(dir, readdirSync(dir)[0]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', 'setpts=PTS/2.5,fps=8,scale=260:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle', 'docs/demo.gif']);
}

// Dark desktop with odds, partway through Expert.
{
  const page = await open(1280, 800, 'dark', 'expert', false);
  await tapCentre(page);
  await follow(page, 14, 60);
  await page.keyboard.press('o');
  await page.waitForTimeout(5000); // let the toast fade
  await page.screenshot({ path: 'docs/desktop.png' });
  await page.context().close();
}

// Light desktop with a hint: OG card and portfolio hero.
for (const [path, w, h] of [['public/og.png', 1200, 630], ['docs/hero.png', 1280, 800]] as const) {
  const page = await open(w, h, 'light', 'expert', false);
  await tapCentre(page);
  await follow(page, 10, 60);
  for (let k = 0; k < 6; k++) {
    await page.keyboard.press('h');
    if (await page.locator('.c.hint.safe').count()) break;
    const id = await page.evaluate(() => document.querySelector('.c.hint')?.id);
    if (id) await page.click('#' + id, { button: 'right', force: true });
  }
  await page.evaluate(() => { document.getElementById('toast')!.classList.remove('on'); (document.activeElement as HTMLElement).blur(); });
  await page.evaluate(() => document.querySelectorAll('.c.hint').forEach((e) => ((e as HTMLElement).style.animation = 'none')));
  await page.waitForTimeout(300);
  await page.screenshot({ path });
  await page.context().close();
}
await browser.close();
