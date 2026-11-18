# Adaptive documentary player — prototype

A working adaptive-bitrate player for a real portrait documentary, measured in a
real browser engine against reproducible shaped networks. No "manual quality
button" and no synthetic curve: every rung downloaded is real, every request is
timed from an actual HTTP response, and the rung displayed is what the decoder
actually presented.

## What is real vs. what is simulated

| Part | Real | Simulated |
|---|---|---|
| Content | 90 s, 1080×1920 H.264/AAC, six rungs (100–3200 kbps), 2 s segments, all cut on the same keyframe grid | — |
| Playback | Chromium, MSE `SourceBuffer`s, `<video>`, frame callbacks, `getVideoPlaybackQuality` | — |
| Requests | HTTP fetches, first-byte/last-byte timings, byte counts, 503 retries | — |
| Link | — | server-side token bucket that paces every segment from a shared per-run budget |
| Viewer actions | — | scenario script (e.g. the rewind in the cache trace) |

The scenario's ground-truth link rate is shown to the viewer and written to the
record, but policies never receive it. Policies only see what a player can
observe.

## What the estimator does

`app/estimator.js`:

- **Waits are not transfer.** Throughput uses first-byte → last-byte transfer
  time. TTFB is reported separately (`inTtfb`) and only used as a diagnostic.
- **Wait is counted once per request.** TTFB is reported separately; in-flight
  transfer slices reuse the request's wait instead of each counting as a new
  one, so the displayed mean is a request wait and not an artifact of sampling.
- **Small transfers are weak evidence.** A sample needs ≥ 16 KiB and ≥ 40 ms of
  transfer time; short bursts are counted and reported as weak, they do not raise
  the estimate.
- **Cache hits are not bandwidth.** A response served from the HTTP cache looks
  like a zero-duration download. Resource Timing exposes `transferSize === 0`
  with a non-zero body size, so those are tagged and excluded.
- **One fast download cannot mean "unlimited".** The decision estimate is
  `min(fast EWMA, 1.6 × robust median of recent accepted samples)`. A single
  outlier is capped by the median.
- **The median is bounded by age, not just count.** With 2 s segments a
  count-only window holds ~18 s of history; after the link recovers the median
  would keep reporting the old collapsed rate and pin the player to the lowest
  rung. Samples older than 5.5 s are dropped, so quality can climb again.
- **In-flight sampling.** Segments are sampled while they are still arriving
  (200 ms / ≥ 8 KiB windows), so a bandwidth collapse on a 2 s segment is
  visible before the segment finishes rather than one segment late.

## Policies

Every policy starts on the same rung (`v2`): with no measurement yet none of them
knows the link, so the comparison is about adaptation rather than a luckier first
guess.

| id | idea |
|---|---|
| `hysteresis` | up thresholds that tighten with the buffer level; immediate defensive down when the estimate stops carrying the current rung; jumps straight to the sustainable rung in a hard collapse; multi-rung re-climb after recovery; ignores the first two samples so start-up does not slam it to the bottom |
| `buffer` | projected drain-time under the robust estimate, 3-decision up streak (1 with a deep buffer), immediate down under 2.5 s buffer |
| `naive` | top rung under 0.9 × the **last completed transfer**, with no estimator at all — the control for "one fast download means unlimited bandwidth". It has no cache-hit filter either, so the cache trace's sub-millisecond hits push it to the top rung |
| `fixed` | one rung always — the reference for what adapting buys you |

`hysteresis` and `buffer` may also **abandon** a segment mid-download when the
measured transfer rate means the rest cannot finish before the buffer drains, and
re-request it at a rung the prefix rate can sustain. The abandoned bytes still
count as estimator evidence. The raw control has no such escape hatch, which is
part of what it is there to show.

## Run it

```bash
npm install                      # playwright + ffmpeg-static
node scripts/generate-content.mjs   # rebuilds content/ and content/manifest.json
node server/index.mjs               # http://127.0.0.1:4173/app/
```

`content/` and `build/master.mp4` are generated; only the generator is checked in.

Open `http://127.0.0.1:4173/app/` for the live player. It shows the decision
inputs (estimate, buffer, last transfer, request wait), the policy's pick, the
request log, and a chart of scenario link vs. estimate vs. requested vs.
actually presented rung.

### Deterministic comparison harness

```bash
node server/index.mjs &
node harness/run.mjs --traces=all --algos=all --repeats=2
node harness/analyze.mjs
open http://127.0.0.1:4173/report/
```

The harness drives every (trace × algorithm × repeat) in a fresh browser
context, records raw per-run JSON in `runs/`, and `analyze.mjs` writes
`report/report.json`, `report/summary.md` and `report/index.html` plus the
viewer at `/report/`.

### Scenarios (`server/traces.mjs`)

| id | what it stresses |
|---|---|
| `drop` | 4.2 Mbps → 650 kbps at 16 s → 2.6 Mbps at 28 s → 900 kbps at 44 s: down-switch safety and re-climb |
| `oscillate` | 12 s sine between ~450 kbps and ~5.9 Mbps: stability vs. chasing samples |
| `latency` | ~1.2 s wait before first byte, 3.4 Mbps with a 1.8 Mbps dip: wait/transfer separation |
| `errors` | 2 of 3 requests get 503 for 13 s, then a 700 kbps window: retries must not poison the estimate |
| `cache` | cacheable segments, viewer rewinds 8 s at 26 s: the estimator must ignore cache hits; the raw control, which has no such filter, is pushed to the top rung and rebuffers |

All runs of one trace are compared over the same window: the shortest wall time
any run of that trace produced, capped by the trace and the asset (72 s for four
traces, 78 s for `cache`). Every policy therefore faces the identical slice of
the identical link trace, and every policy starts on the same rung.

## License / notes

Prototype, not production. The video is procedurally generated by the checked-in
script; the "documentary" is a title card over a Ken Burns move rendered from an
ImageMagick still, so the ladder is exercised with real detail differences
without shipping third-party footage.
