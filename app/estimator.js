/**
 * Bandwidth estimator.
 *
 * Design constraints from the brief:
 *  - request wait (TTFB) is not transfer. Throughput is only computed from the
 *    first byte received to the last byte, per request;
 *  - very short transfers and cached responses are weak evidence: their rate is
 *    a lower bound (the link was at least that fast) but they must not lift the
 *    estimate to "unlimited" on their own;
 *  - the estimate is a mix of a fast-reacting EWMA over transfers and a
 *    robust recent median, so one corrupted sample (503 burst, cache hit)
 *    cannot dominate.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Estimator {
  constructor({ halfLifeMs = 2600, robustWindow = 9, robustAgeMs = 5500 } = {}) {
    this.halfLifeMs = halfLifeMs;
    this.robustWindow = robustWindow;
    this.robustAgeMs = robustAgeMs;
    this.samples = [];        // recent throughput observations (kbps)
    this.ewma = null;         // fast EWMA of transfer throughput
    this.lastUpdateMs = 0;
    this.stats = {
      calls: 0,
      samples: 0,
      transferBytes: 0,
      transferMs: 0,
      ttfbMsSum: 0,
      ttfbMsMax: 0,
      weakSamples: 0,
      cacheHits: 0,
      errors: 0,
    };
  }

  /**
   * @param {object} s
   * @param {number} s.bytes      body bytes received (0 for failures)
   * @param {number} s.transferMs first-byte-to-last-byte duration
   * @param {number} s.ttfbMs     request wait before first byte
   * @param {boolean} s.cacheHit  response served from HTTP cache (0 transfer time)
   * @param {boolean} s.ok        successful response
   * @param {number} s.now
   * @param {boolean} [s.final]   completed request (default true). In-flight
   *   transfer slices pass false: they are not a new request wait.
   */
  addSample({ bytes, transferMs, ttfbMs, cacheHit, ok, now, final = true }) {
    // Count one request wait per request, and only when the response actually
    // measured the path. In-flight slices repeat the same request's TTFB, a 503
    // is answered before any transfer, and a cache hit never touched the link.
    if (final && ok && !cacheHit) {
      this.stats.calls++;
      this.stats.ttfbMsSum += ttfbMs || 0;
      this.stats.ttfbMsMax = Math.max(this.stats.ttfbMsMax, ttfbMs || 0);
    }
    if (!ok) { this.stats.errors++; return null; }
    if (cacheHit) {
      // A cache hit says nothing about the path rate. Count it, don't learn from it.
      this.stats.cacheHits++;
      this.stats.weakSamples++;
      return null;
    }
    const minBytes = 16 * 1024;
    const minMs = 40;
    if (bytes < minBytes || transferMs < minMs) {
      // Too little transfer time to trust. Do not inflate the estimate.
      this.stats.weakSamples++;
      return null;
    }
    const kbps = (bytes * 8) / transferMs;
    this.stats.samples++;
    this.stats.transferBytes += bytes;
    this.stats.transferMs += transferMs;
    this.samples.push({ kbps, tMs: now });
    if (this.samples.length > this.robustWindow) this.samples.shift();
    // Bound the median by age as well as count. With 2 s segments a count-only
    // window holds ~18 s of history; after the link recovers the median would
    // keep reporting the old collapsed rate and the player would stay pinned to
    // the lowest rung. Old samples are simply not evidence about the link now.
    const cutoff = now - this.robustAgeMs;
    while (this.samples.length > 1 && this.samples[0].tMs < cutoff) this.samples.shift();

    const dt = Math.max(0, now - this.lastUpdateMs);
    const alpha = 1 - Math.pow(0.5, dt / this.halfLifeMs);
    this.ewma = this.ewma == null ? kbps : this.ewma + alpha * (kbps - this.ewma);
    this.lastUpdateMs = now;
    return kbps;
  }

  /** Robust central tendency: median of recent accepted samples. */
  robustKbps() {
    if (!this.samples.length) return null;
    const vals = this.samples.map(s => s.kbps).sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  }

  /** Conservative estimate used for decisions. */
  estimateKbps() {
    const fast = this.ewma;
    const robust = this.robustKbps();
    if (fast == null && robust == null) return null;
    if (robust == null) return fast;
    if (fast == null) return robust;
    // Trust the fast EWMA but never more than 1.6x the robust median: a single
    // inflated sample cannot declare "unlimited bandwidth".
    return Math.min(fast, robust * 1.6);
  }

  /** Estimate for immediately-upcoming chunks: EWMA plus a cautious factor. */
  optimisticKbps() {
    const est = this.estimateKbps();
    if (est == null) return null;
    return this.ewma == null ? est : Math.min(this.ewma, est * 1.5);
  }

  snapshot() {
    return {
      estimateKbps: this.estimateKbps(),
      ewmaKbps: this.ewma,
      robustKbps: this.robustKbps(),
      sampleCount: this.stats.samples,
      stats: { ...this.stats },
      meanTtfbMs: this.stats.calls ? this.stats.ttfbMsSum / this.stats.calls : 0,
    };
  }
}
