/**
 * 층 굽기를 잰다.   실행:  node scripts/test-layers.mjs
 *
 * 「진짜 층」의 고갱이는 **빈 바닥**(src:'blank') 하나다. 층 바닥으로 투명한 낱장을
 * 허용하면 그려 넣는 층이 「빈 바닥 + 손질 줄」로 굳는다 — 굽는 셈을 새로 안 넣어도 되고,
 * over 항목이 하나 느는 것뿐이라 옛 저장본이 그대로 읽힌다.
 *
 * 여기서 재는 것:
 *   1. 빈 층에 그린 것이 바닥 위에 제대로 얹히는가
 *   2. 빈 층이 «바닥» 자리에 오면 분명한 말로 막히는가 (크기를 알 수 없으니까)
 *   3. 옛 조리법(층 없는 것)이 예전과 한 자도 안 다르게 나오는가  ← 62개가 여기 걸려 있다
 *   4. 층의 투명도·눈 끄기가 먹는가
 *
 * 낱장은 지어내서 넣는다 — 디스크와 서버를 안 타므로 언제 어디서 돌려도 같은 답이 나온다.
 */
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const { composeSeq, contentBox, listItems } = await import(pathToFileURL(join(here, 'lib', 'fxgif.mjs')).href);

const W = 16, H = 16;
/** 온통 한 색인 낱장 하나. */
const flat = (r, g, b, a = 255) => {
  const px = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = a; }
  return px;
};
const SRC = {
  'live': { w: W, h: H, frames: [flat(10, 20, 30), flat(40, 50, 60)] },
  'other': { w: W, h: H, frames: [flat(200, 0, 0)] },
  'wrongsize': { w: 8, h: 8, frames: [new Uint8Array(8 * 8 * 4)] },
};
const get = (d, k, id) => SRC[id] || null;
const at = (px, x, y) => { const i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

let fail = 0;
const say = (ok, t, extra) => { console.log((ok ? 'ok    ' : 'FAIL  ') + t + (extra ? '  — ' + extra : '')); if (!ok) fail++; };
const throws = fn => { try { fn(); return null; } catch (e) { return e.message; } };

// 표대로 칠하기 손질 하나 — 왼쪽 위 4×4 를 노랗게
const paint = {
  t: 'pm', x: 1, y: 1, w: 4, h: 4,
  mask: Buffer.from(new Uint8Array(16).fill(1)).toString('base64'),
  color: [250, 240, 20],
};

// 1. 빈 층에 그린 것이 바닥 위에 얹힌다
{
  const out = composeSeq({
    dir: 'x', kind: 'attack',
    seq: [{ src: 'live', i: 0, over: [{ src: 'blank', i: 0, erase: [paint] }] }],
  }, get);
  const px = out.picked[0];
  say(out.w === W && out.h === H, '캔버스 크기는 바닥 낱장에서 온다', out.w + '×' + out.h);
  say(same(at(px, 2, 2), [250, 240, 20, 255]), '빈 층에 그린 자리가 얹힌다', at(px, 2, 2).join(','));
  say(same(at(px, 10, 10), [10, 20, 30, 255]), '안 그린 자리는 바닥 그대로다', at(px, 10, 10).join(','));
}

// 2. 빈 층이 «바닥» 자리에 오면 분명한 말로 막힌다
{
  const msg = throws(() => composeSeq({ dir: 'x', kind: 'attack', seq: [{ src: 'blank', i: 0 }] }, get));
  say(!!msg && /빈 층/.test(msg), '빈 층을 맨 아래 두면 분명한 말로 막는다', msg || '(안 막힘)');
}

// 3. 옛 조리법이 예전과 한 자도 안 다르다  ← 지금 저장본 62개가 여기 걸려 있다
{
  const old = composeSeq({ dir: 'x', kind: 'attack', seq: [{ src: 'live', i: 0 }, { src: 'live', i: 1 }] }, get);
  say(old.picked.length === 2, '옛 조리법이 그대로 두 장을 낸다');
  say(same([...old.picked[0].slice(0, 4)], [10, 20, 30, 255])
    && same([...old.picked[1].slice(0, 4)], [40, 50, 60, 255]), '옛 조리법의 알갱이가 그대로다');
  const withLayer = composeSeq({
    dir: 'x', kind: 'attack',
    seq: [{ src: 'live', i: 0, over: [{ src: 'other', i: 0, op: 0 }] }],
  }, get);
  say(same([...withLayer.picked[0].slice(0, 4)], [10, 20, 30, 255]), '투명도 0인 층은 아무것도 안 바꾼다');
}

// 4. 눈을 끈 층은 굽기에서 빠진다
{
  const on = composeSeq({ dir: 'x', kind: 'attack', seq: [{ src: 'live', i: 0, over: [{ src: 'other', i: 0 }] }] }, get);
  const off = composeSeq({ dir: 'x', kind: 'attack', seq: [{ src: 'live', i: 0, over: [{ src: 'other', i: 0, off: 1 }] }] }, get);
  say(same(at(on.picked[0], 5, 5), [200, 0, 0, 255]), '켜 둔 층은 얹힌다');
  say(same(at(off.picked[0], 5, 5), [10, 20, 30, 255]), '눈을 끈 층은 안 얹힌다');
}

// 5. 크기가 다른 낱장은 예전처럼 막힌다(빈 층을 넣었다고 이 방어가 풀리면 안 된다)
{
  const msg = throws(() => composeSeq({
    dir: 'x', kind: 'attack',
    seq: [{ src: 'live', i: 0, over: [{ src: 'wrongsize', i: 0 }] }],
  }, get));
  say(!!msg && /크기가 다릅니다/.test(msg), '크기가 다른 낱장은 여전히 막힌다', msg || '(안 막힘)');
}

// 6. 그림이 있는 칸만 잰다 — 편집기가 빈 칸에 맞추면 캐릭터가 점이 된다
{
  const px = new Uint8Array(W * H * 4);
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) {
    const i = (y * W + x) * 4; px[i] = 1; px[i + 3] = 255;
  }
  const b = contentBox(px, W, H);
  say(b.x === 4 && b.y === 4 && b.w === 4 && b.h === 4, '그림 있는 칸만 잰다', JSON.stringify(b));
  const empty = contentBox(new Uint8Array(W * H * 4), W, H);
  say(empty.w === W && empty.h === H, '빈 칸은 통째로 돌려준다');
}

// 7. hit 도 목록에 있다. attack·attacked 는 그대로다.
{
  const items = listItems(join(here, '..', 'skillFX'));
  say(items.some(it => it.kind === 'hit'), 'hit 도 목록에 있다');
  say(items.some(it => it.kind === 'attack') && items.some(it => it.kind === 'attacked'), 'attack·attacked 는 그대로다');
}

console.log(fail ? ('\n어긋남 ' + fail + '건') : '\n모두 통과');
process.exit(fail ? 1 : 0);
