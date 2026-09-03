// Batch procedural egg-hatch animations with per-generation "personality".
// Built on the good single-cap pipeline: only a thin shell lid rises (small liftMul) with a
// tilt, the interior gap is TRANSPARENT (see-through, like the clean Gen1 ref — no colored
// band), and the colorful pattern stays on the fixed body. The egg never loses its form.
//
// Each generation gets its own MOTION personality (not just a different crack): springy
// hops, heavy side rocking, one big charged leap, a fast buzz, a gentle bob, a drunken
// wobble, a violent rattle, an elastic bounce — all with squash-and-stretch so the egg
// visibly puffs out and pulls in ("볼록 튀어나왔다 들어갔다") while it rattles.
//   node _egg_hatch_batch.mjs [gen2 gen3 ...]   (default: 2..9)
import { createRequire } from 'module';
import { writeFileSync, existsSync } from 'fs';
const require = createRequire(import.meta.url);
const { Jimp } = require('jimp');
const { GifFrame, GifUtil, GifCodec } = require('gifwrap');

const EGG_DIR = new URL('../eggs/', import.meta.url);
const inPath = g => new URL(`Pokemon Gen ${g} Egg.png`, EGG_DIR);
const outPath = g => new URL(`Pokemon Gen ${g} Egg-hatch.gif`, EGG_DIR);

// --- per-generation personalities ---------------------------------------------------
// MOTION  type: shake rhythm (see kinematics). shakeDeg: peak tilt. hopH: peak hop as a
//         fraction of egg height. squash: how much it puffs/stretches (0=rigid).
// CRACK   fracBase/fracAmp: where & how jagged the crack sits. liftMul/tilt: cap rise & lean.
//         branches/bw: hairline cracks & thickness. seed: makes each crack unique.
const PERSONA = {
  2: { type: 'spring', shakeDeg: 10, hopH: 0.40, squash: 0.85, sharp: true,  fracBase: 0.20, fracAmp: 0.075, liftMul: 0.065, tilt: -0.06, branches: 5, bw: 2, seed: 11,  note: '폴짝폴짝 튀어오르다 번쩍 지그재그로 쩍' },
  3: { type: 'rock',   shakeDeg: 20, hopH: 0.14, squash: 0.40, sharp: true,  fracBase: 0.19, fracAmp: 0.060, liftMul: 0.070, tilt:  0.12, branches: 3, bw: 2, seed: 23,  note: '좌우로 빠릿하게 기우뚱기우뚱 옆으로 톡' },
  4: { type: 'leap',   shakeDeg: 10, hopH: 0.48, squash: 1.00, sharp: false, fracBase: 0.18, fracAmp: 0.055, liftMul: 0.095, tilt:  0.03, branches: 1, bw: 2, seed: 37,  note: '통통 예열하다 폴짝! 한 방에 위가 크게 열림' },
  5: { type: 'buzz',   shakeDeg:  7, hopH: 0.05, squash: 0.30, sharp: true,  fracBase: 0.20, fracAmp: 0.070, liftMul: 0.060, tilt:  0.00, branches: 8, bw: 1, seed: 51,  note: '부르르르 진동하다 실금이 별처럼 쫙' },
  6: { type: 'bob',    shakeDeg:  9, hopH: 0.16, squash: 0.45, sharp: false, fracBase: 0.19, fracAmp: 0.045, liftMul: 0.060, tilt:  0.05, branches: 2, bw: 1, seed: 67,  note: '경쾌하게 통통 넘실대다 사르르' },
  7: { type: 'wobble', shakeDeg: 18, hopH: 0.20, squash: 0.55, sharp: true,  fracBase: 0.20, fracAmp: 0.065, liftMul: 0.065, tilt: -0.05, branches: 4, bw: 2, seed: 83,  note: '갈지자로 흔들흔들 취한 듯 흔들다 톡' },
  8: { type: 'rattle', shakeDeg: 24, hopH: 0.26, squash: 0.60, sharp: true,  fracBase: 0.20, fracAmp: 0.095, liftMul: 0.070, tilt:  0.07, branches: 6, bw: 2, seed: 97,  note: '우당탕 격렬하게 떨다 우락부락 크랙' },
  9: { type: 'bounce', shakeDeg: 10, hopH: 0.30, squash: 0.95, sharp: true,  fracBase: 0.23, fracAmp: 0.080, liftMul: 0.075, tilt: -0.04, branches: 7, bw: 2, seed: 113, note: '탱탱볼처럼 통통통 튀다 낮고 넓게 쫙' },
};

