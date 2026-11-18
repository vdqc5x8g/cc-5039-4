/**
 * Static server for the prototype plus a run-scoped network shaper.
 *
 * Every playback run gets its own token bucket. Segment responses are paced in
 * real time from a shared per-run budget, so concurrent audio/video downloads
 * compete for the same link instead of each receiving the full scenario rate.
 * The scenario functions are deterministic in wall-clock time since the run
 * started, which is what makes algorithm comparisons reproducible.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  getTrace, traceList, rateKbpsAt, ttfbMsAt, inFailureWindow,
} from './traces.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const CONTENT = path.join(ROOT, 'content');
const RUNS = path.join(ROOT, 'runs');
const PORT = Number(process.env.PORT || 4173);
const CHUNK_BYTES = 8 * 1024;
const BURST_BYTES = 8 * 1024;
const TICK_MS = 10;

await fsp.mkdir(RUNS, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4s': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

const runs = new Map();

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shouldFailPath(trace, tMs, attempt, urlPath) {
  for (const win of trace.failures) {
    if (tMs >= win.fromMs && tMs < win.toMs) {
      return (hash32(`${urlPath}#${attempt}`) % win.failEvery) >= (win.failEvery - win.failCount);
    }
  }
  return false;
}

class Run {
  constructor({ runId, traceId, algo, repeat, note }) {
    this.runId = runId;
    this.traceId = traceId;
    this.trace = getTrace(traceId);
    this.algo = algo || 'unknown';
    this.repeat = repeat ?? 1;
    this.note = note || '';
    this.startedAt = Date.now();
    this.active = [];
    this.requests = [];
    this.attempts = new Map();
    this.tokens = 0;
    this.lastTick = performance.now();
    this.pumpTimer = setInterval(() => this.tick(), TICK_MS);
    this.pumpTimer.unref?.();
    this.closed = false;
  }

  elapsedMs() {
    return Date.now() - this.startedAt;
  }

  nextAttempt(urlPath) {
    const n = (this.attempts.get(urlPath) || 0) + 1;
    this.attempts.set(urlPath, n);
    return n;
  }

  tick() {
    const now = performance.now();
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    const kbps = Math.max(0, rateKbpsAt(this.traceId, this.elapsedMs()));
    this.tokens = Math.min(BURST_BYTES, this.tokens + (kbps * 1000 / 8) * dt / 1000);

    if (this.active.length === 0) return;
    for (const entry of [...this.active]) {
      if (entry.done) continue;
      const remaining = entry.size - entry.offset;
      if (remaining <= 0) { this.finishEntry(entry); continue; }
      const grant = Math.min(CHUNK_BYTES, remaining, Math.floor(this.tokens));
      if (grant <= 0) continue;
      this.tokens -= grant;
      const slice = entry.buffer.subarray(entry.offset, entry.offset + grant);
      try {
        entry.res.write(slice);
        entry.offset += grant;
        if (entry.bytesSent === 0) entry.firstByteAt = Date.now() - this.startedAt;
        entry.bytesSent += grant;
      } catch {
        this.dropEntry(entry, 'write-error');
        continue;
      }
      if (entry.offset >= entry.size) this.finishEntry(entry);
    }
  }

  finishEntry(entry) {
    if (entry.done) return;
    entry.done = true;
    try { entry.res.end(); } catch { /* already gone */ }
    this.active = this.active.filter(e => e !== entry);
    this.record(entry, entry.status, entry.offset);
  }

  dropEntry(entry, why) {
    if (entry.done) return;
    entry.done = true;
    this.active = this.active.filter(e => e !== entry);
    this.record(entry, `aborted:${why}`, entry.offset);
  }

  record(entry, status, bytes) {
    this.requests.push({
      tMs: entry.tMs,
      path: entry.urlPath,
      type: entry.type,
      status,
      bytes,
      ttfbMs: entry.ttfbMs,
      firstByteMs: entry.firstByteAt ?? null,
      completedMs: this.elapsedMs() - entry.tMs,
      attempt: entry.attempt,
      rateKbps: +rateKbpsAt(this.traceId, entry.tMs).toFixed(1),
      cacheControl: entry.cacheControl,
    });
  }

  serve(req, res, { filePath, urlPath, type }) {
    const tMs = this.elapsedMs();
    const attempt = this.nextAttempt(urlPath);
    const ttfbMs = Math.round(ttfbMsAt(this.traceId, tMs));
    const isSegment = type === 'video' || type === 'audio';
    const cacheable = isSegment && this.trace.cacheable;
    const cacheControl = cacheable ? 'public, max-age=600, immutable' : 'no-store';
    const rate = rateKbpsAt(this.traceId, tMs);
    const fail = isSegment && shouldFailPath(this.trace, tMs, attempt, urlPath);

    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('X-Sim-Rate-Kbps', String(Math.round(rate)));
    res.setHeader('X-Sim-Ttfb-Ms', String(ttfbMs));
    res.setHeader('X-Sim-Trace', this.traceId);
    res.setHeader('X-Sim-Attempt', String(attempt));
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (fail) {
      const entry = {
        res, urlPath, type, tMs, attempt, ttfbMs, status: 503,
        bytesSent: 0, firstByteAt: null, offset: 0, size: 0,
        buffer: Buffer.alloc(0), done: false, cacheControl: 'no-store',
      };
      setTimeout(() => {
        res.statusCode = 503;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('simulated 503\n');
        this.record(entry, 503, 0);
      }, Math.min(120, Math.round(ttfbMs / 3)));
      return;
    }

    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      res.statusCode = 404;
      res.end('not found');
      this.requests.push({ tMs, path: urlPath, type, status: 404, bytes: 0, ttfbMs, attempt, rateKbps: +rate.toFixed(1), cacheControl });
      return;
    }
    const buffer = fs.readFileSync(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Type', 'video/mp4');
    res.socket?.setNoDelay?.(true);

    const entry = {
      res, urlPath, type, tMs, attempt, ttfbMs, status: 200,
      bytesSent: 0, firstByteAt: null, offset: 0, size, buffer,
      done: false, cacheControl,
    };

    entry.timer = setTimeout(() => {
      if (entry.done) return;
      this.active.push(entry);
      this.tick();
    }, ttfbMs);

    res.on('close', () => {
      if (!entry.done) {
        clearTimeout(entry.timer);
        this.dropEntry(entry, res.writableFinished ? 'closed' : 'client-abort');
      }
    });
  }

  info() {
    const trace = this.trace;
    return {
      runId: this.runId,
      traceId: this.traceId,
      traceLabel: trace.label,
      startedAt: this.startedAt,
      durationMs: trace.durationMs,
      cacheable: trace.cacheable,
      events: trace.events,
      algo: this.algo,
      repeat: this.repeat,
      rateSeries: traceListSeries(this.traceId),
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pumpTimer);
    for (const e of [...this.active]) this.dropEntry(e, 'run-closed');
  }
}

