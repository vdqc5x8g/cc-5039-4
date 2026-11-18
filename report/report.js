const res = await fetch('./report.json', { cache: 'no-store' });
const report = await res.json();

const $ = (id) => document.getElementById(id);
const traces = Object.keys(report.charts);
const state = { trace: traces[0] };

const TRACE_NOTES = {
  drop: 'Link collapses from 4.2 Mbps to 650 kbps at 16 s, recovers to 2.6 Mbps at 28 s, then 900 kbps at 44 s.',
  oscillate: '12 s sine between ~450 kbps and ~5.9 Mbps. Chasing every sample produces oscillation; smoothing should pay.',
  latency: '~1.2 s wait before first byte on every request, with a 1.8 Mbps window at 30–38 s. Short transfers look fast; the estimator must not read them as a fast link.',
  errors: '2 of every 3 requests get 503 between 18–31 s, then a 700 kbps window at 34–42 s. Retries must not poison the bandwidth estimate.',
  cache: 'Cacheable segments. At 26 s the viewer rewinds 8 s, so the already-buffered segments are fetched again from the HTTP cache. A cache hit must not be mistaken for unlimited bandwidth.',
};

$('title').textContent = `${report.asset.title} — adaptive bitrate comparison`;
const windows = report.comparisonWindowSec ?? {};
const windowLabel = typeof windows === 'number'
  ? `${windows}s`
  : Object.entries(windows).map(([t, s]) => `${t} ${s}s`).join(' / ');
$('subtitle').textContent =
  `${report.asset.durationSec}s asset, ${report.asset.segmentSec}s segments, ${report.asset.codec} · ` +
  `six rungs ${report.asset.ladder.map(r => r.kbps).join(' / ')} kbps · ` +
  `shared window per trace (${windowLabel}) · generated ${report.generatedAt}`;

function renderTabs() {
  $('tabs').innerHTML = traces.map(t => `<button class="tab ${t === state.trace ? 'on' : ''}" data-t="${t}">${t}</button>`).join('');
  $('tabs').querySelectorAll('.tab').forEach(el => el.addEventListener('click', () => { state.trace = el.dataset.t; render(); }));
}

function fmtKbps(v) { return `${Math.round(v)} kbps`; }

function render() {
  renderTabs();
  $('note').textContent = TRACE_NOTES[state.trace] || '';
  const data = report.charts[state.trace];
  const rows = report.table.filter(t => t.traceId === state.trace);
  const ladder = data.ladder;

  $('charts').innerHTML = data.runs.map(run => `
    <div class="card">
      <header><h3>${run.algoName} <span class="tag">${run.algo}</span></h3>
      <div class="sub">repeat ${run.repeat} · presented ${fmtKbps(run.avgPresentedKbps)} · rebuffer ${run.rebufferPct}%</div></header>
      <canvas data-run="${run.runId}" width="640" height="240"></canvas>
      <div class="metrics">
        <span>requests <b>${rows.find(r => r.algo === run.algo)?.requests ?? '—'}</b></span>
        <span>switches <b>${rows.find(r => r.algo === run.algo)?.switches ?? '—'}</b></span>
        <span>MB <b>${rows.find(r => r.algo === run.algo)?.totalMB ?? '—'}</b></span>      </div>
    </div>`).join('') + `
    <div class="legend">
      <span class="lg lg-link">scenario link</span><span class="lg lg-est">estimate</span>
      <span class="lg lg-req">requested rung</span><span class="lg lg-pres">presented rung</span>
      <span class="lg lg-stall">stall</span>
    </div>`;

  for (const run of data.runs) {
    const canvas = document.querySelector(`canvas[data-run="${run.runId}"]`);
    if (canvas) drawChart(canvas, data, run, ladder);
  }

  const bestQuality = Math.max(...rows.map(r => r.avgPresentedKbps));
  const bestRebuf = Math.min(...rows.map(r => r.meanRebufferPct));
  const leastMB = Math.min(...rows.map(r => r.totalMB));
  const leastReq = Math.min(...rows.map(r => r.requests));
  $('tbl').querySelector('thead').innerHTML =
    `<tr><th>algorithm</th><th>quality kbps</th><th>rebuffer %</th><th>stall s</th><th>switches ↑/↓</th><th>requests</th><th>traffic MB</th><th>top rung presented</th></tr>`;
  $('tbl').querySelector('tbody').innerHTML = rows.map(r => `
    <tr>
      <td>${r.algoName} <span class="tag">${r.algo}</span></td>
      <td class="${r.avgPresentedKbps === bestQuality ? 'best' : ''}">${r.avgPresentedKbps}</td>
      <td class="${r.meanRebufferPct === bestRebuf ? 'best' : (r.meanRebufferPct > 3 ? 'worst' : '')}">${r.meanRebufferPct}</td>
      <td>${r.meanStallSec}</td>
      <td>${r.upSwitches}/${r.downSwitches}</td>
      <td class="${r.requests === leastReq ? 'best' : ''}">${r.requests}</td>
      <td class="${r.totalMB === leastMB ? 'best' : ''}">${r.totalMB}</td>
      <td>${r.maxObservedId}</td>
    </tr>`).join('');
  const dom = report.pareto[state.trace].filter(p => p.dominatedBy.length);
  $('dom').innerHTML = dom.length
    ? `Dominated on this trace (no better quality, rebuffering or traffic): ` + dom.map(d => `<b>${d.algo}</b> (by ${d.dominatedBy.join(', ')})`).join(' · ')
    : 'No strategy is fully dominated on this trace.';
}

