#!/usr/bin/env node
// Inspect / export / rebuild a GIF, preserving the magenta-keyed transparency the
// main generator uses (gif-encoder-2 + setTransparent(0xFF00FF)).
//   node _trim_gif.mjs <gif> --info
//   node _trim_gif.mjs <gif> --export <dir>   (write each frame as frameN.png, transparent)
//   node _trim_gif.mjs <gif> --drop N         (remove last N frames, write back)
//   node _trim_gif.mjs <gif> --keep 0,1,3     (keep only these frame indices, write back)
import { createRequire } from 'module';
import { createWriteStream } from 'fs';
import { join } from 'path';
const require = createRequire(import.meta.url);
const { GifUtil } = require('gifwrap');
const GifEncoder = require('gif-encoder-2');
const { Jimp } = require('jimp');

const [, , file, mode, arg] = process.argv;
if (!file) { console.error('usage: _trim_gif.mjs <gif> [--info|--export DIR|--drop N|--keep a,b,c]'); process.exit(1); }

const gif = await GifUtil.read(file);
console.log(`frames: ${gif.frames.length}  loops: ${gif.loops}`);
gif.frames.forEach((fr, i) =>
  console.log(`  #${i} delay=${fr.delayCentisecs}cs ${fr.bitmap.width}x${fr.bitmap.height}`));

const isMagenta = (d, i) => d[i] > 200 && d[i+1] < 55 && d[i+2] > 200;

async function writeGif(kept) {
  const { width, height } = kept[0].bitmap;
  const enc = new GifEncoder(width, height, 'neuquant', true);
  enc.setDelay(kept[0].delayCentisecs * 10);
  enc.setRepeat(0);
  enc.setTransparent(0xFF00FF);
  const out = createWriteStream(file);
  enc.createReadStream().pipe(out);
  await new Promise((resolve, reject) => {
    out.on('finish', resolve); out.on('error', reject);
    enc.start();
    for (const fr of kept) {
      const d = fr.bitmap.data;
      for (let i = 0; i < d.length; i += 4) if (isMagenta(d, i)) { d[i]=255; d[i+1]=0; d[i+2]=255; }
      enc.addFrame(d);
    }
    enc.finish();
  });
}

if (mode === '--export') {
  const dir = arg || '.';
  for (let i = 0; i < gif.frames.length; i++) {
    const { width, height, data } = gif.frames[i].bitmap;
    const img = new Jimp({ width, height });
    // copy, turning magenta into real transparency for clean viewing
    for (let p = 0; p < data.length; p += 4) {
      if (isMagenta(data, p)) { img.bitmap.data[p]=0; img.bitmap.data[p+1]=0; img.bitmap.data[p+2]=0; img.bitmap.data[p+3]=0; }
      else { img.bitmap.data[p]=data[p]; img.bitmap.data[p+1]=data[p+1]; img.bitmap.data[p+2]=data[p+2]; img.bitmap.data[p+3]=data[p+3]; }
    }
    const out = join(dir, `frame${i}.png`);
    await img.write(out);
    console.log(`  wrote ${out}`);
  }
} else if (mode === '--drop') {
  const n = parseInt(arg, 10);
  if (!Number.isInteger(n) || n < 1 || n >= gif.frames.length) { console.error('bad drop count'); process.exit(1); }
  await writeGif(gif.frames.slice(0, gif.frames.length - n));
  console.log(`dropped last ${n} -> ${gif.frames.length - n} left`);
} else if (mode === '--keep') {
  const idx = (arg || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);
  if (idx.length === 0) { console.error('no valid indices'); process.exit(1); }
  const kept = idx.map(i => gif.frames[i]).filter(Boolean);
  if (kept.length === 0) { console.error('no frames matched'); process.exit(1); }
  await writeGif(kept);
  console.log(`kept [${idx.join(',')}] -> ${kept.length} frames`);
}
