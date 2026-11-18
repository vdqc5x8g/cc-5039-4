/**
 * Adaptive playback engine.
 *
 * Real pipeline: fetch MP4 segments over HTTP, append them to MSE
 * SourceBuffers, render into a <video>. The only simulated parts are the link
 * itself (server token bucket from server/traces.mjs) and the viewer actions
 * declared by the scenario (e.g. the rewind in the cache trace).
 *
 * Measured per request:
 *   ttfbMs      request start -> first response byte (waiting, not transfer)
 *   transferMs  first byte -> last byte (what the estimator learns from)
 *   bytes       body length
 *   cacheHit    response did not come from the shaper (served by HTTP cache)
 */

import { Estimator } from './estimator.js';

const SEG_SEC = 2;

const now = () => performance.now();

export class AdaptivePlayer {
  constructor({ video, manifest, policy, traceInfo, options = {} }) {
    this.video = video;
    this.manifest = manifest;
    this.policy = policy;
    this.trace = traceInfo;
    this.estimator = new Estimator();
    this.options = {
      // Shallow enough that the rung on screen tracks decisions within a few
      // seconds; deep enough to ride out a 1 s request wait plus a 2 s segment.
      maxBufferSec: 8,
      backBufferSec: 3,
      targetBufferSec: 6,
      schedulerMs: 120,
      ...options,
    };
    this.reps = manifest.video.representations;
    this.segCount = this.reps[0].segments.length;
    this.audioSegs = manifest.audio.segments;
    this.audioKbps = manifest.audio.actualKbps;

    this.startedAt = null;
    this.endedAt = null;
    this.perf0 = null;

    this.videoSB = null;
    this.audioSB = null;
    this.mediaSource = null;
    this.objectUrl = null;

    this.rung = null;              // currently selected rung index
    this.nextVideoSeg = 0;
    this.nextAudioSeg = 0;
    this.videoBusy = false;
    this.audioBusy = false;
    this.appendVideo = Promise.resolve();
    this.appendAudio = Promise.resolve();
    this.stopping = false;

    this.requests = [];
    this.decisions = [];
    this.samples = [];
    this.stalls = [];
    this.presented = [];
    this.errors = [];
    this.scenarioEvents = [];
    this.firedEvents = new Set();

    this.presentedRung = null;
    this.presentedSince = 0;
    this.dwell = new Map();
    this.frameCounts = new Map();
    this.lastFrameMediaTime = 0;

    this.stallActive = null;
    this.stallTotalMs = 0;
    this.startupMs = null;
    this.firstFrameAt = null;
    this.playingSince = null;

    this.lastAdvancedTime = 0;
    this.lastAdvanceCheck = now();
    this.playheadMoved = false;
    this.sampleTimer = null;
    this.schedTimer = null;
    this.monitorRaf = 0;

    this.onTick = options.onTick || (() => {});
    this._playPromise = null;
  }

  tMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  async prepare() {
    // Inits are static, unshaped assets: fetch before the measured run begins.
    // Ask the policy which rung it starts on so the pre-loaded init matches the
    // first segment the policy will request.
    const initial = this.policy.ladder[this.policy.initialIndex ?? 1] ?? this.policy.ladder[0];
    // The measured run has not started yet; the server serves inits unshaped
    // once the run is closed/not-yet-created, so these do not pollute request logs.
    const [vInit, aInit] = await Promise.all([
      fetch(`/${this.reps[initial.index].init}`).then(r => r.arrayBuffer()),
      fetch(`/${this.manifest.audio.init}`).then(r => r.arrayBuffer()),
    ]);
    this.initialRung = initial.index;
    this.initialVideoInit = vInit;
    this.audioInit = aInit;
    this.policy.reset();
  }

