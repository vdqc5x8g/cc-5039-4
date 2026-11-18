import { AdaptivePlayer } from './player.js';
import { createPolicy } from './policies.js';

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d));

const state = {
  manifest: null,
  scenarios: null,
  player: null,
  runInfo: null,
  trace: null,
  samples: [],
  lastState: null,
  recording: false,
  autoStopTimer: null,
};

function setRunState(text, kind) {
  // The pill element is replaced on each render, so always replace it whole.
  $('runmeta').innerHTML = `<span id="runState" class="pill pill-${kind}">${text}</span>`;
}

function setGate(text, visible) {
  $('gate').classList.toggle('hidden', !visible);
  if (text) $('gateText').textContent = text;
}

function buildLadder(ladder) {
  const max = Math.max(...ladder.map(r => r.kbps));
  $('ladder').innerHTML = ladder.map((r, i) => `
    <div class="rung" data-rung="${i}">
      <span class="res">${r.id} <small>${r.width}×${r.height}</small></span>
      <span class="bar"><i style="width:${Math.max(6, (r.kbps / max) * 100)}%"></i></span>
      <span>${r.kbps} kbps</span>
    </div>`).join('');
}

function markLadder(rung, presented) {
  document.querySelectorAll('.rung').forEach(el => {
    const i = Number(el.dataset.rung);
    el.classList.toggle('chosen', i === rung);
    el.classList.toggle('presented', i === presented);
  });
}

function renderLive(s) {
  state.lastState = s;
  const dur = Number.isFinite(s.duration) && s.duration > 0 ? s.duration : null;
  $('ovPlayhead').textContent = `${fmt(s.playhead, 2)}s${dur ? ` / ${fmt(dur, 0)}s` : ''}`;
  $('ovBuffer').textContent = `buffer ${fmt(s.bufferSec, 1)}s`;
  $('ovStall').classList.toggle('hidden', !s.stallActive);
  $('ovBufferBar').style.width = `${Math.min(100, (s.bufferSec / 20) * 100)}%`;
  // The badge is the rung the decoder is actually presenting (measured from the
  // video frame size), not the rung we asked for. The request is spelled out
  // separately so a mid-segment switch (requested but not yet on screen) is not
  // mistaken for a failed switch.
  $('ovRung').textContent = s.presentedId
    ? `${s.presentedId} · ${s.presentedRes} · presented`
    : '—';
  $('ovReq').textContent = s.rungId
    ? `requesting ${s.rungId} · ${s.rungRes} · ${s.rungKbps} kbps`
    : 'requesting —';
  $('ovTitle').textContent = state.manifest?.asset?.title || '';

  $('inEstimate').textContent = s.estimateKbps != null ? `${s.estimateKbps}` : '—';
  $('inEstimateSub').textContent = s.robustKbps != null ? `kbps · median ${s.robustKbps}` : 'kbps · no sample';
  $('inBuffer').textContent = `${fmt(s.bufferSec, 1)}s`;
  $('inBufferSub').textContent = `ahead · playable ${fmt(s.playableSec, 1)}s`;
  const lastReq = [...playerReqs()].reverse().find(r => r.ok && !r.cacheHit);
  $('inLastKbps').textContent = lastReq?.kbps != null ? `${lastReq.kbps}` : '—';
  $('inLastSub').textContent = lastReq
    ? `kbps · ${lastReq.transferMs}ms transfer`
    : 'kbps (first→last byte)';
  $('inTtfb').textContent = s.ttfbMeanMs != null ? `${s.ttfbMeanMs}` : '—';
  $('inTtfbSub').textContent = 'ms TTFB mean';

  const d = s.lastDecision;
  if (d) {
    $('decPick').textContent = `${d.rungId} · ${s.ladder[d.index]?.width}×${s.ladder[d.index]?.height} · ${s.ladder[d.index]?.kbps} kbps`;
    $('decReason').textContent = `${d.trigger}: ${d.reason} · buffer ${fmt(d.bufferSec, 1)}s · est ${d.estimateKbps ?? '—'} kbps`;
  }
  $('decPresented').textContent = s.presentedId
    ? `${s.presentedId} · ${s.presentedRes} (decoder frame size)`
    : 'not presented yet';
  const chips = [];
  chips.push(`<span class="chip">samples ${s.samples}</span>`);
  if (s.weakSamples) chips.push(`<span class="chip">weak ${s.weakSamples}</span>`);
  if (s.cacheHits) chips.push(`<span class="chip hit">cache hits ${s.cacheHits}</span>`);
  if (s.errorCount) chips.push(`<span class="chip err">503s ${s.errorCount}</span>`);
  if (s.presentedId && s.presentedId !== s.rungId) chips.push(`<span class="chip">presenting ${s.presentedId}</span>`);
  $('sampleChips').innerHTML = chips.join('');

  markLadder(s.rung, s.presentedRung);
  renderRequests();
  drawChart();
}

