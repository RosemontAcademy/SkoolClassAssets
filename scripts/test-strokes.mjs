/**
 * 편집기와 굽는 쪽이 «같은 셈» 인지 잰다.   실행:  node scripts/test-strokes.mjs
 *
 * 손질(stroke)은 두 곳에서 각각 다시 돌아간다 —
 *   · 화면:  scripts/fx-studio.mjs 의 pixelOp
 *   · gif :  scripts/lib/fxgif.mjs 의 applyEdits
 * 한 자라도 어긋나면 «화면에선 멀쩡한데 gif 만 다른» 병이 된다. 그건 아무도 못 본 채로
 * 아이들 화면까지 간다. 그래서 새 손질을 넣을 때마다 여기 한 줄을 보태야 한다.
 *
 * 이 검사는 스스로도 의심한다 — 손질이 그림을 «실제로» 바꿨는지까지 세서,
 * 두 쪽이 나란히 아무것도 안 해서 통과하는 «헛통과» 를 막는다.
 */
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const { applyEdits } = await import(pathToFileURL(join(here, 'lib', 'fxgif.mjs')).href);
const src = readFileSync(join(here, 'fx-studio.mjs'), 'utf8');

// 편집기 쪽 셈은 HTML 안에 글자로 들어 있다. 괄호를 세어 함수만 떠 온다.
function grab(name, kind) {
  const head = kind === 'fn' ? ('function ' + name + '(') : ('const ' + name + '=');
  const i = src.indexOf(head);
  if (i < 0) throw new Error('fx-studio.mjs 에서 못 찾음: ' + name);
  if (kind !== 'fn') return src.slice(i, src.indexOf('\n', src.indexOf('return u};', i)));
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && !--d) return src.slice(i, k + 1);
  }
  throw new Error('괄호가 안 닫힘: ' + name);
}
const editorOp = new Function(
  grab('fromB64', 'const') + ';' + grab('adjPixels', 'fn') + ';' + grab('pixelOp', 'fn')
  + ';return pixelOp;')();

const W = 64, H = 64;
const rnd = (s => () => ((s = s * 16807 % 2147483647) / 2147483647))(7);
const makePx = () => {
  const p = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    p[i * 4] = (rnd() * 255) | 0; p[i * 4 + 1] = (rnd() * 255) | 0;
    p[i * 4 + 2] = (rnd() * 255) | 0; p[i * 4 + 3] = rnd() > 0.35 ? 255 : 0;
  }
  return p;
};
// 편집기는 canvas 로 읽고 쓴다 — 알갱이 통만 흉내 내면 같은 셈이 그대로 돈다.
const fakeCtx = px => ({ getImageData: () => ({ data: px }), putImageData: () => {} });

const piece = (w, h) => {
  const u = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    u[i * 4] = (rnd() * 255) | 0; u[i * 4 + 1] = (rnd() * 255) | 0;
    u[i * 4 + 2] = (rnd() * 255) | 0; u[i * 4 + 3] = rnd() > 0.2 ? 255 : 0;
  }
  return u;
};
const P = piece(11, 7), D = Buffer.from(P).toString('base64');
// 표대로 비우기용 — 동그란 표 하나(네모가 아닌 자리를 지우는 셈이 맞는지 본다)
const MASK = Buffer.from(Array.from({ length: 81 }, (_, i) => {
  const x = i % 9 - 4, y = (i / 9 | 0) - 4;
  return x * x + y * y <= 16 ? 1 : 0;
})).toString('base64');

