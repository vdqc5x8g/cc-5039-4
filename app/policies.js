/**
 * ABR policies. Each policy is a pure-ish object with the same interface so the
 * same playback engine and the same network traces can drive all of them.
 *
 *   create({ reps, segmentSec, audioKbps, options }) -> policy
 *   policy.reset()
 *   policy.decide(ctx) -> { index, reason, safety }
 *   policy.feedback(evt)   // 'segmentLoaded' | 'stall' | 'switchApplied'
 *
 * ctx carries only information a real player would have: the current ladder,
 * the buffer level, the estimator outputs, recent request outcomes and the
 * last chosen rung. It never receives the scenario's ground-truth bandwidth.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const kbpsOf = r => r.actualKbps || r.nominalKbps;

// Every policy starts on the same rung: with no measurement yet, none of them
// knows the link, so a shared mid-low default keeps the comparison about
// adaptation rather than about who guessed a luckier first rung.
const DEFAULT_START_INDEX = 2;

function ladderFor(reps, audioKbps, segmentSec = 2) {
  const audio = audioKbps || 0;
  return reps.map((r, i) => ({
    index: i,
    id: r.id,
    width: r.width,
    height: r.height,
    kbps: kbpsOf(r),
    segmentKbps: kbpsOf(r) + audio,
    segmentBytes: Math.round(((kbpsOf(r) + audio) * 1000 / 8) * segmentSec),
  }));
}

/* ------------------------------------------------------------------ */
/* 1. Raw-throughput control: no estimator, no smoothing, no buffer      */
/*    model. It picks from the last completed transfer exactly, which is */
/*    the "one fast download means unlimited bandwidth" failure mode the */
/*    estimator exists to prevent.                                       */
/* ------------------------------------------------------------------ */
export function createNaive({ reps, audioKbps, segmentSec }) {
  const ladder = ladderFor(reps, audioKbps, segmentSec);
  let lastKbps = null;
  return {
    id: 'naive',
    initialIndex: DEFAULT_START_INDEX,
    name: 'Raw last transfer',
    description: 'Picks the top rung under 0.9x the last completed transfer. No estimator, no smoothing, no buffer model — the control for "one fast download means unlimited bandwidth".',
    ladder,
    reset() { lastKbps = null; },
    decide(ctx) {
      // Deliberately raw: no robust estimate, no in-flight samples, no cache
      // filtering. This is the policy the estimator is meant to beat.
      if (!lastKbps) return { index: ctx.rung ?? DEFAULT_START_INDEX, reason: 'no transfer measured yet' };
      let idx = 0;
      for (let i = 0; i < ladder.length; i++) if (ladder[i].segmentKbps <= lastKbps * 0.9) idx = i;
      return { index: idx, reason: `0.9 x last transfer ${Math.round(lastKbps)} kbps` };
    },
    feedback(evt) {
      // Deliberately raw: the last completed transfer sets the next rung, even
      // when that transfer came from the HTTP cache and took under a
      // millisecond. A real naive player has no Resource Timing tag to consult;
      // the player still labels those requests for the log, but this control
      // must be poisoned by them to show what the estimator is for.
      if (evt.type === 'segmentLoaded' && evt.ok && evt.kbps != null) lastKbps = evt.kbps;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 2. Buffer-aware: pick the highest rung whose projected download      */
/*    finishes before the buffer drains, with hysteresis and a hard     */
/*    anti-stall rule.                                                  */
/* ------------------------------------------------------------------ */
export function createBufferAware({ reps, audioKbps, segmentSec, options = {} }) {
  const ladder = ladderFor(reps, audioKbps, segmentSec);
  const upFactor = options.upFactor ?? 1.12;       // need 12% headroom
  const upStreakNeeded = options.upStreak ?? 3;    // consecutive good decisions
  const downFactor = options.downFactor ?? 1.08;   // downgrade if rate < 1.08x rung
  const safetySec = options.safetySec ?? 0.7;      // projection cushion
  let upStreak = 0;
  let current = DEFAULT_START_INDEX;
  let lastSwitchAt = 0;

  return {
    id: 'buffer',
    initialIndex: DEFAULT_START_INDEX,
    name: 'Buffer-aware threshold',
    description: 'Projected drain-time under the robust estimate, 3-decision up hysteresis (1 with a deep buffer), immediate down on safety, and abandonment of a segment the buffer cannot cover.',
    ladder,
    abandon({ prefixKbps, remainingSec, bufSec, rung }) {
      // Only when the buffer is genuinely short. With several seconds in hand a
      // transient trough still finishes before playback drains, and abandoning
      // there throws away bytes on a segment the viewer will have to re-fetch.
      if (bufSec >= 4) return null;
      if (remainingSec <= bufSec + 1.0) return null;
      let viable = 0;
      for (let i = 0; i < ladder.length; i++) if (ladder[i].segmentKbps <= prefixKbps * 0.8) viable = i;
      // One bad prefix is not proof that the rung is dead, so never collapse
      // more than two rungs on a single abandoned segment.
      return Math.max(rung - 2, Math.min(rung - 1, viable));
    },
    reset() { upStreak = 0; current = DEFAULT_START_INDEX; lastSwitchAt = 0; },
    decide(ctx) {
      const est = ctx.robustKbps ?? ctx.estimateKbps;
      if (!est) return { index: DEFAULT_START_INDEX, reason: 'probing' };
      const bufferSec = ctx.bufferSec;
      const now = ctx.now;

      // Safety first: can the current rung sustain playback?
      if (bufferSec < 2.5 || est < ladder[current].segmentKbps * downFactor) {
        let target = 0;
        for (let i = 0; i < ladder.length; i++) {
          if (ladder[i].segmentKbps * downFactor <= est) target = i;
        }
        if (bufferSec < 1.5) target = Math.min(target, Math.max(0, current - 1));
        if (target < current) {
          upStreak = 0;
          current = target;
          lastSwitchAt = now;
          return { index: target, reason: `down: buffer ${bufferSec.toFixed(1)}s, est ${Math.round(est)} kbps` };
        }
      }

      // Up only with headroom. A healthy buffer can afford a probe, so it needs
      // a single confirming decision; a thin buffer needs a streak and a wider
      // margin. Multiple rungs can be taken at once when the estimate is far
      // above the current one, instead of crawling one step per segment.
      let candidate = current;
      for (let i = current + 1; i < ladder.length; i++) {
        const rung = ladder[i];
        const downloadSec = (rung.segmentBytes * 8) / (est * 1000);
        const need = rung.segmentKbps * upFactor;
        if (est >= need && bufferSec - downloadSec > safetySec && now - lastSwitchAt > 1500) {
          candidate = i;
        } else break;
      }
      if (candidate > current) {
        upStreak++;
        const needed = bufferSec >= 5 ? 1 : upStreakNeeded;
        if (upStreak >= needed) {
          const from = current;
          current = candidate;
          upStreak = 0;
          lastSwitchAt = now;
          return { index: current, reason: `up ${from}->${current}: est ${Math.round(est)} kbps, buffer ${bufferSec.toFixed(1)}s` };
        }
      } else {
        upStreak = 0;
      }
      return { index: current, reason: `hold: est ${Math.round(est)} kbps, buffer ${bufferSec.toFixed(1)}s` };
    },
    feedback(evt) {
      if (evt.type === 'stall' || evt.type === 'abandoned') {
        upStreak = 0;
        current = evt.type === 'abandoned' ? Math.max(0, evt.index) : Math.max(0, current - 1);
        lastSwitchAt = evt.now;
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* 3. Hysteresis + throughput projection (BOLA-like conservative core)  */
/*    Multiplicative up/down thresholds that widen with buffer level.   */
/* ------------------------------------------------------------------ */
export function createHysteresis({ reps, audioKbps, segmentSec, options = {} }) {
  const ladder = ladderFor(reps, audioKbps, segmentSec);
  const baseUp = options.upFactor ?? 1.15;
  const baseDown = options.downFactor ?? 1.10;
  const minHoldMs = options.minHoldMs ?? 2000;
  let current = null;
  let lastSwitchAt = 0;
  let stableStreak = 0;
  let pendingStallRisk = false;

  return {
    id: 'hysteresis',
    initialIndex: DEFAULT_START_INDEX,
    name: 'Hysteresis + safe climb',
    description: 'Wide up thresholds that relax as buffer grows, immediate defensive down when the estimate approaches the current rung, and a re-probe after sustained empty buffer.',
    ladder,
    abandon({ prefixKbps, remainingSec, bufSec, rung }) {
      // Only when the buffer is genuinely short. With several seconds in hand a
      // transient trough still finishes before playback drains, and abandoning
      // there throws away bytes on a segment the viewer will have to re-fetch.
      if (bufSec >= 4) return null;
      if (remainingSec <= bufSec + 1.0) return null;
      let viable = 0;
      for (let i = 0; i < ladder.length; i++) if (ladder[i].segmentKbps <= prefixKbps * 0.8) viable = i;
      // One bad prefix is not proof that the rung is dead, so never collapse
      // more than two rungs on a single abandoned segment.
      return Math.max(rung - 2, Math.min(rung - 1, viable));
    },
    reset() { current = null; lastSwitchAt = 0; stableStreak = 0; pendingStallRisk = false; },
    decide(ctx) {
      const est = ctx.estimateKbps;
      const bufferSec = ctx.bufferSec;
      const now = ctx.now;
      if (est == null || current == null) {
        // Conservative start; climb quickly if the link is good.
        current = DEFAULT_START_INDEX;
        lastSwitchAt = now;
        return { index: current, reason: 'start mid-low' };
      }

      const cur = ladder[current];

      // Defensive: estimate cannot carry the current rung -> drop just enough.
      // In a hard collapse, no buffer cushion survives a download on the
      // current rung, so drop all the way to what the estimate can carry
      // instead of one rung at a time toward a stall.
      //
      // Do not act on one or two samples: right after start-up the estimate is
      // still forming, and a single slow first request would otherwise slam the
      // player to the lowest rung before it has measured the link at all.
      const confident = (ctx.sampleCount ?? 0) >= 3;
      const curDownloadSec = (cur.segmentBytes * 8) / (Math.max(1, est) * 1000);
      const collapse = confident && curDownloadSec > bufferSec + 0.5;
      if (collapse || (confident && est < cur.segmentKbps * baseDown)) {
        const targetKbps = Math.min(est, cur.segmentKbps / (1 + Math.max(0, curDownloadSec) / 6));
        let target = 0;
        for (let i = 0; i < ladder.length; i++) if (ladder[i].segmentKbps * baseDown <= targetKbps) target = i;
        if (!collapse && bufferSec > 6 && target < current) target = Math.min(current, target + 1);
        if (target !== current) {
          current = target;
          lastSwitchAt = now;
          stableStreak = 0;
          return { index: current, reason: `defensive down: est ${Math.round(est)} < ${Math.round(cur.segmentKbps * baseDown)}` };
        }
      }

      // Anti-stall: buffer nearly empty -> lowest rung, then re-probe upward
      // once the buffer has rebuilt and the estimate has recovered.
      if (bufferSec < 1.0 && !pendingStallRisk) {
        pendingStallRisk = true;
        if (current > 0) {
          current = Math.max(0, current - 1);
          lastSwitchAt = now;
          return { index: current, reason: 'low buffer: step down' };
        }
      }
      if (bufferSec > 3.5) pendingStallRisk = false;

      // Up: require a safety margin that tightens as the buffer deepens, and
      // allow a multi-rung climb when the estimate clearly supports it — a
      // recovered link should not have to climb one rung per segment.
      const holdOk = now - lastSwitchAt >= minHoldMs;
      if (holdOk) {
        let target = current;
        for (let i = current + 1; i < ladder.length; i++) {
          const need = ladder[i].segmentKbps * (bufferSec >= 6 ? baseUp : baseUp * 1.25);
          const downloadSec = (ladder[i].segmentBytes * 8) / (est * 1000);
          if (est > need && bufferSec - downloadSec > 1.2) target = i; else break;
        }
        if (target > current) {
          stableStreak++;
          if (stableStreak >= 2) {
            const from = current;
            current = target;
            stableStreak = 0;
            lastSwitchAt = now;
            return { index: current, reason: `up ${from}->${current}: est ${Math.round(est)} kbps` };
          }
        } else {
          stableStreak = 0;
        }
      }

      return { index: current, reason: `hold @${cur.id}: est ${Math.round(est)}, buffer ${bufferSec.toFixed(1)}s` };
    },
    feedback(evt) {
      if (evt.type === 'stall') {
        current = Math.max(0, (current ?? 0) - 1);
        stableStreak = 0;
        lastSwitchAt = evt.now;
        pendingStallRisk = true;
      }
      if (evt.type === 'abandoned') {
        current = evt.index;
        stableStreak = 0;
        lastSwitchAt = evt.now;
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* 4. Fixed rung control (reference): always plays one rung.            */
/* ------------------------------------------------------------------ */
export function createFixed({ reps, audioKbps, segmentSec, options = {} }) {
  const ladder = ladderFor(reps, audioKbps, segmentSec);
  const index = clamp(options.index ?? Math.floor(ladder.length / 2), 0, ladder.length - 1);
  return {
    id: 'fixed',
    initialIndex: index,
    name: `Fixed ${ladder[index].id}`,
    description: `Always requests the ${ladder[index].id} rung (${ladder[index].width}x${ladder[index].height}). Reference point, not adaptive.`,
    ladder,
    reset() {},
    decide() { return { index, reason: 'fixed' }; },
    feedback() {},
  };
}

export function createPolicy(id, cfg) {
  switch (id) {
    case 'naive': return createNaive(cfg);
    case 'buffer': return createBufferAware(cfg);
    case 'hysteresis': return createHysteresis(cfg);
    case 'fixed': return createFixed(cfg);
    default: throw new Error(`Unknown policy "${id}"`);
  }
}

export const POLICY_IDS = ['hysteresis', 'buffer', 'naive', 'fixed'];
