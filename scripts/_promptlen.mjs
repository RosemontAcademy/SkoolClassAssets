// 어떤 종이 «가운데가 잘리는» 프롬프트를 갖고 있는지 굽기 전에 센다.
// 잘림 = 기술 묘사가 통째로 뭉개진다는 뜻이고, 2026-09-12까지는 자르고도 한 글자를
// 넘겨 API가 422로 되던졌다. 크레딧을 쓰기 전에 여기서 걸러야 한다.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./generate_skill_fx.mjs', import.meta.url), 'utf8');
const pick = (re) => src.match(re)?.[1] ?? '';
const SINGLE = pick(/const SINGLE\s*=\s*'([^']*)'/);
const BEHIND = pick(/const BEHIND\s*=\s*'([^']*)'/);
const STYLE = pick(/const STYLE_TAIL\s*=\s*'([^']*)'/);
const SUFFIX = " — keep the reference sprite's exact colors and low-resolution pixel style.";
const BUDGET = 500 - SUFFIX.length - STYLE.length;

const FIELD = (name) => new RegExp(name + ":\\s*'((?:[^'\\\\]|\\\\.)*)'");
const rows = [...src.matchAll(/^ {2}([a-z0-9-]+): \{[\s\S]*?\n {2}\},/gm)]
  .map((m) => ({
    name: m[1],
    atk: m[0].match(FIELD('attackAction'))?.[1],
    atd: m[0].match(FIELD('attackedAction'))?.[1],
  }))
  .filter((r) => r.atk || r.atd);

console.log(`예산 ${BUDGET}자 — 앵커(SINGLE ${SINGLE.length}자, BEHIND ${BEHIND.length}자)까지 넣어서 셈\n`);
let bad = 0;
for (const r of rows) {
  const a = r.atk ? `${SINGLE}${BEHIND} ${r.atk}`.length : 0;
  const d = r.atd ? `${SINGLE} ${r.atd}`.length : 0;
  if (a > BUDGET || d > BUDGET) {
    bad++;
    console.log(`  ✂ ${r.name.padEnd(12)} 앞모습 ${String(d).padStart(3)}  뒷모습 ${String(a).padStart(3)}`);
  }
}
console.log(bad ? `\n잘리는 종 ${bad}개 — 프롬프트를 줄일 것` : `✅ ${rows.length}종 전부 예산 안에 든다`);
