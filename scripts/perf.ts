// Load and input timings at phone size with the CPU slowed 4x and a 4G-like network.
// Usage: node scripts/perf.ts [url]  (defaults to the live site)
import { chromium } from 'playwright';
const url = process.argv[2] ?? 'https://minefield.ashwinsathian.com/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (9e6 / 8), uploadThroughput: (1.5e6 / 8) });
await page.addInitScript(() => localStorage.setItem('minefield:v1', JSON.stringify({ v: 1, settings: { mode: 'expert', sound: false } })));
await page.goto(url, { waitUntil: 'load' });
const nav = await page.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  return { ttfb: n.responseStart, fcp: fcp?.startTime, load: n.loadEventEnd, bytes: n.transferSize };
});
console.log(`first visit, 4G + 4x CPU: TTFB ${nav.ttfb.toFixed(0)} ms, FCP ${nav.fcp?.toFixed(0)} ms, load ${nav.load.toFixed(0)} ms, ${nav.bytes} bytes`);

// Input: time from a tap to the next painted frame, for the first tap (deal + flood) and for later ones.
const tapToPaint = async (id: string) => {
  await page.evaluate((id) => {
    (window as any).__t = new Promise<number>((res) => {
      const el = document.getElementById(id)!;
      el.addEventListener('pointerup', () => { const t0 = performance.now(); setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t0))), 0); }, { once: true, capture: true });
    });
  }, id);
  const box = (await page.locator('#' + id).boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  return page.evaluate(() => (window as any).__t as Promise<number>);
};
const start = await page.evaluate(() => document.querySelector('#board')!.getAttribute('aria-activedescendant')!);
const first = await tapToPaint(start);
await page.waitForTimeout(800);
const times: number[] = [];
for (let k = 0; k < 8; k++) {
  await page.keyboard.press('h');
  const id = await page.evaluate(() => document.querySelector('.c.hint.safe')?.id);
  if (!id) break;
  times.push(await tapToPaint(id));
  await page.waitForTimeout(300);
}
times.sort((a, b) => a - b);
console.log(`first tap to paint (deal + open): ${first.toFixed(0)} ms; later taps: median ${times[times.length >> 1]?.toFixed(0)} ms, max ${times.at(-1)?.toFixed(0)} ms`);
await browser.close();
