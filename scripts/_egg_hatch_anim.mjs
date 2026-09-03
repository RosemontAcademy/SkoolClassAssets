// Procedural 5s egg-hatch animation (no API): shake -> hop -> shell cracks open at the top.
// Real transparency via gifwrap (alpha channel). Variant tweaks the crack look.
//   node _egg_hatch_anim.mjs "<eggPng>" "<outGif>" [v1|v2]
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { Jimp } = require('jimp');
const { GifFrame, GifUtil, GifCodec } = require('gifwrap');

const [, , IN, OUT, VARIANT = 'v1'] = process.argv;
const src = await Jimp.read(IN);

// --- normalize: clear an opaque background if present, then crop to the egg bbox ---
{
  const d = src.bitmap.data;
  if (d[3] > 200) {
    const br = d[0], bg = d[1], bb = d[2];
    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - br, dg = d[i + 1] - bg, db = d[i + 2] - bb;
      if (dr * dr + dg * dg + db * db < 900) d[i + 3] = 0;
    }
  }
}
let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
{
  const d = src.bitmap.data, W = src.bitmap.width, H = src.bitmap.height;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    if (d[(y * W + x) * 4 + 3] > 16) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
}
const egg = src.clone().crop({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
const ew = egg.bitmap.width, eh = egg.bitmap.height;
const ED = egg.bitmap.data;
const eggPx = (x, y) => (x < 0 || y < 0 || x >= ew || y >= eh) ? null
  : (ED[(y * ew + x) * 4 + 3] > 24 ? (y * ew + x) * 4 : null);

// --- per-variant crack tuning ---
const CFGS = {
  v1: { sharp: false, fracAmp: eh * 0.035, liftMul: 0.060, tilt: 0,          branches: 2, bw: 1 },
  v2: { sharp: true,  fracAmp: eh * 0.085, liftMul: 0.060, tilt: eh * 0.05,  branches: 7, bw: 2 },
  v3: { sharp: true,  fracAmp: eh * 0.090, liftMul: 0.090, tilt: eh * 0.06,  branches: 0, bw: 2 }, // no hairlines, just shell opening wider
};
const CFG = CFGS[VARIANT] || CFGS.v1;

// --- canvas ---
const pad = Math.round(ew * 0.5);
const jumpH = Math.round(eh * 0.40);
const floor = Math.round(eh * 0.10);
const CW = ew + pad * 2;
const CH = eh + jumpH + floor;
const cx = CW / 2;
const restCenterY = CH - floor - eh / 2;

// --- fixed fracture line across the upper egg (same shape every frame; only opens wider) ---
const fracBase = Math.round(eh * 0.20);
const rnd = n => ((n * 2654435761) >>> 8) % 1000 / 1000;
const fracOff = new Array(ew);
{
  let v = 0, dir = 1, seg = 0, segLen = 6;
  for (let x = 0; x < ew; x++) {
    if (CFG.sharp) {                                   // sharp zigzag — irregular, not a straight cut
      if (seg++ >= segLen) { seg = 0; dir = -dir; segLen = 4 + Math.floor(rnd(x) * 9); }
      v += dir * (1.4 + rnd(x + 7) * 1.6);
    } else {                                            // soft wavy (v1)
      v += Math.sin(x * 0.45) * 0.9 + Math.sin(x * 1.7 + 2) * 0.5 + (rnd(x) - 0.5) * 1.8;
      v *= 0.88;
    }
    v = Math.max(-CFG.fracAmp, Math.min(CFG.fracAmp, v));
    fracOff[x] = Math.round(v);
  }
}
const fracY = x => Math.max(5, Math.min(eh - 6, fracBase + fracOff[x]));

// --- build cracked egg: cap (above fracture) lifts (tilted), dark gap opens, hairline cracks spread ---
function makeCrackedEgg(cr) {
  const baseLift = eh * CFG.liftMul * cr;
  const tilt = CFG.tilt * cr;
  const liftAt = x => Math.max(1, Math.round(baseLift + tilt * (x / (ew - 1))));
  const maxLift = Math.max(1, Math.round(baseLift + tilt));
  const OH = eh + maxLift;
  const out = new Jimp({ width: ew, height: OH, color: 0x00000000 });
  const od = out.bitmap.data;
  const put = (x, y, r, g, b, a) => { if (y < 0 || y >= OH || x < 0 || x >= ew) return; const i = (y * ew + x) * 4; od[i] = r; od[i + 1] = g; od[i + 2] = b; od[i + 3] = a; };
  const copyEgg = (x, oy, sy) => { const s = eggPx(x, sy); if (s !== null) put(x, oy, ED[s], ED[s + 1], ED[s + 2], ED[s + 3]); };
  for (let x = 0; x < ew; x++) {
    const fy = fracY(x), lf = liftAt(x);
    const hasBody = eggPx(x, Math.min(eh - 1, fy + 1)) !== null;
    for (let y = 0; y < fy; y++) copyEgg(x, y - lf + maxLift, y);        // cap (lifted, tilted)
    if (hasBody) for (let gy = fy - lf + maxLift; gy < fy + maxLift; gy++) {  // interior gap
      const t = (gy - (fy - lf + maxLift)) / Math.max(1, lf);
      put(x, gy, Math.max(0, 46 - (t * 24 | 0)), Math.max(0, 36 - (t * 20 | 0)), Math.max(0, 28 - (t * 16 | 0)), 255);
    }
    for (let y = fy; y < eh; y++) copyEgg(x, y + maxLift, y);            // body (fixed position)
  }
  // hairline cracks — more + thicker, radiating from the fracture (some down into body, some up into cap)
  const dark = [42, 31, 24];
  const drawCrack = (sx, len, dir, bw) => {
    let x = sx, y0 = fracY(Math.max(0, Math.min(ew - 1, sx))) + maxLift + (dir < 0 ? -liftAt(sx) : 0);
    for (let k = 0; k < len; k++) {
      x += Math.round((rnd(sx * 13 + k * 7) - 0.5) * 2.4);
      const y = y0 + dir * k;
      for (let t = -bw; t <= bw; t++) {
        const xi = Math.round(x) + t;
        if (xi < 0 || xi >= ew || y < 0 || y >= OH) continue;
        const i = (y * ew + xi) * 4;
        if (od[i + 3] > 0) { od[i] = dark[0]; od[i + 1] = dark[1]; od[i + 2] = dark[2]; od[i + 3] = 255; } // stay on the shell
      }
    }
  };
  for (let b = 0; b < CFG.branches; b++) {
    const sx = Math.round(ew * (0.22 + 0.56 * (b / Math.max(1, CFG.branches - 1))) + (rnd(b * 31) - 0.5) * ew * 0.08);
    const down = b % 3 !== 0;                                            // most go down, some up into the cap
    const len = Math.round(eh * (down ? 0.12 + rnd(b) * 0.14 : 0.07 + rnd(b) * 0.08) * cr);
    drawCrack(sx, len, down ? 1 : -1, CFG.bw);
  }
  return { img: out, lift: maxLift };
}

const SECONDS = parseFloat(process.argv[5] || '5.0');   // total duration; keep <4s to fit the hatch overlay window
const N = Math.max(12, Math.round(SECONDS * 1000 / 70)); // 70ms/frame
const smooth = t => t * t * (3 - 2 * t);

function frame(i) {
  const p = i / (N - 1);
  const cv = new Jimp({ width: CW, height: CH, color: 0x00000000 });
  let angle = 0, dy = 0, crack = 0;
  if (p < 0.82) {
    // Progressive shake: starts subtle, escalates into a hard rattle. Amplitude AND
    // frequency both build (a chirp), with a growing vertical buzz + little hops.
    const sp = p / 0.82;                                   // 0 → 1 over the shake
    const amp = 2 + 17 * Math.pow(sp, 1.6);                // ~2° → ~19°
    const phase = 2 * Math.PI * (3 * sp + 6 * sp * sp);    // slow → fast oscillation
    angle = amp * Math.sin(phase);
    dy = Math.pow(sp, 2) * (eh * 0.05) * Math.abs(Math.sin(phase)); // grows with intensity
    if (sp > 0.55) {                                       // little hops once it's rattling hard
      const hp = (sp - 0.55) / 0.45;
      dy += jumpH * 0.55 * hp * Math.max(0, Math.sin(2 * Math.PI * (2 + 3 * hp) * sp));
    }
  } else {
    // Climax: the shell cracks open.
    const lp = (p - 0.82) / 0.18;
    crack = smooth(Math.min(1, lp));
    dy = eh * 0.035 * Math.cos(2 * Math.PI * 2 * lp) * Math.exp(-4 * lp); // burst settle
  }
  const cyCur = restCenterY - dy;
  if (crack > 0) {
    const { img, lift } = makeCrackedEgg(crack);
    cv.composite(img, Math.round(cx - ew / 2), Math.round(cyCur - eh / 2 - lift));
  } else {
    const rot = Math.abs(angle) > 0.01 ? egg.clone().rotate(angle) : egg.clone();
    cv.composite(rot, Math.round(cx - rot.bitmap.width / 2), Math.round(cyCur - rot.bitmap.height / 2));
  }
  return cv;
}

const frames = [];
for (let i = 0; i < N; i++) {
  const cv = frame(i);
  const d = cv.bitmap.data;
  for (let j = 0; j < d.length; j += 4) d[j + 3] = d[j + 3] < 128 ? 0 : 255;
  // disposalMethod 2 (restore to background) clears each frame so the moving egg
  // leaves no ghost trails on transparent areas between frames.
  const gf = new GifFrame(CW, CH, Buffer.from(d), { delayCentisecs: 7, disposalMethod: GifFrame.DisposeToBackgroundColor });
  GifUtil.quantizeDekker(gf);
  frames.push(gf);
}
// loops:1 → play the crack once and hold the final cracked-open frame. The reveal
// waits for the hatched species, so holding (instead of re-looping) avoids the egg
// visibly "re-cracking" while the sprite loads.
const gif = await new GifCodec().encodeGif(frames, { loops: 1 });
writeFileSync(OUT, gif.buffer);
console.log(`wrote ${OUT}  (${VARIANT}, ${N} frames, ~${(N * 0.07).toFixed(1)}s, ${CW}x${CH})`);