const smooth = t => t * t * (3 - 2 * t);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const TAU = Math.PI * 2;

async function build(gen) {
  const IN = inPath(gen), OUT = outPath(gen);
  if (!existsSync(IN)) { console.log(`skip gen ${gen}: no PNG`); return; }
  const CFG = PERSONA[gen];
  const rnd = n => ((((n + CFG.seed) * 2654435761) >>> 8) % 1000) / 1000;
  const src = await Jimp.read(IN);

  // normalize: clear an opaque background if present, then crop to the egg bbox
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

  // canvas — extra top headroom for the hop + stretch, side room for big tilts
  const pad = Math.round(ew * 0.55);
  const jumpH = Math.round(eh * (CFG.hopH + 0.28));
  const floor = Math.round(eh * 0.10);
  const CW = ew + pad * 2;
  const CH = eh + jumpH + floor;
  const cx = CW / 2;
  const restCenterY = CH - floor - eh / 2;

  // fixed fracture line across the upper egg (same shape every frame; only opens wider)
  const fracAmpPx = eh * CFG.fracAmp;
  const fracBasePx = Math.round(eh * CFG.fracBase);
  const fracOff = new Array(ew);
  {
    let v = 0, dir = 1, seg = 0, segLen = 6;
    for (let x = 0; x < ew; x++) {
      if (CFG.sharp) {
        if (seg++ >= segLen) { seg = 0; dir = -dir; segLen = 4 + Math.floor(rnd(x) * 9); }
        v += dir * (1.4 + rnd(x + 7) * 1.6);
      } else {
        v += Math.sin(x * 0.45) * 0.9 + Math.sin(x * 1.7 + 2) * 0.5 + (rnd(x) - 0.5) * 1.8;
        v *= 0.88;
      }
      v = Math.max(-fracAmpPx, Math.min(fracAmpPx, v));
      fracOff[x] = Math.round(v);
    }
  }
  const fracY = x => Math.max(5, Math.min(eh - 6, fracBasePx + fracOff[x]));

  function makeCrackedEgg(cr) {
    const baseLift = eh * CFG.liftMul * cr;
    const tilt = eh * CFG.tilt * cr;
    const liftAt = x => Math.max(1, Math.round(baseLift + tilt * (x / (ew - 1))));
    const maxLift = Math.max(1, Math.round(baseLift + Math.abs(tilt)));
    const OH = eh + maxLift;
    const out = new Jimp({ width: ew, height: OH, color: 0x00000000 });
    const od = out.bitmap.data;
    const put = (x, y, r, g, b, a) => { if (y < 0 || y >= OH || x < 0 || x >= ew) return; const i = (y * ew + x) * 4; od[i] = r; od[i + 1] = g; od[i + 2] = b; od[i + 3] = a; };
    const copyEgg = (x, oy, sy) => { const s = eggPx(x, sy); if (s !== null) put(x, oy, ED[s], ED[s + 1], ED[s + 2], ED[s + 3]); };
    for (let x = 0; x < ew; x++) {
      const fy = fracY(x), lf = liftAt(x);
      for (let y = 0; y < fy; y++) copyEgg(x, y - lf + maxLift, y);        // cap (lifted, tilted)
      // interior gap stays TRANSPARENT — the crack shows straight through, no colored band
      for (let y = fy; y < eh; y++) copyEgg(x, y + maxLift, y);            // body (fixed position)
    }
    // hairline cracks radiating from the fracture (some down into body, some up into cap)
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
          if (od[i + 3] > 0) { od[i] = dark[0]; od[i + 1] = dark[1]; od[i + 2] = dark[2]; od[i + 3] = 255; }
        }
      }
    };
    for (let b = 0; b < CFG.branches; b++) {
      const sx = Math.round(ew * (0.22 + 0.56 * (b / Math.max(1, CFG.branches - 1))) + (rnd(b * 31) - 0.5) * ew * 0.08);
      const down = b % 3 !== 0;
      const len = Math.round(eh * (down ? 0.12 + rnd(b) * 0.14 : 0.07 + rnd(b) * 0.08) * cr);
      drawCrack(sx, len, down ? 1 : -1, CFG.bw);
    }
    return { img: out, lift: maxLift };
  }

  const SECONDS = 5.0;
  const N = Math.max(12, Math.round(SECONDS * 1000 / 70));

  // --- per-generation kinematics: pure function of p → { angle°, dy(px up), crack } -----
  function kinematics(p) {
    if (p >= 0.82) {                                   // climax: shell cracks open
      const lp = (p - 0.82) / 0.18;
      const crack = smooth(Math.min(1, lp));
      let dy = eh * 0.03 * Math.cos(TAU * 2 * lp) * Math.exp(-4 * lp); // landing settle bounce
      if (CFG.type === 'spring' || CFG.type === 'bounce')            // one last excited pop
        dy += CFG.hopH * eh * 0.20 * Math.sin(Math.PI * Math.min(1, lp)) * Math.exp(-1.4 * lp);
      return { angle: 0, dy, crack };
    }
    const sp = p / 0.82;                               // 0 → 1 across the shake
    const env = Math.pow(sp, 1.4);                     // builds from calm to frantic
    const land = sp > 0.9 ? (1 - (sp - 0.9) / 0.1) : 1; // touch down just before the crack
    let angle = 0, dy = 0;
    switch (CFG.type) {
      case 'spring': {                                 // growing, springy hops
        const cyc = 1.5 + 3.5 * sp;
        dy = CFG.hopH * eh * env * Math.abs(Math.sin(TAU * cyc * sp));
        angle = CFG.shakeDeg * env * Math.sin(TAU * (3 * sp + 3 * sp * sp)) * 0.5;
        break; }
      case 'rock': {                                   // brisk side-to-side rocking (freq builds 2→4)
        const rf = 2.2 + 1.8 * sp;
        angle = CFG.shakeDeg * env * Math.sin(TAU * rf * sp);
        dy = CFG.hopH * eh * env * Math.abs(Math.sin(TAU * rf * sp));
        break; }
      case 'leap': {                                   // lively warm-up hops, then one big charged jump
        const warm = sp < 0.62 ? CFG.hopH * eh * 0.30 * env * Math.abs(Math.sin(TAU * (2.5 + 3 * sp) * sp)) : 0;
        const bump = Math.exp(-Math.pow((sp - 0.76) / 0.12, 2));  // snappy gaussian leap ~76%
        dy = CFG.hopH * eh * bump + warm;
        angle = CFG.shakeDeg * env * Math.sin(TAU * 7 * sp) * 0.4;
        break; }
      case 'buzz': {                                   // fast tiny vibration
        dy = CFG.hopH * eh * env * Math.sin(TAU * 22 * sp);
        angle = CFG.shakeDeg * env * Math.sin(TAU * 19 * sp);
        break; }
      case 'bob': {                                    // lively springy bob (freq builds 3→5)
        const bf = 3 + 2 * sp;
        dy = CFG.hopH * eh * env * (0.5 + 0.5 * Math.sin(TAU * bf * sp - Math.PI / 2));
        angle = CFG.shakeDeg * env * Math.sin(TAU * 3.2 * sp);
        break; }
      case 'wobble': {                                 // drunken sway + medium hops
        angle = CFG.shakeDeg * env * (Math.sin(TAU * 1.1 * sp) + 0.35 * Math.sin(TAU * 5.3 * sp));
        dy = CFG.hopH * eh * env * Math.abs(Math.sin(TAU * 3 * sp));
        break; }
      case 'rattle': {                                 // violent jerky rattle
        const n = rnd(Math.floor(sp * 44)) - 0.5;
        angle = CFG.shakeDeg * env * (Math.sin(TAU * (4 * sp + 6 * sp * sp)) + 0.5 * n);
        dy = CFG.hopH * eh * env * Math.abs(Math.sin(TAU * 7 * sp)) * (0.7 + 0.6 * Math.abs(n));
        break; }
      case 'bounce': {                                 // elastic repeated bounces
        dy = CFG.hopH * eh * env * Math.abs(Math.sin(TAU * (2 + 5 * sp) * sp));
        angle = CFG.shakeDeg * env * Math.sin(TAU * 4 * sp) * 0.4;
        break; }
      default: {
        const amp = 2 + (CFG.shakeDeg - 2) * env;
        angle = amp * Math.sin(TAU * (3 * sp + 6 * sp * sp));
        dy = CFG.hopH * eh * env * Math.abs(Math.sin(TAU * (3 * sp + 6 * sp * sp)));
      }
    }
    return { angle, dy: dy * land, crack: 0 };
  }

  function frame(i) {
    const p = i / (N - 1);
    const cv = new Jimp({ width: CW, height: CH, color: 0x00000000 });
    const { angle, dy, crack } = kinematics(p);
    const cyCur = restCenterY - dy;
    if (crack > 0) {
      const { img, lift } = makeCrackedEgg(crack);
      cv.composite(img, Math.round(cx - ew / 2), Math.round(cyCur - eh / 2 - lift));
    } else {
      // squash-and-stretch from vertical velocity: stretch tall when launching, squash
      // flat when dropping/landing — the egg visibly puffs out and pulls back in.
      let spr = egg, sy = 1;
      if (CFG.squash > 0) {
        const pPrev = Math.max(0, (i - 1) / (N - 1));
        const vel = dy - kinematics(pPrev).dy;         // px/frame, up = positive
        // hard-clamped to ±10% height so the egg stays egg-shaped, never a rod or pancake
        sy = clamp(1 + CFG.squash * 0.0022 * vel, 0.92, 1.10);
        if (Math.abs(sy - 1) > 0.01)
          spr = egg.clone().resize({ w: Math.max(1, Math.round(ew / sy)), h: Math.max(1, Math.round(eh * sy)) });
      }
      const rot = Math.abs(angle) > 0.01 ? spr.clone().rotate(angle) : (spr === egg ? egg.clone() : spr);
      // keep the bottom near the floor when squashing so it looks planted, not floating
      const half = rot.bitmap.height / 2 + (eh * (sy - 1)) / 2;
      cv.composite(rot, Math.round(cx - rot.bitmap.width / 2), Math.round(cyCur - half));
    }
    return cv;
  }

  const frames = [];
  for (let i = 0; i < N; i++) {
    const cv = frame(i);
    const d = cv.bitmap.data;
    for (let j = 0; j < d.length; j += 4) d[j + 3] = d[j + 3] < 128 ? 0 : 255;
    const gf = new GifFrame(CW, CH, Buffer.from(d), { delayCentisecs: 7, disposalMethod: GifFrame.DisposeToBackgroundColor });
    GifUtil.quantizeDekker(gf);
    frames.push(gf);
  }
  const gif = await new GifCodec().encodeGif(frames, { loops: 1 });
  writeFileSync(OUT, gif.buffer);
  console.log(`gen ${gen} [${CFG.type}]: ${CFG.note}\n         → ${OUT.pathname.split('/').pop()}  (${N}f, ${CW}x${CH})`);
}

const args = process.argv.slice(2).map(Number).filter(n => n >= 2 && n <= 9);
const gens = args.length ? args : [2, 3, 4, 5, 6, 7, 8, 9];
for (const g of gens) await build(g);
