// gif 한 벌을 «프레임을 가로로 늘어놓은 한 장»으로 굽는다 — 검수용.
//
// 왜 이렇게까지 하나: 투명 배경 gif를 그냥 열면 프레임이 겹쳐 보여 무엇이 언제
// 나왔는지 못 가른다. 체크무늬를 깔고(투명이 보이게), 빨간 테두리로 캔버스 경계를
// 그려(«코너에 붙었나»를 잴 수 있게), 3배로 키운다(픽셀 그림은 작으면 판단이 안 선다).
//
//   node scripts/_fxsheet.mjs <출력.png> <gif> [gif ...]
import { GifUtil } from 'gifwrap';
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

// 확대율은 프레임 크기에 맞춰 정한다 — 256px짜리를 3배로 늘리면 한 줄이 4000px가 넘어
// 화면에 들어가지도 않고, 결국 아무것도 못 본다.
const GAP = 10, ROWGAP = 16;
const S = Number(process.env.FXSHEET_SCALE ?? 0) || null;
const out = process.argv[2];
const gifs = process.argv.slice(3);

const rows = [];
for (const p of gifs) {
  const g = await GifUtil.read(p);
  rows.push({
    label: `${basename(dirname(p))}/${basename(p)}`,
    w: g.width, h: g.height,
    frames: g.frames.map(f => f.bitmap),
  });
}

const scale = S ?? Math.max(1, Math.round(384 / Math.max(...rows.map(r => r.w))));
const rowW = (r) => GAP + r.frames.length * (r.w * scale + GAP);
const W = Math.max(...rows.map(rowW));
const H = rows.reduce((a, r) => a + r.h * scale + ROWGAP, ROWGAP);
const sheet = new PNG({ width: W, height: H });
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (W * y + x) << 2, c = ((x >> 4) + (y >> 4)) % 2 ? 205 : 232;
  sheet.data[i] = c; sheet.data[i + 1] = c; sheet.data[i + 2] = c; sheet.data[i + 3] = 255;
}

let oy = ROWGAP;
for (const r of rows) {
  r.frames.forEach((bm, n) => {
    const ox = GAP + n * (r.w * scale + GAP);
    for (let y = 0; y < r.h * scale; y++) for (let x = 0; x < r.w * scale; x++) {
      const d = (W * (y + oy) + x + ox) << 2;
      if (x === 0 || y === 0 || x === r.w * scale - 1 || y === r.h * scale - 1) {
        sheet.data[d] = 255; sheet.data[d + 1] = 80; sheet.data[d + 2] = 80; continue;
      }
      const s = (r.w * ((y / scale) | 0) + ((x / scale) | 0)) << 2;
      const a = bm.data[s + 3] / 255;
      if (!a) continue;
      for (let k = 0; k < 3; k++) sheet.data[d + k] = Math.round(bm.data[s + k] * a + sheet.data[d + k] * (1 - a));
    }
  });
  console.log(`${r.label.padEnd(34)} ${r.frames.length}프레임 ${r.w}x${r.h}`);
  oy += r.h * scale + ROWGAP;
}
writeFileSync(out, PNG.sync.write(sheet));
console.log(`→ ${out}`);
