// DEMO: prepend the padded reference sprite as frame 0 of an existing gif (no API).
//   node _demo_ref_first.mjs <id> <canvasSize> <corner bottom-left|top-right> <inGif> <outGif>
import { createRequire } from 'module';
import { createWriteStream, readdirSync } from 'fs';
import { join } from 'path';
const require = createRequire(import.meta.url);
const { Jimp, JimpMime, ResizeStrategy } = require('jimp');
const { GifUtil } = require('gifwrap');
const GifEncoder = require('gif-encoder-2');

const [, , id, sizeStr, corner, inGif, outGif] = process.argv;
const canvasSize = parseInt(sizeStr, 10);
const ROOT = join(import.meta.dirname, '..');
const FRONT = join(ROOT, 'sprites', 'pokemon', 'other', 'showdown');
const BACK = join(FRONT, 'back');
const dir = corner === 'top-right' ? FRONT : BACK;

// build padded reference RGBA with magenta in transparent areas
const fname = readdirSync(dir).find(f => f.startsWith(`${id}-`) && f.endsWith('.gif')) ?? `${id}.gif`;
const sp = await Jimp.read(join(dir, fname));
if (sp.height > canvasSize) {
  const r = canvasSize / sp.height;
  sp.resize({ w: Math.floor(sp.width * r), h: canvasSize, mode: ResizeStrategy.NEAREST_NEIGHBOR });
}
const canvas = new Jimp({ width: canvasSize, height: canvasSize, color: 0x00000000 });
const x = corner === 'bottom-left' ? 0 : canvasSize - sp.width;
const y = corner === 'bottom-left' ? canvasSize - sp.height : 0;
canvas.composite(sp, x, y);
const refData = canvas.bitmap.data;
for (let i = 0; i < refData.length; i += 4) if (refData[i+3] < 128) { refData[i]=255; refData[i+1]=0; refData[i+2]=255; refData[i+3]=255; }

const gif = await GifUtil.read(inGif);
const W = gif.frames[0].bitmap.width, H = gif.frames[0].bitmap.height;
const frames = [Buffer.from(refData), ...gif.frames.map(f => {
  const d = f.bitmap.data;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i+1] < 55 && d[i+2] > 200) { d[i]=255; d[i+1]=0; d[i+2]=255; }
  return Buffer.from(d);
})];

const enc = new GifEncoder(W, H, 'neuquant', true);
enc.setDelay(250); enc.setRepeat(0); enc.setTransparent(0xFF00FF);
const out = createWriteStream(outGif);
enc.createReadStream().pipe(out);
await new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); enc.start(); frames.forEach(f => enc.addFrame(f)); enc.finish(); });
console.log(`wrote ${outGif} (${frames.length} frames, ref-first)`);