const CASES = [
  ['동그랗게 칠하기',     { t: 'p', x: 20.5, y: 18.5, r: 4.5, color: [10, 200, 90] }, true],
  ['동그랗게 지우기',     { t: 'c', x: 20.5, y: 18.5, r: 4.5 }, true],
  ['네모나게 지우기',     { t: 'r', x: 5, y: 5, w: 12, h: 9 }, true],
  ['색 바꾸기',           { t: 'swap', from: [10, 200, 90], to: [200, 10, 10], tol: 200 }, true],
  ['페인트통',            { t: 'fill', x: 30.5, y: 30.5, color: [5, 5, 250], tol: 90 }, true],
  ['그림 전체 밀기',      { t: 'shift', dx: 3, dy: -2 }, true],
  ['옮기기(blit·cut)',    { t: 'blit', sx: 4, sy: 4, sw: 12, sh: 9, dx: 24, dy: 14, dw: 12, dh: 9, rot: 0, fx: 0, fy: 0, cut: 1 }, true],
  ['복제·돌리기·키우기',  { t: 'blit', sx: 4, sy: 4, sw: 12, sh: 9, dx: 24, dy: 14, dw: 24, dh: 18, rot: 90, fx: 1, fy: 0, cut: 0 }, true],
  ['도장 그대로',         { t: 'stamp', sw: 11, sh: 7, data: D, dx: 5, dy: 9, dw: 11, dh: 7, rot: 0, fx: 0, fy: 0 }, true],
  ['도장 90도',           { t: 'stamp', sw: 11, sh: 7, data: D, dx: 20, dy: 3, dw: 7, dh: 11, rot: 90, fx: 0, fy: 0 }, true],
  ['도장 뒤집고 키우고',  { t: 'stamp', sw: 11, sh: 7, data: D, dx: 30, dy: 30, dw: 22, dh: 14, rot: 180, fx: 1, fy: 1 }, true],
  ['도장 가장자리 밖',    { t: 'stamp', sw: 11, sh: 7, data: D, dx: 60, dy: 60, dw: 11, dh: 7, rot: 270, fx: 0, fy: 0 }, true],
  ['표대로 비우기',       { t: 'em', x: 6, y: 6, w: 9, h: 9, mask: MASK }, true],
  ['표 비우기 가장자리 밖', { t: 'em', x: 58, y: 58, w: 9, h: 9, mask: MASK }, true],
  ['표가 모자람',         { t: 'em', x: 6, y: 6, w: 9, h: 9, mask: Buffer.from([1, 1, 1]).toString('base64') }, false],
  ['표대로 칠하기',       { t: 'pm', x: 6, y: 6, w: 9, h: 9, mask: MASK, color: [250, 20, 90] }, true],
  ['칠하기 가장자리 밖',  { t: 'pm', x: 58, y: 58, w: 9, h: 9, mask: MASK, color: [250, 20, 90] }, true],
  ['칠할 표가 모자람',    { t: 'pm', x: 6, y: 6, w: 9, h: 9, mask: Buffer.from([1]).toString('base64'), color: [1, 2, 3] }, false],
  ['도장붓 세 자리',     { t: 'stamps', sw: 11, sh: 7, data: D, at: [[4, 4], [20, 20], [40, 40]] }, true],
  ['도장붓 가장자리 밖', { t: 'stamps', sw: 11, sh: 7, data: D, at: [[60, 60], [-5, -5]] }, true],
  ['도장붓 자리가 없으면', { t: 'stamps', sw: 11, sh: 7, data: D, at: [] }, false],
  ['무늬로 칠하기',       { t: 'p', x: 30.5, y: 30.5, r: 5.5, color: [250, 0, 0], dith: 1 }, true],
  ['무늬 페인트통',       { t: 'fill', x: 30.5, y: 30.5, color: [0, 250, 0], tol: 90, dith: 1 }, true],
  ['명암 어둡게',         { t: 'sh', x: 6, y: 6, w: 9, h: 9, steps: Buffer.from(Array.from({length:81},(_,i)=>(i%3)+1)).toString('base64'), dir: -1, ramp: [[20,20,30],[60,60,80],[120,120,150],[200,200,220],[250,250,255]] }, true],
  ['명암 밝게',           { t: 'sh', x: 20, y: 20, w: 9, h: 9, steps: Buffer.from(Array.from({length:81},(_,i)=>(i%3)+1)).toString('base64'), dir: 1, ramp: [[20,20,30],[60,60,80],[120,120,150],[200,200,220],[250,250,255]] }, true],
  ['명암 색 줄이 비면',   { t: 'sh', x: 6, y: 6, w: 9, h: 9, steps: Buffer.from(Array.from({length:81},(_,i)=>(i%3)+1)).toString('base64'), dir: -1, ramp: [] }, false],
  ['색조 돌리기(통째)',   { t: 'adj', hue: 120, sat: 100, val: 100, con: 0 }, true],
  ['진하기·밝기',         { t: 'adj', x: 4, y: 4, w: 30, h: 30, hue: 0, sat: 160, val: 70, con: 0 }, true],
  ['대비만',              { t: 'adj', x: 0, y: 0, w: 64, h: 64, hue: 0, sat: 100, val: 100, con: 60 }, true],
  ['고른 곳만 색 손보기', { t: 'adj', x: 6, y: 6, w: 9, h: 9, mask: MASK, hue: -90, sat: 130, val: 120, con: -30 }, true],
  ['안 민 것은 그대로',   { t: 'adj', x: 0, y: 0, w: 64, h: 64, hue: 0, sat: 100, val: 100, con: 0 }, false],
  // 알갱이가 모자란 도장은 «아무것도 안 하는 것» 이 맞다 — 반쪽만 찍히면 안 된다.
  ['도장 알갱이 모자람',  { t: 'stamp', sw: 11, sh: 7, data: Buffer.from(P.slice(0, 40)).toString('base64'), dx: 5, dy: 5, dw: 11, dh: 7, rot: 0, fx: 0, fy: 0 }, false],
];

let bad = 0, vacuous = 0;
for (const [name, st, mustChange] of CASES) {
  const a = makePx(), b = Uint8ClampedArray.from(a), before = Uint8ClampedArray.from(a);
  editorOp(fakeCtx(a), st, W, H);
  applyEdits(b, W, H, [st]);
  let diff = 0, chg = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) diff++; if (a[i] !== before[i]) chg++; }
  const ok = !diff && (!!chg === mustChange);
  if (!ok) { bad++; if (!diff) vacuous++; }
  console.log((ok ? 'ok    ' : 'FAIL  ') + name.padEnd(22)
    + ' 두 쪽 차이 ' + diff + '자 · 바뀐 자리 ' + chg + '자'
    + (!diff && !!chg !== mustChange ? '  ← 그림이 ' + (mustChange ? '안 바뀌었다(헛통과)' : '바뀌면 안 된다') : ''));
}
console.log(bad
  ? ('\n어긋남 ' + bad + '건' + (vacuous ? ' (그중 헛통과 ' + vacuous + '건)' : ''))
  : '\n두 쪽이 같다 · 헛통과 없음');
process.exit(bad ? 1 : 0);
