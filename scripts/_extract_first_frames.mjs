// Extract the FIRST FRAME of every showdown gif into still / still-back folders as PNG.
// Good for handing PixelLab a static reference instead of an animated gif.
//   node _extract_first_frames.mjs
import { createRequire } from 'module';
import { readdirSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
const require = createRequire(import.meta.url);
const { Jimp } = require('jimp');

const ROOT = join(import.meta.dirname, '..');
const FRONT = join(ROOT, 'sprites', 'pokemon', 'other', 'showdown');
const BACK = join(FRONT, 'back');
const STILL = join(FRONT, 'still');
const STILL_BACK = join(FRONT, 'still-back');

async function run(srcDir, outDir, label) {
  mkdirSync(outDir, { recursive: true });
  const gifs = readdirSync(srcDir).filter(f => f.toLowerCase().endsWith('.gif'));
  let ok = 0, skip = 0, fail = 0;
  console.log(`[${label}] ${gifs.length} gifs -> ${outDir}`);
  for (let i = 0; i < gifs.length; i++) {
    const base = gifs[i].replace(/\.gif$/i, '');
    const out = join(outDir, `${base}.png`);
    if (existsSync(out)) { skip++; continue; }
    try {
      const img = await Jimp.read(join(srcDir, gifs[i])); // Jimp returns the first frame of a gif
      await img.write(out);
      ok++;
    } catch (e) {
      fail++;
      console.log(`  ! fail ${gifs[i]}: ${String(e).slice(0, 80)}`);
    }
    if ((i + 1) % 200 === 0) console.log(`  [${label}] ${i + 1}/${gifs.length} (ok=${ok} skip=${skip} fail=${fail})`);
  }
  console.log(`[${label}] DONE ok=${ok} skip=${skip} fail=${fail}`);
}

await run(FRONT, STILL, 'front');       // top-level gifs only (readdir non-recursive; ignores back/ subdir)
await run(BACK, STILL_BACK, 'back');
console.log('ALL DONE');
