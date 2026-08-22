#!/usr/bin/env node
/**
 * scripts/mix_frames.mjs
 *
 * Builds a gif from a hand-picked frame order. The review page emits one line per
 * item — `18-pidgeot attack = old0,new1,new2,new3` — where `oldN` is frame N of the
 * gif currently in use and `newN` is frame N of the `-v2` re-bake. Frames may come
 * from either source in any order, so a run that only got one good frame right can
 * still be salvaged instead of re-baked.
 *
 * Lines starting with `erase` carry pixel rubbings made in the review page:
 *   erase new2 @ 7-squirtle attacked : c31.5,44,5 r10,60,24,8
 * `c x,y,r` is a round rub, `r x,y,w,h` a square one, in image pixels. They are
 * applied to that source frame before it is placed, so the original gif on disk is
 * never touched and the same list always rebuilds the same result.
 *
 *   node scripts/mix_frames.mjs picks.txt --dry
 *   node scripts/mix_frames.mjs picks.txt
 *
 * Flags:
 *   --dry     print what would be written, touch nothing
 *   --keep    write alongside as -mix.gif instead of replacing (old file untouched)
 *   --delay N per-frame delay in ms (default: copied from the source gif)
 *   --fit N   stretch the per-frame delay so ONE loop lasts exactly N ms
 *
 * Why --fit exists: every gif here loops forever, and the game shows it for
 * fxDuration (3000ms). At 250ms a five-frame effect is 1250ms, so one attack plays
 * the same motion 2.4 times — it reads as a hiccup, not a strike. The API has no
 * frame-count parameter, so the fix is to fill the window: stitch frames from two
 * bakes (8-10 frames) and pass `--fit 3000`.
 *
 * The current file is copied to _prev/ before being replaced. No API calls, no cost.
 */

import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GifReader } from 'omggif';
import GifEncoder from 'gif-encoder-2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FXD = join(__dirname, '..', 'skillFX');

const args = process.argv.slice(2);
const listPath = args.find(a => !a.startsWith('--'));
const dry = args.includes('--dry');
const keep = args.includes('--keep');
const delayArg = args.includes('--delay') ? parseInt(args[args.indexOf('--delay') + 1], 10) : null;
const fitMs = args.includes('--fit') ? parseInt(args[args.indexOf('--fit') + 1], 10) : null;

if (!listPath || !existsSync(listPath)) {
  console.error('사용법: node scripts/mix_frames.mjs <목록파일> [--dry] [--keep] [--delay N]');
  process.exit(1);
}

/**
 * Every frame in these gifs is full-canvas with disposal=2 (restore to background),
 * so each must be decoded onto a CLEARED buffer. Blitting cumulatively silently
 * stacks each frame onto the one before it.
 */
function readFrames(path) {
  const r = new GifReader(readFileSync(path));
  const size = r.width * r.height * 4;
  const frames = [];
  let prev = null;
  for (let i = 0; i < r.numFrames(); i++) {
    const info = r.frameInfo(i);
    const buf = new Uint8Array(size);
    if (prev && (info.disposal === 0 || info.disposal === 1)) buf.set(prev);
    r.decodeAndBlitFrameRGBA(i, buf);
    prev = buf;
    frames.push(buf);
  }
  return { w: r.width, h: r.height, frames, delay: (r.frameInfo(0).delay || 25) * 10 };
}

const MAGENTA = 0xFF00FF;

function encode(w, h, frames, delayMs) {
  const enc = new GifEncoder(w, h, 'neuquant', true, frames.length);
  enc.setDelay(delayMs);
  enc.setRepeat(0);
  enc.setTransparent(MAGENTA);
  enc.start();
  for (const src of frames) {
    // gif-encoder-2 reads RGBA; paint every transparent pixel magenta so the
    // palette match for the transparent index is exact.
    const px = new Uint8Array(src);
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) { px[i] = 255; px[i + 1] = 0; px[i + 2] = 255; }
    }
    enc.addFrame(px);
  }
  enc.finish();
  return enc.out.getData();
}

const raw = readFileSync(listPath, 'utf8').split(/\r?\n/)
  .map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('('));