function playerReqs() {
  return state.player?.requests || [];
}

function renderRequests() {
  const reqs = playerReqs();
  const rows = reqs.slice(-40).reverse().map(r => {
    const cls = r.aborted ? 'abort' : !r.ok ? 'fail' : r.cacheHit ? 'cache' : '';
    const note = r.aborted
      ? `abandoned · ${r.abortReason}`
      : !r.ok ? `HTTP ${r.status}${r.attempt ? ` #${r.attempt}` : ''}` : r.cacheHit ? 'cache hit' : `${r.scenarioKbps ?? '—'} kbps link`;
    return `<tr class="${cls}">
      <td>${(r.tMs / 1000).toFixed(1)}s</td>
      <td>${r.type[0].toUpperCase()}${r.segIndex}</td>
      <td>${r.rungId || '—'}</td>
      <td>${(r.bytes / 1024).toFixed(0)}K</td>
      <td>${r.ttfbMs.toFixed(0)}ms</td>
      <td>${r.transferMs != null ? r.transferMs.toFixed(0) + 'ms' : '—'}</td>
      <td>${r.kbps ?? '—'}</td>
      <td>${note}</td>
    </tr>`;
  });
  $('reqTable').querySelector('tbody').innerHTML = rows.join('');
  const ok = reqs.filter(r => r.ok).length;
  const fails = reqs.filter(r => !r.ok && !r.aborted).length;
  const aborts = reqs.filter(r => r.aborted).length;
  const hit = reqs.filter(r => r.cacheHit).length;
  $('logSummary').textContent = `${reqs.length} requests · ${fails} failed · ${aborts} abandoned · ${hit} cache hits · last ${ok} ok`;
}

/* ---------------- chart ---------------- */
const chart = $('chart');
const ctx = chart.getContext('2d');

