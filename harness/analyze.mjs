#!/usr/bin/env node
/**
 * Reduces runs/*.json into the comparison the brief asks for:
 * same asset, same network trace, every algorithm. Produces report/report.json,
 * report/summary.md and report/report.html.
 *
 * Fairness rules enforced here:
 *  - all runs of one trace are compared over the same scenario window
 *    (min of the trace duration and the content length);
 *  - objectives are reported per scenario, never averaged into a single "best"
 *    score, because no policy can be optimal on every trace;
 *  - ground-truth link series are read from the record, not reconstructed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUNS = path.join(ROOT, 'runs');
const REPORT = path.join(ROOT, 'report');

const content = JSON.parse(await fs.readFile(path.join(ROOT, 'content', 'manifest.json'), 'utf8'));
const CONTENT_SEC = content.asset.durationSec;

const files = (await fs.readdir(RUNS)).filter(f => f.endsWith('.json') && !f.startsWith('_'));
const records = [];
for (const f of files) {
  try { records.push(JSON.parse(await fs.readFile(path.join(RUNS, f), 'utf8'))); }
  catch (e) { console.warn(`skip ${f}: ${e.message}`); }
}
if (!records.length) { console.error('no runs found; run the harness first'); process.exit(1); }

const ALGO_ORDER = ['hysteresis', 'buffer', 'naive', 'fixed'];
const quantile = (arr, q) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))));
  return a[i];
};

/**
 * One comparison window per trace, shared by every algorithm and repeat:
 * the shortest wall time any run of that trace actually produced, capped by the
 * asset and the trace. A per-run window would give each policy a slightly
 * different slice of the same link timeline.
 */
const traceWindows = new Map();
for (const rec of records) {
  const id = rec.meta.summary.traceId;
  const candidate = Math.min(
    CONTENT_SEC * 1000,
    rec.meta.summary.wallMs,
    rec.groundTruth?.series?.at(-1)?.tMs ?? CONTENT_SEC * 1000,
  );
  traceWindows.set(id, Math.min(traceWindows.get(id) ?? Infinity, candidate));
}

/** Traffic used strictly inside the comparison window [0, windowSec]. */
function windowMetrics(rec) {
  const sector = rec.meta.summary;
  const windowMs = traceWindows.get(sector.traceId);
  const reqs = rec.requests.filter(r => r.tMs <= windowMs);
  const vReq = reqs.filter(r => r.type === 'video');
  const stalls = rec.stalls.filter(s => s.tMs < windowMs);
  const stallMs = stalls.reduce((a, s) => a + Math.min(s.durationMs, windowMs - s.tMs), 0);
  const played = rec.samples.filter(s => s.tMs <= windowMs);
  const playedSec = played.length ? played.at(-1).playhead : sector.playedSec;
  const qualitySec = played.length
    ? played.reduce((acc, s, i) => {
      const prev = i ? played[i - 1] : s;
      const rung = s.presentedRung != null && s.presentedRung >= 0 ? s.presentedRung : prev.presentedRung;
      const kbps = rec.meta.ladder[rung]?.kbps ?? 0;
      return acc + kbps * ((s.tMs - prev.tMs) / 1000);
    }, 0)
    : 0;
  const playedWindowSec = played.length ? (played.at(-1).tMs - played[0].tMs) / 1000 : 1;
  const avgPresented = playedWindowSec > 0.5 ? qualitySec / playedWindowSec : 0;
  const switches = rec.decisions.filter(d => d.trigger === 'segment' && d.tMs <= windowMs && d.from != null && d.index !== d.from);
  const up = switches.filter(d => d.index > d.from).length;
  const down = switches.filter(d => d.index < d.from).length;
  const byRung = new Map();
  for (const s of played) {
    const idx = s.presentedRung != null && s.presentedRung >= 0 ? s.presentedRung : null;
    if (idx == null) continue;
    const prev = played[played.indexOf(s) - 1] ?? s;
    byRung.set(idx, (byRung.get(idx) ?? 0) + Math.max(0, s.tMs - prev.tMs) / 1000);
  }
  const totalDwell = [...byRung.values()].reduce((a, b) => a + b, 0) || 1;
  const rungShare = [...byRung.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, sec]) => ({ id: rec.meta.ladder[i]?.id, width: rec.meta.ladder[i]?.width, height: rec.meta.ladder[i]?.height, kbps: rec.meta.ladder[i]?.kbps, seconds: +sec.toFixed(1), share: +(sec / totalDwell).toFixed(3) }));

  const videoBytes = vReq.reduce((a, r) => a + (r.bytes || 0), 0);
  const audioBytes = reqs.filter(r => r.type === 'audio').reduce((a, r) => a + (r.bytes || 0), 0);
  // "Top rung reached" must mean what the decoder actually presented, not what
  // was requested: an init segment appended just before the run ends can be
  // requested at v5 without a single v5 frame ever being shown.
  const seenRungs = rec.samples
    .filter(s => s.tMs <= windowMs)
    .map(s => (s.presentedRung != null && s.presentedRung >= 0 ? s.presentedRung : null))
    .filter(v => v != null);
  const maxObservedRung = seenRungs.length ? Math.max(...seenRungs) : 0;

  return {
    runId: sector.runId,
    traceId: sector.traceId,
    algo: sector.algo,
    repeat: sector.repeat,
    windowSec: +(windowMs / 1000).toFixed(1),
    playedSec: +playedSec.toFixed(2),
    stallCount: stalls.length,
    stallMs: Math.round(stallMs),
    rebufferRatio: +(stallMs / Math.max(1, stallMs + playedSec * 1000)).toFixed(4),
    startupMs: sector.startupMs,
    switches: switches.length,
    upSwitches: up,
    downSwitches: down,
    avgPresentedKbps: Math.round(avgPresented),
    rungShare,
    requests: reqs.length,
    videoRequests: vReq.length,
    failedRequests: reqs.filter(r => !r.ok && !r.aborted).length,
    abortedRequests: reqs.filter(r => r.aborted).length,
    cacheHits: reqs.filter(r => r.cacheHit).length,
    videoMB: +(videoBytes / 1e6).toFixed(2),
    audioMB: +(audioBytes / 1e6).toFixed(2),
    totalMB: +((videoBytes + audioBytes) / 1e6).toFixed(2),
    maxObservedRung,
    maxObservedId: rec.meta.ladder[maxObservedRung]?.id,
  };
}

