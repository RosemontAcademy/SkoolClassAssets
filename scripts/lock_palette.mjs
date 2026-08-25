#!/usr/bin/env node
/**
 * scripts/lock_palette.mjs — 구운 FX 의 «캐릭터 색» 을 원본 스프라이트 색으로 되돌린다.
 *
 * 왜 필요한가: PixelLab v2 는 레퍼런스를 자기 스타일로 **다시 그린다.** 프롬프트에
 * "레퍼런스 색을 그대로 지켜라" 를 붙여도 지켜지지 않고, v2 API 에는 «레퍼런스에 더
 * 붙어 있어라» 같은 손잡이가 아예 없다(2026-08-25 스펙 확인 — seed·view·direction·
 * 배경제거가 전부다). 실측하면 원본 색 그대로인 픽셀이 0~10% 뿐이고 80% 안팎이
 * «조금 밀린 색» 이다. 눈에는 캐릭터가 살짝 다른 색으로 보인다.
 *
 * 어떻게: 0번 장은 **원본 스프라이트를 그대로 얹은 것**이라 그 팔레트가 곧 정답이다.
 * 1번 장부터, 팔레트에서 가장 가까운 색이 문턱 안이면 그 색으로 스냅한다. 문턱을
 * 넘으면 그건 캐릭터가 아니라 **이펙트**(하얀 발톱 자국·초록 칼날 등)이므로 손대지 않는다.
 *
 *   node scripts/lock_palette.mjs skillFX/paras/attack-fx.gif            → 덮어쓰기
 *   node scripts/lock_palette.mjs skillFX/paras/attack-fx.gif --out a.gif
 *   node scripts/lock_palette.mjs skillFX/paras/attack-fx.gif --t 40 --dry
 */
import { readFrames, encodeGif } from './lib/fxgif.mjs';
import { writeFileSync } from 'fs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const num = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : Number(args[i + 1]); };
const outArg = (() => { const i = args.indexOf('--out'); return i < 0 ? null : args[i + 1]; })();
const DRY = args.includes('--dry');
/** 이 거리 안이면 «캐릭터 색이 밀린 것», 넘으면 «이펙트». 실측 기준 40. */
const T = num('t', 40);

if (!file) { console.error('쓸 파일을 주세요: node scripts/lock_palette.mjs <gif> [--t 40] [--out x.gif] [--dry]'); process.exit(1); }

const g = readFrames(file);
if (g.frames.length < 2) { console.log('장이 하나뿐이라 되돌릴 게 없습니다: ' + file); process.exit(0); }

// 0번 장(원본) 팔레트
const seen = new Set(); const pal = [];
{
  const px = g.frames[0];
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    if (!seen.has(k)) { seen.add(k); pal.push([px[i], px[i + 1], px[i + 2]]); }
  }
}

const T2 = T * T;
let snapped = 0, kept = 0, total = 0;
const out = g.frames.map((px, f) => {
  if (f === 0) return px;                       // 원본 장은 손대지 않는다
  const copy = new Uint8Array(px);
  for (let i = 0; i < copy.length; i += 4) {
    if (copy[i + 3] < 128) continue;
    total++;
    let best = Infinity, bi = -1;
    for (let p = 0; p < pal.length; p++) {
      const c = pal[p];
      const d = (copy[i] - c[0]) ** 2 + (copy[i + 1] - c[1]) ** 2 + (copy[i + 2] - c[2]) ** 2;
      if (d < best) { best = d; bi = p; }
    }
    if (best <= T2) {
      if (best > 0) snapped++;
      const c = pal[bi];
      copy[i] = c[0]; copy[i + 1] = c[1]; copy[i + 2] = c[2];
    } else kept++;
  }
  return copy;
});

const pct = v => (total ? (v * 100 / total).toFixed(1) : '0') + '%';
console.log(`${file}\n  원본 팔레트 ${pal.length}색 · 문턱 ${T}`);
console.log(`  되돌린 픽셀 ${pct(snapped)} · 이펙트로 두고 넘어간 픽셀 ${pct(kept)}`);

if (DRY) { console.log('  (--dry 라 파일은 안 바꿨습니다)'); process.exit(0); }
const target = outArg || file;
writeFileSync(target, encodeGif(g.w, g.h, out, g.delay));
console.log('  저장: ' + target);