function drawChart() {
  const samples = state.samples;
  const traceSeries = state.trace?.rateSeries || [];
  const W = chart.width, H = chart.height;
  const pad = { l: 46, r: 12, t: 12, b: 24 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  ctx.clearRect(0, 0, W, H);

  const ladder = state.lastState?.ladder || [];
  const maxKbps = Math.max(
    1000,
    ...traceSeries.map(p => p.kbps),
    ...samples.map(s => Math.max(s.estimateKbps || 0, s.rung != null ? (ladder[s.rung]?.kbps || 0) : 0)),
  ) * 1.08;

  let tMax = state.trace?.durationMs || 60000;
  if (samples.length) tMax = Math.max(tMax, samples[samples.length - 1].tMs + 1000);

  const x = (t) => pad.l + (t / tMax) * plotW;
  const y = (k) => pad.t + plotH - (k / maxKbps) * plotH;

  // grid
  ctx.strokeStyle = '#16202a'; ctx.lineWidth = 1;
  ctx.fillStyle = '#5b6b7d'; ctx.font = '10px ui-monospace, monospace';
  for (let i = 0; i <= 4; i++) {
    const k = (maxKbps / 4) * i;
    const yy = y(k);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    ctx.fillText(`${Math.round(k / 100) / 10}M`.replace('.0M', 'M'), 4, yy + 3);
  }
  for (let t = 0; t <= tMax; t += 10000) {
    const xx = x(t);
    ctx.beginPath(); ctx.moveTo(xx, pad.t); ctx.lineTo(xx, H - pad.b); ctx.stroke();
    ctx.fillText(`${t / 1000}s`, xx + 2, H - 8);
  }

  // ladder bands
  ladder.forEach((r, i) => {
    const yy = y(r.kbps);
    if (yy > pad.t && yy < H - pad.b) {
      ctx.strokeStyle = 'rgba(94,200,255,0.06)';
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    }
  });

  // ground truth link
  if (traceSeries.length) {
    ctx.strokeStyle = 'rgba(107,124,144,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    traceSeries.forEach((p, i) => {
      const xx = x(p.tMs), yy = y(p.kbps);
      i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
    });
    ctx.stroke();
  }

  // estimate
  const estPts = samples.filter(s => s.estimateKbps != null);
  if (estPts.length) {
    ctx.strokeStyle = '#5ec8ff'; ctx.lineWidth = 1.6;
    ctx.beginPath();
    estPts.forEach((s, i) => {
      const xx = x(s.tMs), yy = y(s.estimateKbps);
      i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
    });
    ctx.stroke();
  }

  // requested rung (step) + presented rung (dashed/stepped, drawn thick behind)
  const stepLine = (points, color, width, dash = []) => {
    if (!points.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let prev = null;
    points.forEach((p, i) => {
      const xx = x(p.tMs), yy = y(p.kbps);
      if (i === 0) ctx.moveTo(xx, yy);
      else {
        ctx.lineTo(xx, y(prev));
        ctx.lineTo(xx, yy);
      }
      prev = p.kbps;
    });
    ctx.stroke();
    ctx.setLineDash([]);
  };

  const reqPts = samples.filter(s => s.rung != null).map(s => ({ tMs: s.tMs, kbps: ladder[s.rung]?.segmentKbps || 0 }));
  stepLine(reqPts, 'rgba(182,140,255,0.85)', 2);

  const presPts = (state.player?.presented || []).map(p => ({ tMs: p.tMs, kbps: ladder[p.rung]?.kbps || 0 }));
  if (presPts.length) {
    const lastSample = samples[samples.length - 1];
    presPts.push({ tMs: lastSample?.tMs ?? presPts[presPts.length - 1].tMs, kbps: presPts[presPts.length - 1].kbps });
    stepLine(presPts, '#56d39a', 2.4, [5, 3]);
  }

  // stalls (completed + in progress)
  const stalls = [...(state.player?.stalls || [])];
  if (state.player?.stallActive) {
    stalls.push({ ...state.player.stallActive, endMs: state.player.tMs() });
  }
  for (const st of stalls) {
    const x0 = x(st.tMs), x1 = x(st.endMs ?? (st.tMs + (st.durationMs || 0)));
    ctx.fillStyle = 'rgba(255,107,107,0.16)';
    ctx.fillRect(x0, pad.t, Math.max(2, x1 - x0), plotH);
    ctx.fillStyle = 'rgba(255,107,107,0.9)';
    ctx.fillRect(x0, pad.t, Math.max(2, x1 - x0), 3);
  }

  // scenario events
  for (const ev of state.player?.scenarioEvents || []) {
    const xx = x(ev.tMs);
    ctx.strokeStyle = 'rgba(246,178,74,0.8)'; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(xx, pad.t); ctx.lineTo(xx, H - pad.b); ctx.stroke();
    ctx.setLineDash([]);
  }
}

