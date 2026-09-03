// Dump the exact reference image padSprite() sends to the API, for inspection.
//   node _ref_dump.mjs <id> <canvasSize> <outDir>
import { createRequire } from 'module';
import { readdirSync } from 'fs';
import { join } from 'path';
const require = createRequire(import.meta.url);
const { Jimp, JimpMime, ResizeStrategy } = require('jimp');

const [, , idStr, sizeStr, outDir] = process.argv;
const id = idStr, canvasSize = parseInt(sizeStr, 10) || 128;
const ROOT = join(import.meta.dirname, '..');
const FRONT = join(ROOT, 'sprites', 'pokemon', 'other', 'showdown');
const BACK = join(FRONT, 'back');

async function pad(dir, corner) {
  const fname = readdirSync(dir).find(f => f.startsWith(`${id}-`) && f.endsWith('.gif')) ?? `${id}.gif`;
  const img = await Jimp.read(join(dir, fname));
  if (img.height > canvasSize) {
    const r = canvasSize / img.height;
    img.resize({ w: Math.floor(img.width * r), h: canvasSize, mode: ResizeStrategy.NEAREST_NEIGHBOR });
  }
  const canvas = new Jimp({ width: canvasSize, height: canvasSize, color: 0x00000000 });
  const x = corner === 'bottom-left' ? 0 : canvasSize - img.width;
  const y = corner === 'bottom-left' ? canvasSize - img.height : 0;
  canvas.composite(img, x, y);
  const out = join(outDir, `ref-${id}-${corner}-${fname.replace('.gif','')}.png`);
  await canvas.write(out);
  console.log(`  ${dir.includes('back') ? 'BACK ' : 'FRONT'} src=${fname} -> ${out}`);
}

await pad(BACK, 'bottom-left');   // attack reference
await pad(FRONT, 'top-right');    // attacked reference