  async start() {
    this.startedAt = this.trace.startedAt ?? Date.now();
    this.perf0 = now();
    this.buildMediaSource();

    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error('MediaSource failed to open')); };
      const cleanup = () => {
        this.mediaSource.removeEventListener('sourceopen', onOpen);
        this.mediaSource.removeEventListener('error', onErr);
      };
      this.mediaSource.addEventListener('sourceopen', onOpen, { once: true });
      this.mediaSource.addEventListener('error', onErr, { once: true });
      setTimeout(onErr, 8000);
    });

    const vmime = `video/mp4; codecs="${this.manifest.video.codec}"`;
    const amime = `audio/mp4; codecs="${this.manifest.audio.codec}"`;
    if (!MediaSource.isTypeSupported(vmime)) throw new Error(`codec unsupported: ${vmime}`);

    this.videoSB = this.mediaSource.addSourceBuffer(vmime);
    this.videoSB.mode = 'segments';
    this.audioSB = this.mediaSource.addSourceBuffer(amime);
    this.audioSB.mode = 'segments';

    await this.appendBuffer(this.videoSB, this.initialVideoInit, 'video-init');
    await this.appendBuffer(this.audioSB, this.audioInit, 'audio-init');

    this.rung = this.initialRung;
    this.logDecision({ index: this.rung, reason: 'initial rung before measurement' }, {
      bufferSec: 0, estimateKbps: null, robustKbps: null, trigger: 'startup',
    });

    this.installMediaListeners();
    this._playPromise = this.video.play().catch(err => {
      this.errors.push({ tMs: this.tMs(), where: 'play', message: String(err) });
    });

    this.startMonitors();
    this.schedule();
    return this.tMs();
  }

  buildMediaSource() {
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
  }

  async appendBuffer(sb, data, label) {
    // A remove() from eviction or a prior append can still be in progress.
    while (sb.updating) await new Promise(r => setTimeout(r, 15));
    return new Promise((resolve, reject) => {
      const onEnd = () => { cleanup(); resolve(); };
      const onErr = () => {
        cleanup();
        const err = new Error(`SourceBuffer error appending ${label}`);
        this.errors.push({ tMs: this.tMs(), where: 'append', label, message: err.message });
        reject(err);
      };
      const cleanup = () => {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error', onErr);
      };
      sb.addEventListener('updateend', onEnd);
      sb.addEventListener('error', onErr);
      try {
        sb.appendBuffer(data);
      } catch (e) {
        cleanup();
        this.errors.push({ tMs: this.tMs(), where: 'append-throw', label, message: String(e) });
        reject(e);
      }
    });
  }

  installMediaListeners() {
    const v = this.video;
    v.addEventListener('waiting', () => this.beginStall('waiting'));
    v.addEventListener('stalled', () => this.beginStall('stalled'));
    v.addEventListener('playing', () => this.endStall('playing'));
    v.addEventListener('seeking', () => this.beginStall('seeking'));
    v.addEventListener('seeked', () => this.endStall('seeked'));
    v.addEventListener('ended', () => this.finish('ended'));
    v.addEventListener('error', () => {
      this.errors.push({ tMs: this.tMs(), where: 'video', message: v.error?.message || 'media error' });
    });
    const onFrame = (ts, meta) => {
      this.monitorRaf = v.requestVideoFrameCallback(onFrame);
      this.recordFrame(meta);
    };
    this.monitorRaf = v.requestVideoFrameCallback(onFrame);
  }

  recordFrame(meta) {
    const t = this.tMs();
    if (this.firstFrameAt == null) {
      this.firstFrameAt = t;
      this.startupMs = t;
      if (this.startupWait) { this.startupWait.endMs = t; this.startupWait = null; }
    }
    const w = meta.width;
    const h = meta.height;
    const idx = this.reps.findIndex(r => r.width === w && r.height === h);
    if (idx !== this.presentedRung) {
      if (this.presentedRung != null) {
        const dwell = t - this.presentedSince;
        this.dwell.set(this.presentedRung, (this.dwell.get(this.presentedRung) || 0) + dwell);
      }
      this.presentedRung = idx;
      this.presentedSince = t;
      this.presented.push({ tMs: t, mediaTime: +meta.mediaTime.toFixed(2), rung: idx, width: w, height: h });
    }
    this.frameCounts.set(idx, (this.frameCounts.get(idx) || 0) + 1);
    this.lastFrameMediaTime = meta.mediaTime;
  }

  beginStall(reason) {
    if (this.stallActive) return;
    if (this.video.ended) return;
    if (this.video.readyState >= 3 && this.video.paused) return;
    // The wait before the first rendered frame is startup latency, not a
    // rebuffer event; it is reported separately as startupMs.
    if (this.firstFrameAt == null) {
      if (!this.startupWait) this.startupWait = { tMs: this.tMs(), reason };
      return;
    }
    // 'stalled' and 'seeking' are not rebuffering: one is a transport hint, the
    // other is a viewer action. A single 'waiting' during start-up decode
    // queueing is not rebuffering either. Reporting those as stalls would feed
    // spurious 'stall' feedback to the policy and knock it down a rung before it
    // has measured anything. A genuine stall is confirmed by the watchdog, which
    // opens it only after the playhead has actually stopped advancing.
    if (reason === 'stalled' || reason === 'seeking' || reason === 'waiting') return;
    this.stallActive = {
      tMs: this.tMs(),
      playhead: +this.video.currentTime.toFixed(2),
      playheadAtStart: this.video.currentTime,
      bufferSec: +this.bufferAhead().video.toFixed(2),
      reason,
      rung: this.rung,
    };
    this.policy.feedback?.({ type: 'stall', now: this.tMs() });
  }

  endStall(reason) {
    if (!this.stallActive) return;
    const end = this.tMs();
    const dur = end - this.stallActive.tMs;
    this.stallActive.durationMs = dur;
    this.stallActive.endedBy = reason;
    this.stallTotalMs += dur;
    this.stalls.push({ ...this.stallActive, endMs: end });
    this.stallActive = null;
  }

  bufferAhead() {
    const v = this.video;
    const t = v.currentTime;
    const aheadFor = (sb) => {
      if (!sb || !sb.buffered.length) return 0;
      for (let i = 0; i < sb.buffered.length; i++) {
        const s = sb.buffered.start(i);
        const e = sb.buffered.end(i);
        if (t >= s && t <= e) return e - t;
        if (s > t) return -(s - t); // gap between playhead and next buffered range
      }
      return 0;
    };
    const vAhead = aheadFor(this.videoSB);
    const aAhead = aheadFor(this.audioSB);
    const video = Math.max(0, vAhead);
    const audio = Math.max(0, aAhead);
    let rangeCount = 0;
    if (this.videoSB?.buffered) rangeCount = this.videoSB.buffered.length;
    return {
      video,
      audio,
      playable: Math.min(video, audio),
      gapAhead: vAhead < 0 ? -vAhead : 0,
      ranges: rangeCount,
    };
  }

  startMonitors() {
    this.sampleTimer = setInterval(() => this.collectSample(), 250);
    this.schedTimer = setInterval(() => this.schedule(), this.options.schedulerMs);
    this.evictTimer = setInterval(() => this.evictBehind(), 1000);
    this.watchdog = setInterval(() => this.checkTimeline(), 100);
  }

  checkTimeline() {
    const t = this.tMs();
    // Viewer actions declared by the scenario.
    for (const [i, ev] of (this.trace.events || []).entries()) {
      if (t >= ev.atMs && !this.firedEvents.has(i)) {
        this.firedEvents.add(i);
        this.applyScenarioEvent(ev);
      }
    }
    // Stalls are closed by evidence of progress, not only by the 'playing'
    // event: headless Chromium does not always emit 'playing' after a seek or
    // a mid-stream wait that resolves. If the playhead has moved on by more
    // than a frame, the stall is over.
    const ct = this.video.currentTime;
    if (this.stallActive && ct - this.stallActive.playheadAtStart > 0.05) {
      this.endStall('progress');
    }
    // Track playhead movement unconditionally, so `playheadMoved` can actually
    // become true. (Gating this update on playheadMoved made the watchdog
    // permanently disarmed and hid every real stall.)
    if (ct - this.lastAdvancedTime > 0.02) {
      this.lastAdvancedTime = ct;
      this.lastAdvanceCheck = now();
      this.playheadMoved = true;
    }
    // Watchdog against a frozen playhead with no media event, armed only after
    // the playhead has advanced at least once: right after the first frame the
    // element still reports currentTime 0 and initial decode start-up would
    // otherwise be logged as a rebuffer event.
    if (this.playheadMoved && !this.video.paused && !this.video.seeking && !this.video.ended) {
      if (now() - this.lastAdvanceCheck > 600 && !this.stallActive) {
        this.beginStall('watchdog');
      }
    }
  }

  async applyScenarioEvent(ev) {
    if (ev.type !== 'rewind') return;
    const from = this.video.currentTime;
    const to = Math.max(0, from - ev.seconds);
    this.scenarioEvents.push({ tMs: this.tMs(), type: 'rewind', fromSec: +from.toFixed(2), toSec: +to.toFixed(2) });
    const target = Math.floor(to / SEG_SEC) * SEG_SEC;
    this.nextVideoSeg = Math.floor(target / SEG_SEC);
    this.nextAudioSeg = Math.floor(target / SEG_SEC);
    // Discard everything from the seek target forward: the viewer is about to
    // re-watch it, so the player must fetch those segments again. Under the
    // cache trace those fetches are served by the HTTP cache, which is exactly
    // the case the estimator must not read as "unlimited bandwidth".
    await this.appendVideo.catch(() => {});
    await this.appendAudio.catch(() => {});
    const clearForward = (sb) => new Promise(resolve => {
      if (!sb || !sb.buffered.length) return resolve();
      const end = sb.buffered.end(sb.buffered.length - 1);
      if (end <= target + 0.01) return resolve();
      const onEnd = () => { sb.removeEventListener('updateend', onEnd); resolve(); };
      sb.addEventListener('updateend', onEnd);
      try { sb.remove(target, end); } catch { sb.removeEventListener('updateend', onEnd); resolve(); }
    });
    await clearForward(this.videoSB);
    await clearForward(this.audioSB);
    this.video.currentTime = to;
    this.scenarioEvents.at(-1).clearedToSec = +target.toFixed(2);
  }

  evictBehind() {
    if (this.endStreamSignaled) return;
    const t = this.video.currentTime;
    const cut = t - this.options.backBufferSec;
    if (cut <= 0.5) return;
    for (const sb of [this.videoSB, this.audioSB]) {
      if (!sb || sb.updating) continue;
      try {
        if (sb.buffered.length && sb.buffered.start(0) < cut - 0.01) {
          sb.remove(sb.buffered.start(0), cut);
          break; // one removal at a time
        }
      } catch (e) {
        this.errors.push({ tMs: this.tMs(), where: 'evict', message: String(e) });
      }
    }
  }

  collectSample() {
    if (!this.startedAt || this.stopping) return;
    const est = this.estimator?.snapshot();
    const b = this.bufferAhead();
    const q = this.video.getVideoPlaybackQuality();
    this.samples.push({
      tMs: this.tMs(),
      playhead: +this.video.currentTime.toFixed(2),
      bufferSec: +b.video.toFixed(2),
      playableSec: +b.playable.toFixed(2),
      audioBufferSec: +b.audio.toFixed(2),
      rung: this.rung,
      presentedRung: this.presentedRung,
      estimateKbps: est?.estimateKbps != null ? Math.round(est.estimateKbps) : null,
      ewmaKbps: est?.ewmaKbps != null ? Math.round(est.ewmaKbps) : null,
      robustKbps: est?.robustKbps != null ? Math.round(est.robustKbps) : null,
      ttfbMeanMs: est ? Math.round(est.meanTtfbMs) : null,
      droppedFrames: q.droppedVideoFrames,
      totalFrames: q.totalVideoFrames,
      stallActive: !!this.stallActive,
    });
    this.onTick(this.liveState());
  }

  liveState() {
    const est = this.estimator?.snapshot();
    const b = this.bufferAhead();
    const lastDecision = this.decisions.at(-1);
    return {
      tMs: this.tMs(),
      playhead: +this.video.currentTime.toFixed(2),
      duration: this.video.duration || this.manifest.asset.durationSec,
      bufferSec: +b.video.toFixed(2),
      playableSec: +b.playable.toFixed(2),
      audioBufferSec: +b.audio.toFixed(2),
      rung: this.rung,
      rungId: this.rung != null ? this.reps[this.rung].id : null,
      rungRes: this.rung != null ? `${this.reps[this.rung].width}x${this.reps[this.rung].height}` : null,
      rungKbps: this.rung != null ? this.reps[this.rung].actualKbps : null,
      rungNominal: this.rung != null ? this.reps[this.rung].nominalKbps : null,
      presentedRung: this.presentedRung,
      presentedId: this.presentedRung != null && this.presentedRung >= 0 ? this.reps[this.presentedRung].id : null,
      presentedRes: this.presentedRung != null && this.presentedRung >= 0
        ? `${this.reps[this.presentedRung].width}x${this.reps[this.presentedRung].height}` : null,
      estimateKbps: est?.estimateKbps != null ? Math.round(est.estimateKbps) : null,
      ewmaKbps: est?.ewmaKbps != null ? Math.round(est.ewmaKbps) : null,
      robustKbps: est?.robustKbps != null ? Math.round(est.robustKbps) : null,
      ttfbMeanMs: est ? Math.round(est.meanTtfbMs) : null,
      samples: est?.sampleCount ?? 0,
      cacheHits: est?.stats.cacheHits ?? 0,
      weakSamples: est?.stats.weakSamples ?? 0,
      errorCount: est?.stats.errors ?? 0,
      stallActive: !!this.stallActive,
      stallTotalMs: Math.round(this.stallTotalMs + (this.stallActive ? this.tMs() - this.stallActive.tMs : 0)),
      lastDecision,
      audioKbps: this.audioKbps,
      traceId: this.trace.traceId,
      traceLabel: this.trace.traceLabel,
      algo: this.policy.id,
      algoName: this.policy.name,
      ladder: this.policy.ladder.map((r, i) => ({ id: r.id, width: r.width, height: r.height, kbps: r.kbps, segmentKbps: r.segmentKbps })),
    };
  }

  schedule() {
    if (!this.videoSB || this.stopping || !this.startedAt) return;
    const b = this.bufferAhead();
    this.maybeEndStream();

    if (!this.videoBusy && this.nextVideoSeg < this.segCount && b.video < this.options.maxBufferSec) {
      this.fetchNextVideo(b);
    }
    if (!this.audioBusy && this.nextAudioSeg < this.audioSegs.length && b.audio < this.options.maxBufferSec) {
      this.fetchNextAudio(b);
    }
  }

  maybeEndStream() {
    if (this.endStreamSignaled) return;
    if (this.nextVideoSeg < this.segCount || this.nextAudioSeg < this.audioSegs.length) return;
    if (this.videoBusy || this.audioBusy) return;
    if (this.videoSB?.updating || this.audioSB?.updating) return;
    if (this.mediaSource?.readyState !== 'open') return;
    try {
      this.mediaSource.endOfStream();
      this.endStreamSignaled = true;
      this.endStreamAtMs = this.tMs();
    } catch (e) {
      this.errors.push({ tMs: this.tMs(), where: 'endOfStream', message: String(e) });
    }
  }

  decide(trigger, b) {
    const est = this.estimator?.snapshot();
    const ctx = {
      now: this.tMs(),
      bufferSec: Math.max(0, b.video),
      playableSec: b.playable,
      estimateKbps: est?.estimateKbps ?? null,
      ewmaKbps: est?.ewmaKbps ?? null,
      robustKbps: est?.robustKbps ?? null,
      sampleCount: est?.sampleCount ?? 0,
      rung: this.rung,
      nextSegmentIndex: this.nextVideoSeg,
    };
    const d = this.policy.decide(ctx);
    const index = Math.max(0, Math.min(this.reps.length - 1, d.index | 0));
    this.logDecision({ ...d, index }, {
      bufferSec: +b.video.toFixed(2),
      estimateKbps: ctx.estimateKbps != null ? Math.round(ctx.estimateKbps) : null,
      robustKbps: ctx.robustKbps != null ? Math.round(ctx.robustKbps) : null,
      trigger,
    });
    return index;
  }

  logDecision(decision, inputs) {
    this.decisions.push({
      tMs: this.tMs(),
      index: decision.index,
      rungId: this.reps[decision.index]?.id,
      reason: decision.reason,
      from: this.rung,
      ...inputs,
    });
  }

  async fetchNextVideo(b) {
    this.videoBusy = true;
    const idx = this.nextVideoSeg++;
    let targetRung = this.decide('segment', b);
    const seg = this.reps[targetRung].segments[idx];
    if (!seg) { this.videoBusy = false; return; }
    const runQuery = `?run=${encodeURIComponent(this.trace.runId)}`;

    try {
      // Abandon-and-retry: a segment requested just before a collapse would take
      // far longer to finish than the buffer can cover. Waiting for it means a
      // guaranteed stall, so give up on it and re-request the same segment at a
      // rung the measured prefix can sustain. The abandoned bytes stay in the
      // estimator as in-flight samples — they are real evidence about the link.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (targetRung !== this.rung) {
          await this.appendVideo.catch(() => {});
          try {
            const buf = await fetch(`/${this.reps[targetRung].init}`).then(r => r.arrayBuffer());
            await this.appendBuffer(this.videoSB, buf, `v-init-${targetRung}`);
          } catch (e) {
            this.errors.push({ tMs: this.tMs(), where: 'switch-init', rung: targetRung, message: String(e) });
          }
          this.rung = targetRung;
          this.policy.feedback?.({ type: 'switchApplied', now: this.tMs() });
        }
        const rep = this.reps[this.rung];
        const segment = rep.segments[idx];
        if (!segment) { this.videoBusy = false; return; }
        const expectedBytes = this.policy.ladder[this.rung].segmentBytes;
        const url = `/${segment.url}${runQuery}`;
        const res = await this.download(url, {
          type: 'video', rung: this.rung, segIndex: idx, startedAt: this.tMs(), attempt,
          // Abandonment is a policy decision, not a player trick: only policies
          // that model the buffer can trade a partially downloaded segment for a
          // rung they can actually finish. The throughput-only control never
          // abandons, so it keeps its "no buffer awareness" property.
          abortWhen: this.policy.abandon ? ({ bytes, elapsedMs, firstByteAt }) => {
            if (firstByteAt == null || elapsedMs < 700 || bytes < 16 * 1024) return null;
            const prefixKbps = (bytes * 8) / elapsedMs;
            const remainingSec = ((expectedBytes - bytes) * 8) / (prefixKbps * 1000);
            const bufSec = this.bufferAhead().video;
            if (remainingSec <= bufSec + 0.15) return null;
            const verdict = this.policy.abandon({ prefixKbps, remainingSec, bufSec, rung: this.rung, bytes, now: this.tMs() });
            return verdict != null ? { prefixKbps, remainingSec, bufSec, index: verdict } : null;
          } : null,
        });
        if (res.aborted) {
          const next = Math.max(0, Math.min(this.rung - 1, res.abortInfo.index | 0));
          this.policy.feedback?.({ type: 'abandoned', index: next, now: this.tMs(), kbps: res.abortInfo.prefixKbps });
          targetRung = next;
          continue;
        }
        if (!res.ok) {
          this.nextVideoSeg = idx;
          this.recordPolicyOutcome(res, false);
          return;
        }
        await this.enqueueVideo(res.data, `v-seg-${idx}`);
        this.recordPolicyOutcome(res, true);
        return;
      }
      // Three abandons in a row: nothing above the lowest rung is viable.
      this.nextVideoSeg = idx;
    } catch (e) {
      this.errors.push({ tMs: this.tMs(), where: 'video-fetch', segIndex: idx, message: String(e) });
      this.nextVideoSeg = idx;
    } finally {
      this.videoBusy = false;
    }
  }

  async fetchNextAudio(b) {
    this.audioBusy = true;
    const idx = this.nextAudioSeg++;
    const seg = this.audioSegs[idx];
    if (!seg) { this.audioBusy = false; return; }
    const url = `/${seg.url}?run=${encodeURIComponent(this.trace.runId)}`;
    try {
      const res = await this.download(url, { type: 'audio', rung: null, segIndex: idx, startedAt: this.tMs() });
      if (!res.ok) { this.nextAudioSeg = idx; this.recordPolicyOutcome(res, false); return; }
      await this.enqueueAudio(res.data, `a-seg-${idx}`);
      this.recordPolicyOutcome(res, true);
    } catch (e) {
      this.errors.push({ tMs: this.tMs(), where: 'audio-fetch', segIndex: idx, message: String(e) });
      this.nextAudioSeg = idx;
    } finally {
      this.audioBusy = false;
    }
  }

  enqueueVideo(data, label) {
    this.appendVideo = this.appendVideo.then(() => this.appendBuffer(this.videoSB, data, label));
    return this.appendVideo.catch(err => {
      this.errors.push({ tMs: this.tMs(), where: 'video-append', label, message: String(err) });
    });
  }

  enqueueAudio(data, label) {
    this.appendAudio = this.appendAudio.then(() => this.appendBuffer(this.audioSB, data, label));
    return this.appendAudio.catch(err => {
      this.errors.push({ tMs: this.tMs(), where: 'audio-append', label, message: String(err) });
    });
  }

  async download(url, meta) {
    const t0 = now();
    const t0Run = this.tMs();
    const absolute = new URL(url, location.href).href;
    const priorEntries = performance.getEntriesByName(absolute, 'resource').length;
    const controller = new AbortController();
    let abortInfo = null;
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (e) {
      if (abortInfo) return { ok: false, aborted: true, abortInfo, ...abortInfo, type: meta.type };
      throw e;
    }
    let bytes = 0;
    let firstByteAt = null;
    const chunks = [];
    let windowBytes = 0;
    let windowStart = null;
    let aborted = false;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const t = now();
          if (firstByteAt == null) {
            firstByteAt = t;
            windowStart = t;
          }
          bytes += value.length;
          windowBytes += value.length;
          chunks.push(value);
          // Feed the estimator while the body is still in flight. Without this a
          // 2 s segment on a collapsed link is invisible for a full segment
          // duration; the player would learn about the drop only after stalling.
          // Only sliding-window rates with enough elapsed transfer time and bytes
          // are admitted, so RTF/packet timing jitter cannot masquerade as a spike.
          const elapsed = t - windowStart;
          if (elapsed >= 200 && windowBytes >= 8192) {
            this.estimator.addSample({
              bytes: windowBytes,
              transferMs: elapsed,
              ttfbMs: windowStart - t0,
              cacheHit: false,
              ok: true,
              now: t0Run + (windowStart - t0),
              // One request, many slices: do not count each slice as a new wait.
              final: false,
            });
            windowBytes = 0;
            windowStart = t;
          }
          if (meta.abortWhen) {
            const verdict = meta.abortWhen({ bytes, elapsedMs: t - firstByteAt, firstByteAt, totalMs: t - t0 });
            if (verdict) {
              abortInfo = verdict;
              aborted = true;
              controller.abort();
              break;
            }
          }
        }
      } catch (e) {
        if (!aborted) throw e;
      }
    }
    const t1 = now();
    const data = new Uint8Array(bytes);
    let off = 0;
    for (const c of chunks) { data.set(c, off); off += c.length; }

    const ttfbMs = firstByteAt != null ? firstByteAt - t0 : t1 - t0;
    const transferMs = firstByteAt != null ? t1 - firstByteAt : 0;
    const simTrace = res.headers.get('X-Sim-Trace');
    const ok = res.ok;
    // A cached response replays the original headers, so header sniffing cannot
    // detect it. Resource Timing can: a response served from the HTTP cache has
    // transferSize === 0 while still reporting a non-zero encodedBodySize.
    // Use the per-attempt URL so there is exactly one new entry.
    await new Promise(r => setTimeout(r, 0));
    const entries = performance.getEntriesByName(absolute, 'resource');
    const rt = entries.length > priorEntries ? entries[entries.length - 1] : null;
    const fromCache = !!(rt && rt.transferSize === 0 && rt.encodedBodySize > 0 && ok && !aborted);
    const cacheHit = ok && !aborted && (!simTrace || fromCache);
    const kbps = transferMs > 0 ? (bytes * 8) / transferMs : null;

    const entry = {
      tMs: t0Run,
      type: meta.type,
      rung: meta.rung,
      rungId: meta.rung != null ? this.reps[meta.rung].id : null,
      segIndex: meta.segIndex,
      url: url.split('?')[0],
      status: aborted ? 'aborted' : res.status,
      ok: ok && !aborted,
      aborted,
      abortReason: abortInfo ? `prefix ${Math.round(abortInfo.prefixKbps)} kbps, ${abortInfo.remainingSec.toFixed(1)}s left vs ${abortInfo.bufSec.toFixed(1)}s buffer` : null,
      bytes,
      ttfbMs: +ttfbMs.toFixed(1),
      transferMs: +transferMs.toFixed(1),
      kbps: kbps != null ? Math.round(kbps) : null,
      cacheHit,
      attempt: simTrace ? Number(res.headers.get('X-Sim-Attempt')) : null,
      transferSize: rt ? rt.transferSize : null,
      // Ground truth for labelling/analysis only; never read by the policy.
      scenarioKbps: simTrace ? Number(res.headers.get('X-Sim-Rate-Kbps')) : null,
      scenarioTtfbMs: simTrace ? Number(res.headers.get('X-Sim-Ttfb-Ms')) : null,
    };
    this.requests.push(entry);
    // An abandoned request is still evidence about the link: the bytes that did
    // arrive were transferred at the measured rate. Do not count it as an error.
    this.estimator?.addSample({
      bytes, transferMs, ttfbMs: ttfbMs, cacheHit, ok: ok || aborted, now: this.tMs(),
    });
    return { ...entry, data, aborted, abortInfo };
  }

  recordPolicyOutcome(res, ok) {
    this.policy.feedback?.({
      type: 'segmentLoaded',
      ok,
      cacheHit: res.cacheHit,
      kbps: res.kbps,
      bytes: res.bytes,
      transferMs: res.transferMs,
      ttfbMs: res.ttfbMs,
      segIndex: res.segIndex,
      rung: res.rung,
      now: this.tMs(),
    });
    if (!ok) {
      this.policy.feedback?.({ type: 'requestFailed', status: res.status, now: this.tMs() });
    }
  }

  async finish(reason = 'ended') {
    if (this.stopping) return;
    this.stopping = true;
    this.endedAt = Date.now();
    if (this.stallActive) this.endStall('finish');
    const t = this.tMs();
    if (this.presentedRung != null) {
      this.dwell.set(this.presentedRung, (this.dwell.get(this.presentedRung) || 0) + (t - this.presentedSince));
    }
    clearInterval(this.sampleTimer);
    clearInterval(this.schedTimer);
    clearInterval(this.evictTimer);
    clearInterval(this.watchdog);
    if (this.monitorRaf && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.monitorRaf);
    this.stopReason = reason;
  }

  record() {
    const playedSec = this.video.currentTime;
    const videoBytes = this.requests.filter(r => r.type === 'video' && r.ok).reduce((a, r) => a + r.bytes, 0);
    const audioBytes = this.requests.filter(r => r.type === 'audio' && r.ok).reduce((a, r) => a + r.bytes, 0);
    const okReqs = this.requests.filter(r => r.ok && !r.cacheHit);
    const segV = okReqs.filter(r => r.type === 'video');
    const weightedKbps = segV.length
      ? segV.reduce((a, r) => a + (r.kbps || 0) * (r.transferMs || 0), 0) / Math.max(1, segV.reduce((a, r) => a + (r.transferMs || 0), 0))
      : null;
    const switches = this.decisions.filter(d => d.trigger === 'segment' && d.from != null && d.index !== d.from);
    const dwellEntries = [...this.dwell.entries()].map(([rung, ms]) => ({ rung, ms: Math.round(ms) }))
      .sort((a, b) => a.rung - b.rung);
    const playedMs = Math.max(1, this.dwellTotalMs = dwellEntries.reduce((a, d) => a + d.ms, 0));
    const rungSeconds = dwellEntries.map(d => ({
      rung: d.rung,
      id: this.reps[d.rung]?.id,
      width: this.reps[d.rung]?.width,
      height: this.reps[d.rung]?.height,
      kbps: this.reps[d.rung]?.actualKbps,
      seconds: +(d.ms / 1000).toFixed(2),
      share: +(d.ms / playedMs).toFixed(3),
    }));
    const avgPresentedKbps = rungSeconds.length
      ? rungSeconds.reduce((a, r) => a + (r.kbps || 0) * (r.seconds || 0), 0) / Math.max(0.001, rungSeconds.reduce((a, r) => a + r.seconds, 0))
      : null;
    const wallMs = this.endedAt ? this.endedAt - this.startedAt : this.tMs();

    const summary = {
      runId: this.trace.runId,
      traceId: this.trace.traceId,
      traceLabel: this.trace.traceLabel,
      algo: this.policy.id,
      algoName: this.policy.name,
      repeat: this.trace.repeat ?? 1,
      startedAt: this.startedAt,
      wallMs,
      playedSec: +playedSec.toFixed(2),
      contentDurationSec: this.manifest.asset.durationSec,
      stopReason: this.stopReason,
      startupMs: this.startupMs,
      stallCount: this.stalls.length,
      stallTotalMs: Math.round(this.stallTotalMs),
      rebufferRatio: +(this.stallTotalMs / Math.max(1, this.stallTotalMs + playedSec * 1000)).toFixed(4),
      switches: switches.length,
      upSwitches: switches.filter(d => d.index > d.from).length,
      downSwitches: switches.filter(d => d.index < d.from).length,
      requestCount: this.requests.length,
      failedRequests: this.requests.filter(r => !r.ok).length,
      cacheHits: this.requests.filter(r => r.cacheHit).length,
      videoBytes,
      audioBytes,
      totalMB: +((videoBytes + audioBytes) / 1e6).toFixed(2),
      meanTransferKbps: weightedKbps != null ? Math.round(weightedKbps) : null,
      avgPresentedKbps: avgPresentedKbps != null ? Math.round(avgPresentedKbps) : null,
      presentedRungs: rungSeconds,
      droppedFrames: this.video.getVideoPlaybackQuality?.().droppedVideoFrames ?? null,
      totalFrames: this.video.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
      errors: this.errors.length,
    };

    return {
      meta: {
        summary,
        traceId: this.trace.traceId,
        traceLabel: this.trace.traceLabel,
        events: this.trace.events,
        algo: this.policy.id,
        algoName: this.policy.name,
        algoDescription: this.policy.description,
        repeat: this.trace.repeat ?? 1,
        ladder: this.policy.ladder.map(r => ({ id: r.id, width: r.width, height: r.height, kbps: r.kbps, segmentKbps: r.segmentKbps })),
        audioKbps: this.audioKbps,
        manifest: {
          id: this.manifest.asset.id,
          title: this.manifest.asset.title,
          durationSec: this.manifest.asset.durationSec,
          segmentSec: this.manifest.asset.segmentDurationSec,
          codec: this.manifest.video.codec,
        },
        ua: navigator.userAgent,
        startedAt: this.startedAt,
        recordedAt: Date.now(),
      },
      groundTruth: {
        note: 'Link rate produced by the local shaper for this run. Display/analysis only; policies never receive it.',
        series: this.trace.rateSeries,
      },
      decisions: this.decisions,
      requests: this.requests,
      stalls: this.stalls,
      presented: this.presented,
      samples: this.samples,
      scenarioEvents: this.scenarioEvents,
      errors: this.errors,
    };
  }
}