/* ---------------- run control ---------------- */
async function boot() {
  const [manifest, scen] = await Promise.all([
    fetch('/content/manifest.json').then(r => r.json()),
    fetch('/api/scenarios').then(r => r.json()),
  ]);
  state.manifest = manifest;
  state.scenarios = scen.scenarios;
  window.__READY__ = true;
  window.__PROTOTYPE__ = {
    state,
    run: startRun,
    stop: stopRun,
    getRecord: () => window.__LAST_RECORD__ ?? state.player?.record() ?? null,
  };
  setGate('Ready. A harness will start a scenario, or use the console: __PROTOTYPE__.run({traceId:"drop", algo:"hysteresis"})', true);
}

async function startRun({ traceId, algo, repeat = 1, runId }) {
  if (state.player) await stopRun();
  const scenario = state.scenarios.find(s => s.id === traceId);
  if (!scenario) throw new Error(`unknown trace ${traceId}`);

  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ traceId, algo, repeat, runId }),
  });
  if (!res.ok) throw new Error(`run create failed: ${res.status}`);
  state.runInfo = await res.json();
  state.trace = state.runInfo;
  window.__LAST_RECORD__ = null;
  state.samples = [];
  state.recording = true;

  setRunState(`${traceId} · ${algo}${repeat > 1 ? ` · #${repeat}` : ''}`, 'running');

  const policy = createPolicy(algo, {
    reps: state.manifest.video.representations,
    audioKbps: state.manifest.audio.actualKbps,
    segmentSec: state.manifest.asset.segmentDurationSec,
  });
  buildLadder(policy.ladder);
  $('video').innerHTML = '';

  const player = new AdaptivePlayer({
    video: $('video'),
    manifest: state.manifest,
    policy,
    traceInfo: state.runInfo,
    options: {
      onTick: (s) => {
        if (!state.recording) return;
        state.samples.push({
          tMs: s.tMs, bufferSec: s.bufferSec, estimateKbps: s.estimateKbps,
          rung: s.rung, presentedRung: s.presentedRung,
        });
        renderLive(s);
      },
    },
  });
  state.player = player;
  await player.prepare();
  await player.start();
  setGate('', false);

  window.__RUN__ = {
    getInfo: () => ({ runId: state.runInfo.runId, traceId, algo, startedAt: player.startedAt, ended: player.stopping }),
    poll: () => ({
      ...player.liveState(),
      frames: player.video.getVideoPlaybackQuality?.() || null,
      reqCount: player.requests.length,
      stallCount: player.stalls.length,
      ended: player.stopping,
    }),
    finish: async () => {
      await player.finish('harness');
      return player.record();
    },
  };

  // Stop the run at the scenario window (or the content end, whichever is
  // first), matching what the harness compares. Traces are longer than the
  // 90 s asset so every algorithm is evaluated over the same link timeline.
  const windowMs = Math.min(state.trace.durationMs || 72000, state.manifest.asset.durationSec * 1000);
  clearTimeout(state.autoStopTimer);
  state.autoStopTimer = setTimeout(async () => {
    if (state.recording) await stopRun('scenario-window');
  }, windowMs + 3000);

  return state.runInfo;
}

async function stopRun(reason) {
  if (!state.player || !state.recording) return null;
  state.recording = false;
  clearTimeout(state.autoStopTimer);
  const player = state.player;
  if (!state.runInfo) return null;
  await player.finish(reason || 'manual');
  const record = player.record();
  window.__LAST_RECORD__ = record;
  try {
    await fetch(`/api/runs/${encodeURIComponent(state.runInfo.runId)}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record }),
    });
  } catch (e) {
    console.error('record upload failed', e);
  }
  setRunState(`saved · ${record.meta.summary.algo} / ${record.meta.summary.traceId}`, 'idle');
  window.__RUN__ = null;
  return record;
}

window.addEventListener('error', (e) => {
  console.error(e.error || e.message);
});

boot().catch(err => {
  console.error(err);
  setGate(`Boot failed: ${err.message}`, true);
});