let cachedScenarios = null;
function traceListSeries(id) {
  if (!cachedScenarios) return [];
  const t = cachedScenarios.find(x => x.id === id);
  return t ? t.rateSeries : [];
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 16 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > limit) throw new Error('body too large');
    chunks.push(c);
  }
  if (!total) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function safeJoin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const resolved = path.resolve(base, '.' + path.posix.normalize('/' + decoded));
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
  return resolved;
}

function serveStatic(req, res, base, urlPath, { cache = false } = {}) {
  const filePath = safeJoin(base, urlPath);
  if (!filePath) { res.writeHead(403); res.end('forbidden'); return; }
  let stat;
  try { stat = fs.statSync(filePath); } catch { res.writeHead(404); res.end('not found'); return; }
  if (stat.isDirectory()) {
    const idx = path.join(filePath, 'index.html');
    if (fs.existsSync(idx)) return serveStatic(req, res, base, urlPath.replace(/\/?$/, '/') + 'index.html', { cache });
    res.writeHead(404); res.end('not found'); return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache ? 'no-cache' : 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/scenarios' && req.method === 'GET') {
      return json(res, 200, { scenarios: cachedScenarios });
    }

    if (pathname === '/api/runs' && req.method === 'POST') {
      const body = await readBody(req);
      const traceId = body.traceId;
      try { getTrace(traceId); } catch (e) { return json(res, 400, { error: String(e.message) }); }
      const runId = body.runId || crypto.randomUUID();
      let run = runs.get(runId);
      if (!run) {
        run = new Run({ runId, traceId, algo: body.algo, repeat: body.repeat, note: body.note });
        runs.set(runId, run);
        console.log(`[run ${runId}] started trace=${traceId} algo=${body.algo} repeat=${body.repeat ?? 1}`);
      }
      return json(res, 200, run.info());
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)(?:\/(log|record|stop))?$/);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]);
      const action = runMatch[2];
      const run = runs.get(runId);
      if (!run && action !== 'record') return json(res, 404, { error: 'unknown run' });
      if (action === 'log' && req.method === 'GET') {
        return json(res, 200, {
          runId,
          traceId: run.traceId,
          startedAt: run.startedAt,
          requests: run.requests,
        });
      }
      if (action === 'record' && req.method === 'POST') {
        const body = await readBody(req);
        const record = body.record;
        if (!record) return json(res, 400, { error: 'missing record' });
        const recordPath = path.join(RUNS, `${runId}.json`);
        await fsp.writeFile(recordPath, JSON.stringify(record));
        if (run) run.close();
        console.log(`[run ${runId}] record saved (${(JSON.stringify(record).length / 1024).toFixed(0)} KB)`);
        return json(res, 200, { ok: true, path: `runs/${runId}.json` });
      }
      if (action === 'stop' && req.method === 'POST') {
        if (run) run.close();
        return json(res, 200, { ok: true });
      }
    }

    if (pathname === '/api/runs' && req.method === 'GET') {
      const files = (await fsp.readdir(RUNS)).filter(f => f.endsWith('.json'));
      const summaries = [];
      for (const f of files) {
        try {
          const rec = JSON.parse(await fsp.readFile(path.join(RUNS, f), 'utf8'));
          summaries.push(rec.meta?.summary || { runId: f.replace(/\.json$/, '') });
        } catch { /* skip corrupt */ }
      }
      return json(res, 200, { runs: summaries });
    }

    if (pathname === '/api/manifest') {
      return serveStatic(req, res, CONTENT, '/manifest.json');
    }

    if (pathname.startsWith('/content/')) {
      const filePath = safeJoin(CONTENT, pathname.slice('/content'.length));
      if (!filePath) { res.writeHead(403); res.end('forbidden'); return; }
      const runId = url.searchParams.get('run');
      const run = runId ? runs.get(runId) : null;
      const base = path.basename(filePath);
      const type = base.startsWith('init') ? 'init'
        : /^seg-/.test(base)
          ? (path.basename(path.dirname(filePath)) === 'audio' ? 'audio' : 'video')
          : 'other';
      if (run && !run.closed && type !== 'other') {
        return run.serve(req, res, { filePath, urlPath: pathname, type });
      }
      if (type === 'init') {
        // Inits are prefetched before the measured run starts.
        return serveStatic(req, res, CONTENT, pathname.slice('/content'.length), { cache: true });
      }
      return serveStatic(req, res, CONTENT, pathname.slice('/content'.length), { cache: false });
    }

    if (pathname.startsWith('/runs/') || pathname.startsWith('/report/')) {
      return serveStatic(req, res, ROOT, pathname, { cache: false });
    }

    if (pathname === '/' || pathname === '/app' || pathname === '/app/') {
      return serveStatic(req, res, APP, '/index.html', { cache: false });
    }

    if (pathname.startsWith('/app/')) {
      return serveStatic(req, res, APP, pathname.slice('/app'.length), { cache: false });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});

cachedScenarios = traceList();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`adaptive player + shaper on http://127.0.0.1:${PORT}/app/`);
  console.log(`scenarios: ${cachedScenarios.map(s => s.id).join(', ')}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const run of runs.values()) run.close();
    server.close(() => process.exit(0));
  });
}

export { server, runs };
