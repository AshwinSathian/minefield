// Plays whole games through the real UI and checks the outcomes. Usage: node scripts/flow.ts [url]
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
const url = process.argv[2] ?? 'http://localhost:4173/';
const browser = await chromium.launch();
const errs: string[] = [];

async function fresh(settings: object, path = '') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('minefield:v1', JSON.stringify({ v: 1, settings: s })); } }, settings);
  await page.goto(url + path);
  await page.waitForTimeout(300);
  return page;
}

const centre = (page: Page) => page.evaluate(() => document.querySelector('#board')!.getAttribute('aria-activedescendant')!);

/** Follow hints until the game ends. Every hint on a no-guess board must be a sure move. */
async function solveWithHints(page: Page) {
  for (let i = 0; i < 600; i++) {
    if (await page.locator('#end').isVisible()) return;
    await page.keyboard.press('h');
    const h = await page.evaluate(() => {
      const el = document.querySelector('.c.hint') as HTMLElement | null;
      return el && { id: el.id, safe: el.classList.contains('safe'), s: el.dataset.s };
    });
    assert.ok(h, 'a hint was shown');
    if (h.s === 'f') await page.click('#' + h.id, { button: 'right', force: true }); // wrong flag: take it off
    else await page.click('#' + h.id, { button: h.safe ? 'left' : 'right', force: true });
  }
  throw new Error('game did not finish');
}

// 1. Win an Intermediate no-guess game using only hints.
{
  const page = await fresh({ mode: 'intermediate', noGuess: true, sound: false });
  await page.click('#' + (await centre(page)));
  await page.waitForTimeout(200);
  await solveWithHints(page);
  assert.equal(await page.textContent('#end-title'), 'Cleared');
  assert.match((await page.textContent('#end-note'))!, /doesn't count/);
  const stats = await page.evaluate(() => JSON.parse(localStorage.getItem('minefield:v1')!).stats);
  assert.equal(stats.intermediate.won, 1);
  assert.equal(stats.intermediate.best.length, 0, 'assisted wins stay off the best times');
  console.log('win with hints: ok');
  await page.context().close();
}

// 2. Lose a classic Expert game on purpose, read the review, take it back.
{
  const page = await fresh({ mode: 'expert', noGuess: false, sound: false });
  await page.click('#' + (await centre(page)));
  await page.waitForTimeout(200);
  const hidden = await page.$$eval('.c[data-s="h"]', (els) => els.map((e) => e.id));
  for (const id of hidden) {
    if (await page.locator('#end').isVisible()) break;
    if ((await page.getAttribute('#' + id, 'data-s')) === 'h') await page.click('#' + id);
  }
  assert.equal(await page.textContent('#end-title'), 'You hit a mine');
  const note = (await page.textContent('#end-note'))!;
  assert.match(note, /safe move open|No safe move was left/);
  assert.equal(await page.locator('.c[data-s="x"]').count(), 1);
  await page.click('#end-back');
  assert.ok(!(await page.locator('#end').isVisible()));
  assert.equal(await page.locator('.c[data-s="x"]').count(), 0);
  const stats = await page.evaluate(() => JSON.parse(localStorage.getItem('minefield:v1')!).stats);
  assert.equal(stats['expert-classic'].played, 1);
  console.log('loss, review and take back: ok —', note);
  // Reload keeps the game going.
  const opened = await page.locator('.c[data-s="n"], .c[data-s="o"]').count();
  await page.reload();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.c[data-s="n"], .c[data-s="o"]').count(), opened);
  console.log('resume after reload: ok');
  await page.context().close();
}

// 3. Daily opens around the ringed start and is the same board twice.
let dailyOpen = '';
for (let k = 0; k < 2; k++) {
  const page = await fresh({ sound: false }, '#daily');
  await page.waitForTimeout(400);
  const open = await page.$$eval('.c[data-s="n"], .c[data-s="o"]', (els) => els.map((e) => e.id).sort().join());
  assert.ok(open.length > 0);
  if (k) assert.equal(open, dailyOpen, 'same daily board'); else dailyOpen = open;
  if (k) { await solveWithHints(page); assert.match((await page.textContent('#end-title'))!, /cleared/); }
  await page.context().close();
}
console.log('daily: ok');

// 4. A shared link reproduces the board.
{
  const page = await fresh({ mode: 'beginner', noGuess: true, sound: false });
  await page.click('#' + (await centre(page)));
  await page.waitForTimeout(200);
  await solveWithHints(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#end-share');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const link = text.match(/#b=[\w-]+/)![0];
  const p2 = await fresh({ sound: false }, link);
  assert.equal(await p2.textContent('#mode-name'), 'Shared board');
  await solveWithHints(p2);
  assert.equal(await p2.textContent('#end-title'), 'Cleared');
  console.log('shared link: ok');
  await p2.context().close();
  await page.context().close();
}

await browser.close();
if (errs.length) { console.error('page errors:\n' + errs.join('\n')); process.exit(1); }
console.log('all flows passed');