function drawChart(canvas, data, run, ladder) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const pad = { l: 44, r: 10, t: 10, b: 20 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  ctx.clearRect(0, 0, W, H);
  const tMax = (data.windowSec || 60) * 1000;
  const maxKbps = Math.max(1000, ...data.groundTruth.map(p => p.kbps), ...ladder.map(r => r.segmentKbps)) * 1.06;
  const x = (t) => pad.l + (t / tMax) * plotW;
  const y = (k) => pad.t + plotH - (k / maxKbps) * plotH;

  ctx.strokeStyle = '#16202a'; ctx.lineWidth = 1; ctx.fillStyle = '#5b6b7d'; ctx.font = '9px ui-monospace,monospace';
  for (let i = 0; i <= 3; i++) {
    const k = maxKbps * i / 3, yy = y(k);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    ctx.fillText(`${Math.round(k / 100) / 10}M`.replace('.0M', 'M'), 3, yy + 3);
  }
  for (let t = 0; t <= tMax; t += 15000) {
    const xx = x(t);
    ctx.beginPath(); ctx.moveTo(xx, pad.t); ctx.lineTo(xx, H - pad.b); ctx.stroke();
    ctx.fillText(`${t / 1000}s`, xx + 2, H - 6);
  }

  // ladder guides
  ladder.forEach(r => {
    const yy = y(r.kbps);
    if (yy > pad.t) {
      ctx.strokeStyle = 'rgba(94,200,255,0.05)';
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    }
  });

  // ground truth
  ctx.strokeStyle = 'rgba(107,124,144,0.6)'; ctx.lineWidth = 1.4;
  ctx.beginPath();
  data.groundTruth.forEach((p, i) => { const xx = x(p.tMs), yy = y(p.kbps); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
  ctx.stroke();

  // estimate
  if (run.estimate.length) {
    ctx.strokeStyle = '#5ec8ff'; ctx.lineWidth = 1.3;
    ctx.beginPath();
    run.estimate.forEach((p, i) => { const xx = x(p[0]), yy = y(p[1]); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
    ctx.stroke();
  }

  const stepLine = (pts, color, width, dash = []) => {
    if (!pts.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath();
    let prev = null;
    pts.forEach((p, i) => {
      const xx = x(p[0]), yy = y(p[1]);
      if (i === 0) ctx.moveTo(xx, yy);
      else { ctx.lineTo(xx, y(prev)); ctx.lineTo(xx, yy); }
      prev = p[1];
    });
    ctx.stroke(); ctx.setLineDash([]);
  };
  stepLine(run.requested, 'rgba(182,140,255,0.85)', 1.8);
  if (run.presented.length) {
    const last = run.presented.at(-1);
    stepLine([...run.presented, [tMax, last[1]]], '#56d39a', 2.2, [5, 3]);
  }

  for (const st of run.stalls) {
    const x0 = x(st[0]), x1 = x(st[1]);
    ctx.fillStyle = 'rgba(255,107,107,0.16)';
    ctx.fillRect(x0, pad.t, Math.max(2, x1 - x0), plotH);
    ctx.fillStyle = 'rgba(255,107,107,0.9)';
    ctx.fillRect(x0, pad.t, Math.max(2, x1 - x0), 3);
  }
}

render();
