// 도감번호 없이 구워진 폴더를 진짜 이름표로 옮긴다.
//
//   skillFX/mankey/attacked-fx.gif  →  skillFX/56-mankey/56-mankey-attacked-fx.gif
//
// 생성기는 2026-09-12부터 처음부터 번호를 붙여 쓴다. 이 빗자루는 그 전에 구워진 것과,
// 고치는 중에 걸쳐 돌던 묶음이 남긴 것을 치우는 용도다.
//
//   node scripts/_fxsweep.mjs          — 무엇을 옮길지 보여주기만 한다
//   node scripts/_fxsweep.mjs --apply  — 실제로 옮긴다
import { readdirSync, existsSync, mkdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../skillFX/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const APPLY = process.argv.includes('--apply');

// 이름 → 도감번호는 생성기 설정이 정본이다(스프라이트 파일명과 같은 번호).
const src = readFileSync(new URL('./generate_skill_fx.mjs', import.meta.url), 'utf8');
const dex = new Map();
for (const m of src.matchAll(/^ {2}'?([a-z0-9-]+)'?: \{\s*\n\s*spriteId: (\d+)/gm)) dex.set(m[1], m[2]);

let moved = 0, skipped = 0;
for (const folder of readdirSync(ROOT)) {
  if (!statSync(join(ROOT, folder)).isDirectory()) continue;
  if (/^\d+-/.test(folder)) continue;              // 이미 번호가 붙어 있다
  const id = dex.get(folder);
  if (!id) { console.log(`  ? ${folder} — 설정에 없는 이름이라 건드리지 않는다`); skipped++; continue; }

  const target = join(ROOT, `${id}-${folder}`);
  for (const f of readdirSync(join(ROOT, folder))) {
    const from = join(ROOT, folder, f);
    if (statSync(from).isDirectory()) {            // _raw 같은 아랫폴더는 통째로
      const to = join(target, f);
      if (existsSync(to)) { console.log(`  = ${folder}/${f} 이미 있음`); skipped++; continue; }
      if (APPLY) { mkdirSync(target, { recursive: true }); renameSync(from, to); }
      console.log(`  → ${folder}/${f}  ⇒  ${id}-${folder}/${f}`); moved++;
      continue;
    }
    // attack-fx.gif → 56-mankey-attack-fx.gif  (v2 같은 판 이름도 그대로 살린다)
    const to = join(target, `${id}-${folder}-${f}`);
    if (existsSync(to)) { console.log(`  = ${folder}/${f} 이미 있음 — 덮어쓰지 않는다`); skipped++; continue; }
    if (APPLY) { mkdirSync(target, { recursive: true }); renameSync(from, to); }
    console.log(`  → ${folder}/${f}  ⇒  ${id}-${folder}/${id}-${folder}-${f}`); moved++;
  }
  if (APPLY) { try { rmdirSync(join(ROOT, folder)); } catch {} }
}
console.log(`\n${APPLY ? '옮김' : '옮길 것'} ${moved}개${skipped ? ` · 건너뜀 ${skipped}개` : ''}`);
if (!APPLY && moved) console.log('실제로 옮기려면 --apply');