/** Aggregated objective per (trace, algo) over repeats. */
const byTraceAlgo = new Map();
for (const rec of records) {
  const m = windowMetrics(rec);
  const key = `${m.traceId}::${m.algo}`;
  if (!byTraceAlgo.has(key)) byTraceAlgo.set(key, []);
  byTraceAlgo.get(key).push({ rec, m });
}

const traces = [...new Set(records.map(r => r.meta.summary.traceId))];
const table = [];
for (const traceId of traces) {
  const algos = [...new Set(records.filter(r => r.meta.summary.traceId === traceId).map(r => r.meta.summary.algo))]
    .sort((a, b) => ALGO_ORDER.indexOf(a) - ALGO_ORDER.indexOf(b));
  for (const algo of algos) {
    const list = byTraceAlgo.get(`${traceId}::${algo}`) ?? [];
    const ms = list.map(x => x.m);
    const avg = k => ms.reduce((a, m) => a + (m[k] ?? 0), 0) / ms.length;
    const worstRebuf = Math.max(...ms.map(m => m.rebufferRatio));
    const bestRebuf = Math.min(...ms.map(m => m.rebufferRatio));
    const first = list[0].rec;
    table.push({
      traceId,
      traceLabel: first.meta.summary.traceLabel ?? first.meta.traceLabel,
      algo,
      algoName: first.meta.summary.algoName ?? first.meta.algoName,
      repeats: ms.length,
      windowSec: ms[0].windowSec,
      avgPresentedKbps: Math.round(avg('avgPresentedKbps')),
      meanRebufferPct: +(avg('rebufferRatio') * 100).toFixed(2),
      worstRebufferPct: +(worstRebuf * 100).toFixed(2),
      bestRebufferPct: +(bestRebuf * 100).toFixed(2),
      meanStallSec: +(avg('stallMs') / 1000).toFixed(2),
      stallCount: +(avg('stallCount')).toFixed(1),
      switches: +(avg('switches')).toFixed(1),
      upSwitches: +(avg('upSwitches')).toFixed(1),
      downSwitches: +(avg('downSwitches')).toFixed(1),
      requests: Math.round(avg('requests')),
      videoRequests: Math.round(avg('videoRequests')),
      failedRequests: Math.round(avg('failedRequests')),
      abortedRequests: Math.round(avg('abortedRequests')),
      cacheHits: Math.round(avg('cacheHits')),
      totalMB: +avg('totalMB').toFixed(2),
      maxObservedId: list[0].rec.meta.ladder[Math.max(...ms.map(m => m.maxObservedRung))]?.id,
      startupMs: Math.round(avg('startupMs') ?? 0),
      rungShare: list[0].m.rungShare,
      perRepeat: ms,
    });
  }
}

/**
 * Pareto view per trace, over all three things a viewer pays for: quality
 * (higher is better), rebuffering (lower is better) and traffic (lower is
 * better). A policy dominates another only if it is at least as good on every
 * axis and strictly better on one. A policy that merely downloads more bytes to
 * buy quality is therefore not automatically "better".
 */
