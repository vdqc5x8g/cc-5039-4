/**
 * Network scenarios used by the local shaping server.
 *
 * Each trace is a deterministic function of time since the run started, so
 * every algorithm faces the same bandwidth / latency / failure timeline.
 * The server evaluates the same functions; the browser receives their samples
 * only for labelling the chart as "scenario ground truth".
 */

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const TRACES = {
  drop: {
    id: 'drop',
    label: 'Bandwidth drop and partial recovery',
    description:
      'Fast start, sustained collapse at 16 s, recovery at 28 s, second dip at 44 s. ' +
      'Exercises down-switch safety and the ability to climb again after recovery.',
    durationMs: 72000,
    cacheable: false,
    segments: [
      { fromMs: 0, toMs: 16000, kbps: 4200 },
      { fromMs: 16000, toMs: 28000, kbps: 650 },
      { fromMs: 28000, toMs: 44000, kbps: 2600 },
      { fromMs: 44000, toMs: 72000, kbps: 900 },
    ],
    ttfbMs: (t) => 70 + 18 * Math.sin(t / 430),
    failures: [],
    events: [],
  },

  oscillate: {
    id: 'oscillate',
    label: 'Periodic bandwidth oscillation',
    description:
      'Sinusoidal link between ~450 kbps and ~5.9 Mbps with a 12 s period. ' +
      'Rewards stable switching; punishes estimators that chase every sample.',
    durationMs: 72000,
    cacheable: false,
    segments: [],
    ttfbMs: (t) => 90 + 30 * Math.sin(t / 310),
    failures: [],
    events: [],
    rate: (t) => clamp(3200 + 2800 * Math.sin(TAU * (t - 2000) / 12000), 450, 5900),
  },

  latency: {
    id: 'latency',
    label: 'Long request latency with a dip',
    description:
      'About 1.2 s wait before the first byte on every request, steady 3.4 Mbps, ' +
      'and a 1.8 Mbps window at 30-38 s. Tests separation of request wait and transfer.',
    durationMs: 72000,
    cacheable: false,
    segments: [],
    ttfbMs: (t) => 1150 + 190 * Math.sin(t / 870) + (t > 30000 && t < 38000 ? 300 : 0),
    failures: [],
    events: [],
    rate: (t) => (t >= 30000 && t < 38000 ? 1800 : 3400),
  },

  errors: {
    id: 'errors',
    label: 'Server errors plus a throttled window',
    description:
      '2.9 Mbps with 2 of every 3 requests answered 503 between 18 s and 31 s, ' +
      'then a 700 kbps window at 34-42 s. Tests retry/backoff and recovery.',
    durationMs: 72000,
    cacheable: false,
    segments: [],
    ttfbMs: (t) => 85 + 25 * Math.sin(t / 500),
    failures: [{ fromMs: 18000, toMs: 31000, failEvery: 3, failCount: 2 }],
    events: [],
    rate: (t) => (t >= 34000 && t < 42000 ? 700 : 2900),
  },

  cache: {
    id: 'cache',
    label: 'Cacheable segments with a viewer rewind',
    description:
      '3 Mbps with cacheable segments. At 26 s the scenario rewinds 8 s, forcing the ' +
      'player to re-request segments that are already in the HTTP cache. ' +
      'Those downloads must not be mistaken for unlimited bandwidth.',
    durationMs: 78000,
    cacheable: true,
    segments: [{ fromMs: 0, toMs: 78000, kbps: 3000 }],
    ttfbMs: (t) => 80 + 20 * Math.sin(t / 390),
    failures: [],
    events: [{ atMs: 26000, type: 'rewind', seconds: 8 }],
  },
};

export function getTrace(id) {
  const trace = TRACES[id];
  if (!trace) throw new Error(`Unknown trace "${id}"`);
  return trace;
}

export function traceList() {
  return Object.values(TRACES).map(t => ({
    id: t.id,
    label: t.label,
    description: t.description,
    durationMs: t.durationMs,
    cacheable: t.cacheable,
    events: t.events,
    rateSeries: rateSeries(t.id, t.durationMs, 250),
  }));
}

export function rateKbpsAt(traceId, tMs) {
  const trace = getTrace(traceId);
  if (trace.rate) return Math.max(0, trace.rate(tMs));
  const segs = trace.segments;
  if (!segs.length) return 2000;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (tMs >= segs[i].fromMs) return segs[i].kbps;
  }
  return segs[0].kbps;
}

export function ttfbMsAt(traceId, tMs) {
  return Math.max(15, getTrace(traceId).ttfbMs(tMs));
}

/**
 * Deterministic failure decision. `ordinal` counts requests inside the
 * currently active failure window; the pattern repeats every `failEvery`
 * requests and fails the last `failCount` of each group.
 */
export function shouldFail(traceId, tMs, ordinalInWindow) {
  const trace = getTrace(traceId);
  for (const win of trace.failures) {
    if (tMs >= win.fromMs && tMs < win.toMs) {
      return ordinalInWindow % win.failEvery >= win.failEvery - win.failCount;
    }
  }
  return false;
}

export function inFailureWindow(traceId, tMs) {
  return getTrace(traceId).failures.some(w => tMs >= w.fromMs && tMs < w.toMs);
}

export function rateSeries(traceId, durationMs, stepMs) {
  const out = [];
  for (let t = 0; t <= durationMs; t += stepMs) {
    out.push({ tMs: t, kbps: +rateKbpsAt(traceId, t).toFixed(1) });
  }
  return out;
}
