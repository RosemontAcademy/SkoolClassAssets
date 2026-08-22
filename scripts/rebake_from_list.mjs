#!/usr/bin/env node
/**
 * scripts/rebake_from_list.mjs
 *
 * Re-bakes only the FX picked in the review page. The review artifact copies out
 * one line per item — `27-sandshrew attacked` — and this reads that list, runs
 * generate_skill_fx.mjs for exactly those steps, then files the results under the
 * dex-prefixed names the game actually points at.
 *
 * Why it exists: generate_skill_fx.mjs takes one character at a time and writes to
 * `skillFX/{slug}/{step}-fx.gif`, while the game reads
 * `skillFX/{dex}-{slug}/{dex}-{slug}-{step}-fx.gif`. That rename used to be done by
 * hand after every batch, which is exactly where a batch goes quietly wrong.
 *
 *   node scripts/rebake_from_list.mjs ../pixelLab/redo-2026-08-22.txt --dry
 *   node scripts/rebake_from_list.mjs ../pixelLab/redo-2026-08-22.txt
 *
 * Flags:
 *   --dry      print what would run, call nothing
 *   --keep     leave the current gif in place and save the new one as -v2/-v3
 *              (default: back the current one up under _prev/ and replace it)
 *   --only N   stop after N items (for a cheap first taste of a new prompt)
 *
 * Env: PIXELLAB_API_KEY (same key the generator uses)
 */

import { readFileSync, existsSync, mkdirSync, copyFileSync, renameSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_ROOT = join(__dirname, '..');
const FXD = join(ASSETS_ROOT, 'skillFX');
const GEN = join(__dirname, 'generate_skill_fx.mjs');

const args = process.argv.slice(2);
const listPath = args.find(a => !a.startsWith('--'));
const dry = args.includes('--dry');
const keep = args.includes('--keep');
const onlyN = args.includes('--only') ? parseInt(args[args.indexOf('--only') + 1], 10) : Infinity;

if (!listPath || !existsSync(listPath)) {
  console.error('사용법: node scripts/rebake_from_list.mjs <목록파일> [--dry] [--keep] [--only N]');
  process.exit(1);
}
if (!dry && !process.env.PIXELLAB_API_KEY) {
  console.error('PIXELLAB_API_KEY가 없습니다. (--dry 는 키 없이 됩니다)');
  process.exit(1);
}

// `13-weedle attack` -> { dir: '13-weedle', slug: 'weedle', step: 'attack' }
const items = readFileSync(listPath, 'utf8').split(/\r?\n/)
  .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(line => {
    const [dir, step] = line.split(/\s+/);
    const m = /^(\d+)-(.+)$/.exec(dir || '');
    if (!m || !['attack', 'attacked'].includes(step)) return { bad: line };
    return { dir, slug: m[2], step };
  });

const bad = items.filter(i => i.bad);
if (bad.length) {
  console.error('읽을 수 없는 줄:\n  ' + bad.map(b => b.bad).join('\n  '));
  process.exit(1);
}

const todo = items.slice(0, onlyN);
console.log(`목록 ${items.length}개${todo.length < items.length ? ` (이번엔 ${todo.length}개만)` : ''}\n`);

const done = [], failed = [];
for (const [i, it] of todo.entries()) {
  const target = join(FXD, it.dir, `${it.dir}-${it.step}-fx.gif`);
  const label = `[${i + 1}/${todo.length}] ${it.dir} ${it.step}`;

  if (dry) {
    console.log(`${label}\n    node generate_skill_fx.mjs ${it.slug} --step ${it.step}` +
      `\n    → ${target.replace(ASSETS_ROOT, '').replace(/\\/g, '/')}` +
      (existsSync(target) ? '' : '   (지금 파일 없음!)'));
    continue;
  }

  console.log(label);
  const res = spawnSync(process.execPath, [GEN, it.slug, '--step', it.step],
    { stdio: 'inherit', env: process.env });
  if (res.status !== 0) { failed.push(it.dir + ' ' + it.step + ' (생성 실패)'); continue; }

  // generate_skill_fx.mjs writes skillFX/{slug}/{step}-fx.gif, versioning if it already
  // exists -- so pick the newest of {step}-fx.gif / -v2 / -v3 ...
  const outDir = join(FXD, it.slug);
  const made = ['', '-v9', '-v8', '-v7', '-v6', '-v5', '-v4', '-v3', '-v2']
    .map(v => join(outDir, `${it.step}-fx${v}.gif`))
    .filter(existsSync)
    .sort((a, b) => b.localeCompare(a))[0];
  if (!made) { failed.push(it.dir + ' ' + it.step + ' (결과 파일을 못 찾음)'); continue; }

  mkdirSync(join(FXD, it.dir), { recursive: true });
  if (keep) {
    let n = 2, alt;
    do { alt = join(FXD, it.dir, `${it.dir}-${it.step}-fx-v${n++}.gif`); } while (existsSync(alt));
    renameSync(made, alt);
    console.log('    보관 → ' + alt.split(/[\\/]/).pop());
  } else {
    if (existsSync(target)) {
      const prev = join(FXD, it.dir, '_prev');
      mkdirSync(prev, { recursive: true });
      copyFileSync(target, join(prev, `${it.dir}-${it.step}-fx.gif`));
    }
    renameSync(made, target);
    console.log('    교체 → ' + target.split(/[\\/]/).pop() + '  (옛 파일은 _prev/ 에)');
  }
  done.push(it.dir + ' ' + it.step);

  // the generator's scratch folder is empty once we moved the result out
  try { rmSync(outDir, { recursive: true }); } catch {}
}

if (dry) { console.log('\n(미리보기였습니다 — --dry 를 빼면 실제로 굽습니다)'); process.exit(0); }
console.log(`\n완료 ${done.length}개` + (failed.length ? ` / 실패 ${failed.length}개:\n  ` + failed.join('\n  ') : ''));
console.log('다음: 자산 저장소에 커밋·푸시하고, 검수 화면을 다시 만들어 전후를 비교할 것.');