const pareto = {};
for (const traceId of traces) {
  const rows = table.filter(t => t.traceId === traceId);
  const EPS = 0.01;
  pareto[traceId] = rows.map(a => ({
    algo: a.algo,
    dominatedBy: rows
      .filter(b => b.algo !== a.algo)
      .filter(b => b.meanRebufferPct <= a.meanRebufferPct + EPS
        && b.avgPresentedKbps >= a.avgPresentedKbps - 1
        && b.totalMB <= a.totalMB + 0.01
        && (b.meanRebufferPct < a.meanRebufferPct - EPS
          || b.avgPresentedKbps > a.avgPresentedKbps + 1
          || b.totalMB < a.totalMB - 0.01))
      .map(b => b.algo),
  }));
}

/** Data-driven charts: ground truth + every run's decisions, same axes. */
function chartSeriesFor(traceId) {
  const series = {};
  const recs = records.filter(r => r.meta.summary.traceId === traceId);
  const ladder = recs[0]?.meta.ladder ?? [];
  const windowMs = traceWindows.get(traceId);
  series.ladder = ladder;
  series.windowSec = windowMs / 1000;
  series.groundTruth = (recs[0]?.groundTruth?.series ?? []).filter(p => p.tMs <= windowMs);
  series.runs = recs.map(rec => {
    const summary = rec.meta.summary;
    const reqPts = rec.samples.filter(s => s.tMs <= windowMs && s.rung != null)
      .map(s => [s.tMs, ladder[s.rung]?.segmentKbps ?? 0]);
    const presPts = rec.presented.filter(p => p.tMs <= windowMs)
      .map(p => [p.tMs, ladder[p.rung]?.kbps ?? 0]);
    const estPts = rec.samples.filter(s => s.tMs <= windowMs && s.estimateKbps != null)
      .map(s => [s.tMs, s.estimateKbps]);
    const stalls = rec.stalls.filter(s => s.tMs <= windowMs)
      .map(s => [s.tMs, Math.min(windowMs, s.tMs + (s.durationMs ?? 0))]);
    return {
      runId: summary.runId,
      algo: summary.algo,
      algoName: summary.algoName ?? rec.meta.algoName,
      repeat: summary.repeat,
      requested: reqPts,
      presented: presPts,
      estimate: estPts,
      stalls,
      avgPresentedKbps: windowMetrics(rec).avgPresentedKbps,
      rebufferPct: +(windowMetrics(rec).rebufferRatio * 100).toFixed(2),
    };
  });
  return series;
}

const report = {
  generatedAt: new Date().toISOString(),
  asset: { title: content.asset.title, durationSec: CONTENT_SEC, segmentSec: content.asset.segmentDurationSec, codec: content.video.codec, ladder: content.video.representations.map(r => ({ id: r.id, width: r.width, height: r.height, kbps: r.actualKbps })) },
  comparisonWindowSec: Object.fromEntries([...traceWindows].map(([t, ms]) => [t, +(ms / 1000).toFixed(1)])),
  policies: Object.fromEntries([...new Map(records.map(r => [r.meta.algo, { name: r.meta.algoName, description: r.meta.algoDescription }]))]),
  table,
  pareto,
  charts: Object.fromEntries(traces.map(t => [t, chartSeriesFor(t)])),
  runs: records.map(r => ({ runId: r.meta.summary.runId, traceId: r.meta.summary.traceId, algo: r.meta.summary.algo, repeat: r.meta.summary.repeat })),
};

await fs.mkdir(REPORT, { recursive: true });
await fs.writeFile(path.join(REPORT, 'report.json'), JSON.stringify(report, null, 2));