// erase new2 @ 7-squirtle attacked : c31.5,44,5 r10,60,24,8
const rubs = new Map();   // "dir kind|side index" -> [{t,x,y,r|w,h}]
const lines = [];
for (const l of raw) {
  const m = /^erase\s+(old|new)(\d+)\s*@\s*(\S+\s+\S+)\s*:\s*(.+)$/.exec(l);
  if (!m) { lines.push(l); continue; }
  const [, side, idx, id, body] = m;
  const strokes = body.split(/\s+/).map(tok => {
    const c = /^c([-\d.]+),([-\d.]+),([-\d.]+)$/.exec(tok);
    if (c) return { t: 'c', x: +c[1], y: +c[2], r: +c[3] };
    const r = /^r([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)$/.exec(tok);
    if (r) return { t: 'r', x: +r[1], y: +r[2], w: +r[3], h: +r[4] };
    return null;
  }).filter(Boolean);
  if (strokes.length) rubs.set(id.replace(/\s+/g, ' ') + '|' + side + idx, strokes);
}

/** Clears the rubbed-out pixels in place. Circles use a squared-distance test so
 *  the shape matches what the canvas eraser drew on screen. */
function rubOut(px, w, h, strokes) {
  for (const st of strokes) {
    if (st.t === 'r') {
      const x0 = Math.max(0, Math.floor(st.x)), y0 = Math.max(0, Math.floor(st.y));
      const x1 = Math.min(w, Math.ceil(st.x + st.w)), y1 = Math.min(h, Math.ceil(st.y + st.h));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[(y * w + x) * 4 + 3] = 0;
    } else {
      const rr = st.r * st.r;
      const x0 = Math.max(0, Math.floor(st.x - st.r)), y0 = Math.max(0, Math.floor(st.y - st.r));
      const x1 = Math.min(w, Math.ceil(st.x + st.r)), y1 = Math.min(h, Math.ceil(st.y + st.r));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - st.x, dy = y + 0.5 - st.y;
        if (dx * dx + dy * dy <= rr) px[(y * w + x) * 4 + 3] = 0;
      }
    }
  }
}

let done = 0, skipped = 0;
for (const line of lines) {
  const m = /^(\S+)\s+(attack|attacked)\s*=\s*(.+)$/.exec(line);
  if (!m) { console.log('건너뜀 (형식): ' + line); skipped++; continue; }
  const [, dir, kind, picksRaw] = m;
  const picks = picksRaw.split(/[,\s]+/).map(t => t.trim()).filter(Boolean)
    .map(t => { const mm = /^(old|new)(\d+)$/.exec(t); return mm ? { side: mm[1], i: +mm[2] } : null; });
  if (picks.some(p => !p) || !picks.length) { console.log('건너뜀 (낱장 형식): ' + line); skipped++; continue; }

  const oldPath = join(FXD, dir, `${dir}-${kind}-fx.gif`);
  const newPath = join(FXD, dir, `${dir}-${kind}-fx-v2.gif`);
  if (!existsSync(oldPath)) { console.log('건너뜀 (지금 파일 없음): ' + line); skipped++; continue; }

  const src = { old: readFrames(oldPath) };
  if (picks.some(p => p.side === 'new')) {
    if (!existsSync(newPath)) { console.log('건너뜀 (-v2 없음): ' + line); skipped++; continue; }
    src.new = readFrames(newPath);
    if (src.new.w !== src.old.w || src.new.h !== src.old.h) {
      console.log('건너뜀 (크기 다름): ' + line); skipped++; continue;
    }
  }

  const picked = [];
  let bad = false, rubbed = 0;
  for (const p of picks) {
    const s = src[p.side];
    if (!s || !s.frames[p.i]) { console.log('건너뜀 (' + p.side + p.i + ' 없음): ' + line); bad = true; break; }
    const strokes = rubs.get(dir + ' ' + kind + '|' + p.side + p.i);
    if (strokes) {
      const copy = new Uint8Array(s.frames[p.i]);
      rubOut(copy, s.w, s.h, strokes);
      picked.push(copy);
      rubbed++;
    } else {
      picked.push(s.frames[p.i]);
    }
  }
  if (bad) { skipped++; continue; }

  const target = keep ? join(FXD, dir, `${dir}-${kind}-fx-mix.gif`) : join(FXD, dir, `${dir}-${kind}-fx.gif`);
  // gif delays are stored in hundredths of a second, so anything not a multiple of
  // 10ms is silently rounded down by the encoder -- round here so the reported
  // number is the number that actually ships.
  const delayMs = fitMs
    ? Math.max(20, Math.round(fitMs / picked.length / 10) * 10)
    : (delayArg || src.old.delay);
  const loopMs = delayMs * picked.length;
  const label = `${dir} ${kind}  ${picks.map(p => p.side + p.i).join(',')}  → ${picked.length}장` +
    (rubbed ? `  (${rubbed}장 지움)` : '') +
    `  ${delayMs}ms/장 · 한 바퀴 ${loopMs}ms` +
    (fitMs && Math.abs(loopMs - fitMs) > 60 ? `  ⚠ 목표 ${fitMs}ms와 ${loopMs - fitMs > 0 ? '+' : ''}${loopMs - fitMs}ms 차이` : '');
  if (dry) { console.log('  ' + label + '  → ' + target.split(/[\\/]/).pop()); continue; }

  const buf = encode(src.old.w, src.old.h, picked, delayMs);
  if (!keep && existsSync(target)) {
    const prev = join(FXD, dir, '_prev');
    mkdirSync(prev, { recursive: true });
    copyFileSync(target, join(prev, `${dir}-${kind}-fx.gif`));
  }
  writeFileSync(target, buf);
  console.log('  ' + label + '  ✓ ' + target.split(/[\\/]/).pop());
  done++;
}

if (dry) console.log('\n(미리보기였습니다 — --dry 를 빼면 실제로 씁니다)');
else console.log(`\n만든 것 ${done}개` + (skipped ? ` / 건너뜀 ${skipped}개` : '') + (keep ? '' : '  (옛 파일은 _prev/ 에)'));
