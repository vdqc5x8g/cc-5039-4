#!/usr/bin/env node
/**
 * Runs every (scenario x algorithm x repeat) combination in Chromium against
 * the local shaping server, and saves the raw per-run records under runs/.
 *
 * Usage:
 *   node harness/run.mjs --traces=drop,oscillate --algos=hysteresis,buffer --repeats=1
 *   node harness/run.mjs --traces=all --algos=all --repeats=2
 *
 * Each run:
 *   1. starts a fresh browser context (empty caches, seeded determinism as needed)
 *   2. asks the server to create a run and returns its absolute start time
 *   3. waits for the asset to play to the end or for a scenario-specific stop
 *   4. pulls the in-page record and posts it; the server writes runs/<id>.json
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const TRACE_IDS = ['drop', 'oscillate', 'latency', 'errors', 'cache'];
const ALGO_IDS = ['hysteresis', 'buffer', 'naive', 'fixed'];
const traces = (args.traces || 'drop').split(',').flatMap(v => (v === 'all' ? TRACE_IDS : [v]));
const algos = (args.algos || 'hysteresis,buffer,naive,fixed').split(',').flatMap(v => (v === 'all' ? ALGO_IDS : [v]));
const repeats = Number(args.repeats || 1);
const timeoutMs = Number(args.timeout || 300000);

async function api(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}`, opts);
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}`);
  return res.json();
}

function cookiesForCache() {
  // Cache trace needs HTTP caching enabled, which Playwright's context does by
  // default; other traces are explicitly no-store from the shaper.
  return [];
}

async function playRun(browser, { traceId, algo, repeat }) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', m => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`));

  const t0 = Date.now();
  try {
    await page.goto(`${BASE}/app/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => window.__READY__ === true, { timeout: 20000 });
    const info = await page.evaluate(
      ({ traceId, algo, repeat }) => window.__PROTOTYPE__.run({ traceId, algo, repeat }),
      { traceId, algo, repeat },
    );

    const traceDuration = info.durationMs || 72000;
    const deadline = Date.now() + Math.min(timeoutMs, traceDuration + 45000);
    let lastPoll = null;
    let lastReqCount = 0;
    let idlePolls = 0;
    let endedSeen = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      lastPoll = await page.evaluate(() => window.__RUN__?.poll() ?? null).catch(() => null);
      if (!lastPoll) { endedSeen = true; break; }
      if (lastPoll.ended) { endedSeen = true; break; }
      // Stop once the video has reached the content end and the final segment
      // has been requested; scenarios are shorter than the asset.
      const contentEnd = lastPoll.duration - 0.05;
      const reachedEnd = lastPoll.playhead >= contentEnd;
      const noNewRequests = lastPoll.reqCount === lastReqCount;
      lastReqCount = lastPoll.reqCount;
      idlePolls = noNewRequests ? idlePolls + 1 : 0;
      if (reachedEnd && idlePolls >= 4) { break; }
      // Traces have a fixed duration; stop shortly after it so every algorithm
      // is compared over exactly the same scenario window.
      if (lastPoll.tMs >= traceDuration + 2000) break;
    }

    const record = await page.evaluate(async () => {
      if (!window.__RUN__) return null;
      return await window.__RUN__.finish();
    });
    if (!record) throw new Error('no record produced');
    await fetch(`${BASE}/api/runs/${encodeURIComponent(info.runId)}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record }),
    });
    record.harness = { wallMs: Date.now() - t0, endedSeen, consoleLines: consoleLines.slice(-40) };
    return record;
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  await fs.mkdir(path.join(ROOT, 'runs'), { recursive: true });
  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  await api('/api/scenarios');

  const plan = [];
  for (const traceId of traces) {
    for (const algo of algos) {
      for (let r = 1; r <= repeats; r++) plan.push({ traceId, algo, repeat: r });
    }
  }
  console.log(`harness: ${plan.length} runs (${traces.length} traces x ${algos.length} algos x ${repeats} repeats)`);

  const results = [];
  for (const [i, job] of plan.entries()) {
    const label = `${job.traceId}/${job.algo}#${job.repeat}`;
    process.stdout.write(`[${i + 1}/${plan.length}] ${label} ... `);
    const started = Date.now();
    try {
      const record = await playRun(browser, job);
      const s = record.meta.summary;
      results.push({ label, ok: true, runId: s.runId, ms: Date.now() - started, summary: s });
      console.log(
        `ok ${((Date.now() - started) / 1000).toFixed(0)}s · ` +
        `stalls ${s.stallCount} (${(s.stallTotalMs / 1000).toFixed(1)}s) · ` +
        `sw ${s.switches} · avg ${s.avgPresentedKbps} kbps · ${s.playheadSec ?? s.playedSec}s`,
      );
    } catch (err) {
      results.push({ label, ok: false, error: String(err.stack || err) });
      console.log(`FAILED: ${err.message}`);
    }
  }

  await browser.close();
  const manifest = {
    generatedAt: new Date().toISOString(),
    traceIds: traces,
    algoIds: algos,
    repeats,
    results,
  };
  await fs.writeFile(path.join(ROOT, 'runs', '_harness.json'), JSON.stringify(manifest, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} runs recorded${failed ? `, ${failed} failed` : ''}`);
  if (failed) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