/* markdown summary */
const md = [];
md.push(`# Adaptive bitrate comparison — ${report.asset.title}`, '');
md.push(`Generated ${report.generatedAt}. Asset ${report.asset.durationSec}s, ${report.asset.segmentSec}s segments, ${report.asset.codec}.`);
md.push(`All policies play the same six-rung ladder and face the same deterministic link trace, each trace compared over one window shared by every policy (${Object.entries(report.comparisonWindowSec).map(([t, s]) => `${t} ${s}s`).join(', ')}).`, '');
md.push('## Policies', '');
for (const [id, p] of Object.entries(report.policies)) md.push(`- **${id}** (${p.name}) — ${p.description}`);
md.push('', '## Per-scenario results', '');
for (const traceId of traces) {
  md.push(`### ${traceId}`, '');
  md.push('| algorithm | quality (kbps) | rebuffer % | stall s | switches ↑/↓ | requests | traffic MB | top rung presented |');
  md.push('|---|---:|---:|---:|---:|---:|---:|---|');
  for (const r of table.filter(t => t.traceId === traceId)) {
    md.push(`| ${r.algo} | ${r.avgPresentedKbps} | ${r.meanRebufferPct} | ${r.meanStallSec} | ${r.upSwitches}/${r.downSwitches} | ${r.requests} | ${r.totalMB} | ${r.maxObservedId} |`);
  }
  const dominated = pareto[traceId].filter(p => p.dominatedBy.length);
  if (dominated.length) {
    md.push('', 'Dominated strategies (no better quality, rebuffering or traffic):');
    for (const d of dominated) md.push(`- ${d.algo} — dominated by ${d.dominatedBy.join(', ')}`);
  } else {
    md.push('', 'No strategy is fully dominated on this scenario.');
  }
  md.push('');
}
md.push('## Reading the results', '');
md.push('- No algorithm wins every scenario; the Pareto lists above say which trade-offs are real per trace.');
md.push('- Rebuffer % is stall time over stall time plus played time inside the comparison window.');
md.push('- Quality is time-weighted actual rung bitrate presented by the decoder, not the rung requested; the top-rung column is likewise the highest rung actually presented on screen.');
md.push('- Traffic counts every byte transferred, including bytes of a segment a policy abandoned after measuring that it could not finish.');
md.push('- The naive policy uses no estimator at all: it sizes the next rung from the raw last transfer, so short segments, cache hits and single fast downloads hit it directly. It is the control the estimator exists to beat.');
await fs.writeFile(path.join(REPORT, 'summary.md'), md.join('\n'));

await fs.writeFile(path.join(REPORT, 'index.html'), renderHtml(report, md.join('\n')));
console.log(`report: ${table.length} (trace, algo) rows from ${records.length} runs`);
console.log(path.join(REPORT, 'index.html'));

function renderHtml(report, markdown) {
  // This page is only a shell. report.js fetches report.json and renders tabs,
  // per-run charts, the table and the Pareto notes from the measured records.
  return `<!doctype html><meta charset="utf-8"><title>ABR comparison</title>
<style>
body{background:#0b0f14;color:#dbe4ee;font:13px/1.5 ui-sans-serif,system-ui;margin:0;padding:24px}
h1{font-size:18px} h2{font-size:15px;margin:28px 0 6px;color:#a9bccd}
h3{font-size:13px;margin:0} a{color:#5ec8ff}
#subtitle{color:#8496aa;margin:4px 0 16px}
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tab{background:#121821;color:#a9bccd;border:1px solid #1f2a36;border-radius:999px;padding:4px 14px;font:inherit;cursor:pointer}
.tab.on{background:#1c2a3a;color:#fff;border-color:#3d5a78}
.note{color:#8496aa;max-width:900px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:14px;margin-top:12px}
.card{background:#0c1117;border:1px solid #16202a;border-radius:10px;padding:10px 12px}
.card header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px}
.sub{color:#7d8fa3;font-size:11px}
.tag{background:#1a2634;color:#8fb5d6;border-radius:5px;padding:0 6px;font-size:10px;margin-left:6px}
canvas{width:100%;height:auto;display:block}
.legend{display:flex;gap:14px;flex-wrap:wrap;color:#8496aa;font-size:11px;margin-top:8px;grid-column:1/-1}
.lg::before{content:"";display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle}
.lg-link::before{background:rgba(107,124,144,.8)} .lg-est::before{background:#5ec8ff}
.lg-req::before{background:#b68cff} .lg-pres::before{background:#56d39a}
.lg-stall::before{background:#ff6b6b;height:8px}
.metrics{display:flex;gap:16px;color:#7d8fa3;font-size:11px;margin-top:6px}
table{border-collapse:collapse;margin:10px 0}
th,td{border:1px solid #1f2a36;padding:5px 9px;text-align:right;font-variant-numeric:tabular-nums}
th{background:#121821;color:#8496aa;font-weight:600} td:first-child,th:first-child{text-align:left}
td.best{color:#56d39a;font-weight:600} td.worst{color:#ff6b6b}
.dom{color:#8496aa;max-width:900px}
details{margin-top:18px} pre{background:#0f151d;border:1px solid #1f2a36;padding:12px;border-radius:8px;overflow:auto;color:#8496aa;white-space:pre-wrap}
</style>
<h1 id="title"></h1>
<p id="subtitle"></p>
<div class="tabs" id="tabs"></div>
<p id="note" class="note"></p>
<h2>Per-run traces</h2>
<div class="charts" id="charts"></div>
<h2>Per-scenario results</h2>
<div id="dom" class="dom"></div>
<table id="tbl"><thead></thead><tbody></tbody></table>
<details><summary>Full summary (markdown)</summary><pre>${markdown.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre></details>
<script type="module" src="./report.js"></script>`;
}
