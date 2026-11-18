import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`${BASE}/app/`);
await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 15000 });

// Drop-in trace, driven purely through the UI-facing API.
await page.evaluate(async () => window.__PROTOTYPE__.run({ traceId: 'drop', algo: 'buffer', repeat: 'uicheck' }));
await page.waitForFunction(() => window.__PROTOTYPE__.state.player?.tMs() > 34000, null, { timeout: 60000 });
await page.waitForTimeout(300);

// Read all rendered values, then screenshot.
const ui = await page.evaluate(() => ({
  estimate: document.getElementById('inEstimate').textContent,
  estimateSub: document.getElementById('inEstimateSub').textContent,
  buffer: document.getElementById('inBuffer').textContent,
  lastKbps: document.getElementById('inLastKbps').textContent,
  ttfb: document.getElementById('inTtfb').textContent,
  pick: document.getElementById('decPick').textContent,
  presentedCard: document.getElementById('decPresented').textContent,
  reason: document.getElementById('decReason').textContent,
  ovRung: document.getElementById('ovRung').textContent,
  ovReq: document.getElementById('ovReq').textContent,
  ovPlayhead: document.getElementById('ovPlayhead').textContent,
  presented: window.__PROTOTYPE__.state.player.presented,
  chartHasData: (() => {
    const c = document.getElementById('chart');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {
      if (d[i] > 40 || d[i + 1] > 50 || d[i + 2] > 60) nonBg++;
    }
    return nonBg;
  })(),
  rows: document.getElementById('reqTable').querySelectorAll('tbody tr').length,
}));
await page.screenshot({ path: '/tmp/ui-realtime.png' });

// Kill and stop cleanly.
const rec = await page.evaluate(async () => (await window.__PROTOTYPE__.stop())?.meta.summary ?? null);
console.log(JSON.stringify({ ui, record: rec && { algo: rec.algo, trace: rec.traceId, stalls: rec.stallCount, avg: rec.avgPresentedKbps } }, null, 1));
console.log('pageerrors', errors);
console.log('screenshot /tmp/ui-realtime.png');
await browser.close();

// This is a UI smoke test, not a matrix run: remove its record so it cannot
// pollute runs/ or the generated comparison report.
if (rec) {
  for (const f of fs.readdirSync('/workspace/runs')) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const p = `/workspace/runs/${f}`;
    try {
      const r = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (r?.meta?.summary?.runId === rec.runId) { fs.unlinkSync(p); console.log('removed', f); }
    } catch {}
  }
}
