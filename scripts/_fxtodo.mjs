// 아직 FX가 없는 단계를 도감 순으로 뽑는다.
// 프롬프트를 쓰려면 «도감번호 · 이름 · 기술 이름 · 스프라이트 크기»가 한 줄에 필요하다.
//
//   node scripts/_fxtodo.mjs [gen1 파일 경로]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { GifUtil } from 'gifwrap';

const SRC = process.argv[2] ?? '../api/_shared/pokemon_gen1.ts';
const src = readFileSync(new URL(SRC, import.meta.url), 'utf8');
const FRONT = new URL('../sprites/pokemon/other/showdown/', import.meta.url);
const files = readdirSync(FRONT);

// 한 줄 = 한 단계. 이름·기술·url(도감번호가 든다)·이미 배선됐는지.
const rows = [];
for (const m of src.matchAll(/\{ "name": "([^"]+)",[^\n]*?\/([0-9]+)-([a-z0-9-]+)\.gif`[^\n]*?"skill": \{ "name": "([^"]+)"[^\n]*/g)) {
  const [line, stage, dex, slug, skill] = m;
  rows.push({ stage, dex: +dex, slug, skill, wired: line.includes('attackFxBackUrl') });
}

const todo = rows.filter(r => !r.wired);
console.log(`전체 ${rows.length}단계 · 배선됨 ${rows.length - todo.length} · 남음 ${todo.length}\n`);

for (const r of todo) {
  const f = files.find(x => x.startsWith(`${r.dex}-`) && x.endsWith('.gif'));
  let size = '?';
  if (f) {
    try { const g = await GifUtil.read(new URL(f, FRONT)); size = `${g.width}x${g.height}`; } catch {}
  }
  // 캔버스: 스프라이트가 클수록 128에 꽉 찬다. 빈자리가 넓으면 모델이 제멋대로 채우므로
  // 되도록 128을 쓰고, 128을 넘는 것만 256으로 올린다(2026-09-12 어써러셔에서 실측).
  const h = Number(size.split('x')[1]) || 0;
  console.log(`${String(r.dex).padStart(4)}-${r.slug.padEnd(14)} ${r.stage.padEnd(14)} ${r.skill.padEnd(18)} ${size.padStart(8)}  canvas ${h > 128 ? 256 : 128}`);
}
