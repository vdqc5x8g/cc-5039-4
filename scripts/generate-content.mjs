#!/usr/bin/env node
/**
 * Generates a real portrait documentary clip and a 6-rung H.264/AAC DASH ladder.
 *
 * The visual is a procedural "field notes" landscape (Ken Burns move, grain,
 * timecode/title overlays) so every rung carries identical content but visibly
 * different detail. All rungs are cut on the same 2 s keyframe grid.
 *
 * Output:
 *   content/manifest.json
 *   content/v0..v5/{init.mp4,seg-00000.m4s..}
 *   content/audio/{init.mp4,seg-00000.m4s..}
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const BUILD = path.join(ROOT, 'build');
const FFMPEG = process.env.FFMPEG_BIN || path.join(ROOT, 'node_modules/ffmpeg-static/ffmpeg');

const DURATION = 90;
const FPS = 30;
const GOP = 2 * FPS;           // 2 s closed GOP, aligned with segment boundaries
const SEG = 2;
const AUDIO_KBPS = 64;
const VIDEO_CODEC = 'avc1.640028'; // H.264 High profile, level 4.0

const TIERS = [
  { id: 'v0', w: 180,  h: 320,  kbps: 100 },
  { id: 'v1', w: 270,  h: 480,  kbps: 200 },
  { id: 'v2', w: 360,  h: 640,  kbps: 400 },
  { id: 'v3', w: 540,  h: 960,  kbps: 850 },
  { id: 'v4', w: 720,  h: 1280, kbps: 1700 },
  { id: 'v5', w: 1080, h: 1920, kbps: 3200 },
];

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(bin)} exited ${code}\n${err.slice(-6000)}`));
    });
  });
}

async function makeStill() {
  const still = path.join(BUILD, 'still.png');
  const convert = spawnSync('convert', ['-version']);
  if (convert.status !== 0) throw new Error('ImageMagick convert is required');

  const W = 2160, H = 3840;
  // Sky, sun glow, three hazy ridgelines, water, reeds, foreground grain.
  const draw = [
    `-size ${W}x${H} gradient:'#081421-#e8894e'`,
  ];
  const layers = path.join(BUILD, 'layers');
  await fsp.mkdir(layers, { recursive: true });

  await run('convert', [
    '-size', `${W}x${H}`, 'gradient:#081421-#e8894e', `${layers}/sky.png`,
  ]);
  await run('convert', [
    '-size', '900x900', 'radial-gradient:#fff0bd-#f5a53a', '-alpha', 'set',
    '-channel', 'A', '-evaluate', 'multiply', '0.85', '+channel',
    `${layers}/sun.png`,
  ]);
  await run('convert', [
    '-size', `${W}x${H}`, 'xc:none',
    '-fill', '#2c3d4d',
    '-draw', `polygon 0,2350 380,1900 760,2230 1180,1750 1580,2150 1980,1820 ${W},2320 ${W},${H} 0,${H}`,
    '-fill', '#16242e',
    '-draw', `polygon 0,2580 320,2320 820,2620 1280,2200 1700,2520 2100,2350 ${W},2580 ${W},${H} 0,${H}`,
    '-fill', '#0a131a',
    '-draw', `polygon 0,2870 480,2700 980,2900 1420,2670 1860,2880 ${W},2740 ${W},${H} 0,${H}`,
    '-blur', '0x1.2',
    `${layers}/ridges.png`,
  ]);
  // Water: lower band of horizontal glints.
  const waterDraw = [];
  for (let i = 0; i < 70; i++) {
    const y = 2860 + i * 13;
    const x = 120 + (i * 97) % 900;
    const w = 120 + (i * 173) % 760;
    waterDraw.push('-stroke', `rgba(255,196,120,${0.05 + (i % 7) * 0.02})`,
      '-strokewidth', String(2 + (i % 5)), '-draw', `line ${x},${y} ${x + w},${y + (i % 3) - 1}`);
  }
  await run('convert', ['-size', `${W}x${H}`, 'xc:none', ...waterDraw, `${layers}/water.png`]);

  const reedDraw = [];
  for (let i = 0; i < 60; i++) {
    const x = (i * 149) % W;
    const h = 140 + ((i * 233) % 420);
    const bend = ((i * 31) % 60) - 30;
    reedDraw.push('-stroke', 'rgba(3,8,12,0.85)', '-strokewidth', String(2 + (i % 4)),
      '-draw', `path 'M ${x},${H} Q ${x + bend},${H - h * 0.5} ${x + bend * 2},${H - h}'`);
  }
  await run('convert', ['-size', `${W}x${H}`, 'xc:none', ...reedDraw, '-blur', '0x0.6', `${layers}/reeds.png`]);

  const composites = [
    [path.join(layers, 'sun.png'), '+1180+720'],
    [path.join(layers, 'ridges.png'), '+0+0'],
    [path.join(layers, 'water.png'), '+0+0'],
    [path.join(layers, 'reeds.png'), '+0+0'],
  ];
  const compArgs = [path.join(layers, 'sky.png')];
  for (const [src, pos] of composites) compArgs.push(src, '-geometry', pos, '-composite');
  compArgs.push(
    '-attenuate', '0.35', '+noise', 'Gaussian', '-modulate', '100,112,100',
    '-font', FONT_BOLD, '-pointsize', '64', '-fill', 'rgba(255,255,255,0.72)',
    '-annotate', '+64+150', 'FIELD NOTES 04',
    '-font', FONT, '-pointsize', '34', '-fill', 'rgba(255,255,255,0.55)',
    '-annotate', '+66+212', 'COASTAL PLATEAU / LATE DRY SEASON',
    '-font', FONT_BOLD, '-pointsize', '92', '-fill', 'rgba(255,255,255,0.86)',
    '-annotate', '+64+1700', 'THE LONG',
    '-annotate', '+64+1810', 'DRY SEASON',
    '-font', FONT, '-pointsize', '40', '-fill', 'rgba(255,255,255,0.62)',
    '-annotate', '+66+1888', 'A study in six framings',
    still,
  );
  await run('convert', compArgs);
  return still;
}

async function makeMaster(still) {
  const master = path.join(BUILD, 'master.mp4');
  const vf = [
    `zoompan=z='1.05+0.22*on/(${FPS * DURATION})':x='iw/2-(iw/zoom/2)+sin(on/260)*36':y='ih/2-(ih/zoom/2)-on*0.45':d=1:s=${TIERS.at(-1).w}x${TIERS.at(-1).h}:fps=${FPS}`,
    `eq=brightness='0.015*sin(t/7.3)':saturation='1.0+0.05*sin(t/11.7)'`,
    'noise=alls=11:allf=t',
    'vignette=PI/4.6',
    'format=yuv420p',
  ].join(',');
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-framerate', String(FPS), '-i', still, '-t', String(DURATION),
    '-vf', vf, '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14',
    '-g', String(GOP), '-keyint_min', String(GOP), '-sc_threshold', '0',
    '-profile:v', 'high', '-level:v', '4.0', '-pix_fmt', 'yuv420p',
    '-an', '-movflags', '+faststart', master,
  ]);
  return master;
}

async function encodeTier(master, tier) {
  const dir = path.join(CONTENT, tier.id);
  await fsp.mkdir(dir, { recursive: true });
  const scale = `scale=${tier.w}:${tier.h}:flags=lanczos`;
  const vf = tier.w === TIERS.at(-1).w ? 'null' : scale;
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', master, '-an', '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', `${tier.kbps}k`, '-maxrate', `${Math.round(tier.kbps * 1.12)}k`,
    '-bufsize', `${Math.round(tier.kbps * 2)}k`,
    '-g', String(GOP), '-keyint_min', String(GOP), '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${SEG})`,
    '-profile:v', 'high', '-level:v', '4.0', '-pix_fmt', 'yuv420p',
    '-f', 'dash', '-seg_duration', String(SEG), '-use_timeline', '0', '-use_template', '1',
    '-adaptation_sets', 'id=0,streams=v',
    '-init_seg_name', 'init.mp4', '-media_seg_name', 'seg-$Number%05d$.m4s',
    '-extra_window_size', '0', '-remove_at_exit', '0',
    path.join(dir, 'index.mpd'),
  ]);
  await fsp.rm(path.join(dir, 'index.mpd'), { force: true });
}

async function encodeAudio() {
  const dir = path.join(CONTENT, 'audio');
  await fsp.mkdir(dir, { recursive: true });
  const filter =
    'sine=frequency=55:duration=90[a];' +
    'anoisesrc=color=pink:duration=90:amplitude=0.06,lowpass=f=900[b];' +
    'sine=frequency=82.4:duration=90[c];' +
    '[a]volume=0.18[a1];[b]volume=0.55[b1];[c]volume=0.10[c1];' +
    '[a1][b1][c1]amix=inputs=3:normalize=0,tremolo=f=0.12:d=0.35,aecho=0.7:0.6:420:0.25,alimiter=limit=0.7,volume=1.4';
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-filter_complex', filter, '-t', String(DURATION),
    '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`,
    '-f', 'dash', '-seg_duration', String(SEG), '-use_timeline', '0', '-use_template', '1',
    '-adaptation_sets', 'id=0,streams=0',
    '-init_seg_name', 'init.mp4', '-media_seg_name', 'seg-$Number%05d$.m4s',
    '-extra_window_size', '0', '-remove_at_exit', '0',
    path.join(dir, 'index.mpd'),
  ]);
  await fsp.rm(path.join(dir, 'index.mpd'), { force: true });
}

async function probeDuration(file) {
  const { err } = await run(FFMPEG, ['-hide_banner', '-i', file, '-f', 'null', '-']);
  const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) throw new Error(`Cannot read duration of ${file}`);
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

function listSegments(dir) {
  return fs.readdirSync(dir)
    .filter(f => /^seg-\d+\.m4s$/.test(f))
    .sort()
    .map(f => path.join(dir, f));
}

async function verifyTier(id, files, expectedSegments, { tolerance = 0 } = {}) {
  if (files.length < expectedSegments || files.length > expectedSegments + tolerance) {
    throw new Error(`${id}: expected ${expectedSegments}..${expectedSegments + tolerance} segments, found ${files.length}`);
  }
  const tmp = path.join(BUILD, `verify-${id}.mp4`);
  const out = fs.createWriteStream(tmp);
  for (const f of [path.join(CONTENT, id, 'init.mp4'), ...files]) {
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(f);
      rs.on('error', rej);
      rs.on('end', res);
      rs.pipe(out, { end: false });
    });
  }
  await new Promise(res => out.end(res));
  const dur = await probeDuration(tmp);
  await fsp.rm(tmp, { force: true });
  if (Math.abs(dur - DURATION) > 0.2) throw new Error(`${id}: decoded duration ${dur} != ${DURATION}`);
  return dur;
}

function segMeta(files) {
  // DASH muxing can emit a final flush fragment of a few hundred bytes at the
  // exact end timestamp. It carries no playable media and would create a
  // zero-length buffer at the tail, so drop trailing fragments under 2 KB.
  const keep = [...files];
  while (keep.length && fs.statSync(keep.at(-1)).size < 2048) keep.pop();
  return keep.map((f, i) => ({
    index: i,
    startSec: +(i * SEG).toFixed(3),
    durationSec: SEG,
    bytes: fs.statSync(f).size,
    url: `content/${path.basename(path.dirname(f))}/${path.basename(f)}`,
  }));
}

async function main() {
  await fsp.mkdir(BUILD, { recursive: true });
  await fsp.mkdir(CONTENT, { recursive: true });
  for (const t of TIERS) await fsp.rm(path.join(CONTENT, t.id), { recursive: true, force: true });
  await fsp.rm(path.join(CONTENT, 'audio'), { recursive: true, force: true });

  console.log('1/5 building documentary still');
  const still = await makeStill();
  // Cache the expensive master so ladder-only changes re-run in minutes, not tens of minutes.
  const masterSig = path.join(BUILD, 'master.sig');
  const stillStat = fs.statSync(still);
  let master = path.join(BUILD, 'master.mp4');
  const sig = `${stillStat.size}:${stillStat.mtimeMs}`;
  const cachedSig = fs.existsSync(masterSig) ? fs.readFileSync(masterSig, 'utf8') : '';
  if (fs.existsSync(master) && cachedSig === sig) {
    console.log('2/5 reusing cached 1080x1920 master');
  } else {
    console.log('2/5 encoding 1080x1920 master');
    const started = Date.now();
    master = await makeMaster(still);
    fs.writeFileSync(masterSig, sig);
    console.log(`    master ready in ${((Date.now() - started) / 1000).toFixed(1)}s (${(fs.statSync(master).size / 1e6).toFixed(1)} MB)`);
  }

  console.log('3/5 encoding DASH ladder');
  let active = 0, next = 0;
  await new Promise((resolve, reject) => {
    const pump = () => {
      if (next >= TIERS.length) { if (active === 0) resolve(); return; }
      const tier = TIERS[next++];
      active++;
      encodeTier(master, tier).then(() => {
        active--;
        console.log(`    ${tier.id} ${tier.w}x${tier.h} @ ${tier.kbps} kbps`);
        pump();
      }, reject);
    };
    pump(); pump();
  });

  console.log('4/5 encoding audio');
  await encodeAudio();

  console.log('5/5 verifying and writing manifest');
  const expectedSegments = DURATION / SEG;
  const reps = [];
  for (const tier of TIERS) {
    const files = listSegments(path.join(CONTENT, tier.id));
    const decodedDuration = await verifyTier(tier.id, files, expectedSegments);
    const segments = segMeta(files);
    const totalBytes = fs.statSync(path.join(CONTENT, tier.id, 'init.mp4')).size +
      segments.reduce((a, s) => a + s.bytes, 0);
    const actualKbps = Math.round(totalBytes * 8 / decodedDuration / 1000);
    reps.push({
      id: tier.id, width: tier.w, height: tier.h, nominalKbps: tier.kbps, actualKbps,
      init: `content/${tier.id}/init.mp4`, segments,
    });
    console.log(`    ${tier.id}: ${segments.length} segs, ${(totalBytes / 1e6).toFixed(2)} MB, actual ${actualKbps} kbps`);
  }

  const audioAll = listSegments(path.join(CONTENT, 'audio'));
  const audioFiles = [...audioAll];
  while (audioFiles.length && fs.statSync(audioFiles.at(-1)).size < 2048) audioFiles.pop();
  const audioDuration = await verifyTier('audio', audioFiles, expectedSegments, { tolerance: 1 });
  const audioSegments = segMeta(audioFiles).map(s => ({ ...s, url: s.url.replace('audio/', 'audio/') }));
  const audioBytes = fs.statSync(path.join(CONTENT, 'audio', 'init.mp4')).size +
    audioSegments.reduce((a, s) => a + s.bytes, 0);

  const manifest = {
    asset: {
      id: 'the-long-dry-season',
      title: 'The Long Dry Season — Field Notes 04',
      type: 'documentary',
      durationSec: DURATION,
      segmentDurationSec: SEG,
      fps: FPS,
      width: TIERS.at(-1).w,
      height: TIERS.at(-1).h,
      generatedAt: new Date().toISOString(),
    },
    video: {
      codec: VIDEO_CODEC,
      representations: reps,
    },
    audio: {
      codec: 'mp4a.40.2',
      nominalKbps: AUDIO_KBPS,
      actualKbps: Math.round(audioBytes * 8 / audioDuration / 1000),
      init: 'content/audio/init.mp4',
      segments: audioSegments,
    },
  };
  await fsp.writeFile(path.join(CONTENT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`    audio: ${audioSegments.length} segs, actual ${manifest.audio.actualKbps} kbps`);
  console.log(`manifest written to ${path.join(CONTENT, 'manifest.json')}`);
  console.log('done');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
