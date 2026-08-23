/**
 * scripts/lib/fxgif.mjs — gif 낱장을 읽고, 지우고, 다시 굽는 공용 부분.
 *
 * mix_frames.mjs(명령줄)와 fx-studio.mjs(편집기)가 같은 코드를 쓴다.
 * 복사해 두면 한쪽만 고쳐져 조용히 갈라진다.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { GifReader } from 'omggif';
import GifEncoder from 'gif-encoder-2';

/**
 * 이 gif들은 모든 장이 캔버스 전체 크기에 disposal=2(매 장 배경으로 되돌림)다.
 * 그래서 각 장은 **비운 버퍼**에 그려야 한다. 앞 장 위에 계속 덧그리면
 * 모든 장이 포개져 보이고, 면적·덩어리 수치가 전부 부풀려진다.
 */
export function readFrames(path) {
  const r = new GifReader(readFileSync(path));
  const size = r.width * r.height * 4;
  const frames = [];
  let prev = null;
  for (let i = 0; i < r.numFrames(); i++) {
    const info = r.frameInfo(i);
    const buf = new Uint8Array(size);
    if (prev && (info.disposal === 0 || info.disposal === 1)) buf.set(prev);
    r.decodeAndBlitFrameRGBA(i, buf);
    prev = buf;
    frames.push(buf);
  }
  return { w: r.width, h: r.height, frames, delay: (r.frameInfo(0).delay || 25) * 10 };
}

const MAGENTA = 0xFF00FF;

/**
 * delay 는 ms. gif는 10ms 단위로만 저장하니 그 단위로 맞춰 들어와야 한다.
 * 숫자 하나를 주면 전부 같은 간격, 배열을 주면 **장마다 다른 간격**이 된다.
 * 장마다 다르게 줄 수 있어야 하는 이유: 0번 장은 이펙트가 아직 없는 맨 스프라이트라,
 * 다른 장과 같은 시간을 주면 공격이 시작되기 전에 멈춰 있는 것처럼 보인다.
 */
export function encodeGif(w, h, frames, delayMs) {
  const per = Array.isArray(delayMs) ? delayMs : null;
  const enc = new GifEncoder(w, h, 'neuquant', true, frames.length);
  if (!per) enc.setDelay(delayMs);
  enc.setRepeat(0);
  enc.setTransparent(MAGENTA);
  enc.start();
  for (let k = 0; k < frames.length; k++) {
    const src = frames[k];
    if (per) enc.setDelay(per[k] ?? per[per.length - 1]);
    // gif-encoder-2 는 RGBA 를 읽는다. 투명 픽셀을 마젠타로 칠해 두면
    // 투명 인덱스가 팔레트에서 정확히 잡힌다.
    const px = new Uint8Array(src);
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) { px[i] = 255; px[i + 1] = 0; px[i + 2] = 255; }
    }
    enc.addFrame(px);
  }
  enc.finish();
  return enc.out.getData();
}

/**
 * 손질 한 벌을 낱장에 적용한다. 화면의 붓과 **같은 모양**으로 계산해야 해서
 * 동그라미는 거리 제곱으로 잰다(사각형 근사로 하면 화면과 결과가 달라진다).
 *
 *   { t:'c', x, y, r }                   동그랗게 지우기
 *   { t:'r', x, y, w, h }                네모나게 지우기
 *   { t:'p', x, y, r, color:[r,g,b] }    동그랗게 칠하기
 *   { t:'swap', from:[r,g,b], to:[r,g,b], tol }  그 색을 저 색으로 (tol = 허용 오차)
 */
export function applyEdits(px, w, h, edits) {
  const circle = (st, fn) => {
    const rr = st.r * st.r;
    const x0 = Math.max(0, Math.floor(st.x - st.r)), y0 = Math.max(0, Math.floor(st.y - st.r));
    const x1 = Math.min(w, Math.ceil(st.x + st.r)), y1 = Math.min(h, Math.ceil(st.y + st.r));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - st.x, dy = y + 0.5 - st.y;
      if (dx * dx + dy * dy <= rr) fn((y * w + x) * 4);
    }
  };
  for (const st of edits || []) {
    if (st.t === 'r') {
      const x0 = Math.max(0, Math.floor(st.x)), y0 = Math.max(0, Math.floor(st.y));
      const x1 = Math.min(w, Math.ceil(st.x + st.w)), y1 = Math.min(h, Math.ceil(st.y + st.h));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[(y * w + x) * 4 + 3] = 0;
    } else if (st.t === 'c') {
      circle(st, i => { px[i + 3] = 0; });
    } else if (st.t === 'p') {
      const [r, g, b] = st.color || [255, 255, 255];
      circle(st, i => { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; });
    } else if (st.t === 'swap') {
      const [fr, fg, fb] = st.from, [tr, tg, tb] = st.to;
      const tol = (st.tol ?? 20) ** 2 * 3;
      for (let i = 0; i < w * h * 4; i += 4) {
        if (px[i + 3] < 40) continue;
        const dr = px[i] - fr, dg = px[i + 1] - fg, db = px[i + 2] - fb;
        if (dr * dr + dg * dg + db * db <= tol) { px[i] = tr; px[i + 1] = tg; px[i + 2] = tb; }
      }
    } else if (st.t === 'fill') {
      // 페인트통. 누른 자리와 '비슷한 색'으로 이어진 덩어리만 칠한다.
      const sx = Math.floor(st.x), sy = Math.floor(st.y);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const si = (sy * w + sx) * 4;
      const seed = [px[si], px[si + 1], px[si + 2], px[si + 3]];
      const [tr, tg, tb] = st.color;
      const tol = (st.tol ?? 20) ** 2 * 3;
      const near = i => {
        // 투명끼리도 이어진 것으로 본다(빈 곳을 칠해 메울 수 있게)
        if (seed[3] < 40) return px[i + 3] < 40;
        if (px[i + 3] < 40) return false;
        const dr = px[i] - seed[0], dg = px[i + 1] - seed[1], db = px[i + 2] - seed[2];
        return dr * dr + dg * dg + db * db <= tol;
      };
      const seen = new Uint8Array(w * h);
      const stack = [sy * w + sx];
      seen[sy * w + sx] = 1;
      while (stack.length) {
        const p = stack.pop(), i = p * 4;
        if (!near(i)) continue;
        px[i] = tr; px[i + 1] = tg; px[i + 2] = tb; px[i + 3] = 255;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x < w - 1 && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
        if (y < h - 1 && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
      }
    } else if (st.t === 'shift') {
      // 낱장 전체를 몇 칸 옮긴다. 한 장만 어긋나 있을 때 쓴다.
      const out = new Uint8Array(px.length);
      const dx = Math.round(st.dx), dy = Math.round(st.dy);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = x - dx, sy = y - dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const s = (sy * w + sx) * 4, d = (y * w + x) * 4;
        out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
      }
      px.set(out);
    }
  }
}

/**
 * 층 하나를 아래 그림 위에 얹는다.
 *
 * 게임의 선생님 화면은 FX 를 screen 으로 합성해서 검은 곳이 비쳐 보인다.
 * 편집기에서 normal 로만 겹쳐 보면 게임에서 어떻게 보일지 알 수 없으므로
 * 같은 방식들을 여기서도 그대로 낸다.
 *
 *   normal  위가 아래를 가린다
 *   screen  밝은 쪽이 남는다 — 빛·번개·불꽃을 겹칠 때
 *   add     빛을 더한다. 겹칠수록 하얗게 탄다
 *
 * dx·dy 는 얹는 자리. 캔버스 밖으로 나간 부분은 버린다.
 */
export function compositeInto(dst, src, w, h, dx = 0, dy = 0, blend = 'normal', opacity = 1) {
  const ox = Math.round(dx), oy = Math.round(dy);
  for (let y = 0; y < h; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < w; x++) {
      const tx = x + ox;
      if (tx < 0 || tx >= w) continue;
      const s = (y * w + x) * 4, d = (ty * w + tx) * 4;
      const a = (src[s + 3] / 255) * opacity;
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const sv = src[s + c], dv = dst[d + c];
        let v;
        if (blend === 'screen') v = 255 - ((255 - dv) * (255 - sv)) / 255;
        else if (blend === 'add') v = Math.min(255, dv + sv);
        else v = sv;
        dst[d + c] = Math.round(dv + (v - dv) * a);
      }
      // 알파는 어느 방식이든 쌓인다 — 겹친 자리가 비어 보이면 안 된다
      dst[d + 3] = Math.round(255 - (255 - dst[d + 3]) * (1 - a));
    }
  }
}

/** 낱장에 실제로 쓰인 색을 많이 쓰인 순서로. 픽셀아트라 색이 몇 개 안 된다. */
export function paletteOf(px, w, h, max = 48) {
  const freq = new Map();
  for (let i = 0; i < w * h * 4; i += 4) {
    if (px[i + 3] < 40) continue;
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, max)
    .map(([k, n]) => ({ hex: '#' + k.toString(16).padStart(6, '0'), n }));
}

/** 지우기만 하던 옛 이름. mix_frames 의 글자 목록이 아직 이 모양을 쓴다. */
export const rubOut = applyEdits;

/** 알파가 있는 픽셀 비율. 낱장이 비었는지 판단하는 데 쓴다. */
export function fillRatio(px, w, h, alpha = 40) {
  let n = 0;
  for (let i = 0; i < w * h; i++) if (px[i * 4 + 3] > alpha) n++;
  return n / (w * h);
}

/**
 * 한 종·한 종류의 **재료** 파일들.
 *
 * `-fx.gif` 는 게임이 읽는 **결과물**이라 저장할 때마다 덮어써진다. 그걸 재료로도 쓰면
 * 4장짜리로 저장하는 순간 7장이던 재료가 4장이 되고, 버린 3장은 되찾을 수 없다.
 * 그래서 처음 저장하기 전에 원본을 `bakes/{kind}-orig.gif` 로 떠 두고, 재료는 거기서 읽는다.
 */
export function origPath(fxRoot, dir, kind) {
  return join(fxRoot, dir, 'bakes', `${kind}-orig.gif`);
}

/**
 * 구운 것은 **하나도 안 버린다.** 마음에 안 들어 다시 구운 판에도 쓸 만한 낱장이
 * 한두 장은 있고, 나중에 그것들을 섞게 된다. 예전에는 옛 파일이 `_prev/` 로 밀려났는데
 * 그 폴더는 편집기가 읽지도 않고, 칸이 하나뿐이라 두 번 다시 구우면 첫 판이 사라졌다.
 * 이제 굽기 기록은 전부 여기 쌓이고, 편집기 목록에 그대로 줄로 뜬다.
 */
export function bakePath(fxRoot, dir, kind, n) {
  return join(fxRoot, dir, 'bakes', `${kind}-v${n}.gif`);
}

/** 아직 안 쓴 다음 칸. 이미 있는 번호는 절대 건드리지 않는다. */
export function nextBakeSlot(fxRoot, dir, kind) {
  let n = 1;
  while (existsSync(bakePath(fxRoot, dir, kind, n))) n++;
  return { n, path: bakePath(fxRoot, dir, kind, n) };
}

/**
 * 편집기에서 저장할 때마다 나가는 판을 남기는 자리.
 * 구운 판(v)과 섞어 만든 판(save)은 성격이 달라 이름을 나눈다 — 목록에서도
 * 「굽기 3회차」와 「저장본 2회차」로 갈려 보여야 뭘 꺼내는지 안다.
 */
export function savePath(fxRoot, dir, kind, n) {
  return join(fxRoot, dir, 'bakes', `${kind}-save${n}.gif`);
}

export function nextSaveSlot(fxRoot, dir, kind) {
  let n = 1;
  while (existsSync(savePath(fxRoot, dir, kind, n))) n++;
  return { n, path: savePath(fxRoot, dir, kind, n) };
}

/**
 * 폴더를 한 번만 읽고 이름으로 판단한다.
 *
 * 이름을 하나씩 짚어 「있냐」 고 묻는 방식이었는데, 굽기 기록이 늘면 그 질문도
 * 같이 늘어난다. 62개 항목이면 파일 확인이 수천 번이 되고, 이 디스크에서는
 * 그게 목록이 느려지는 진짜 이유였다(gif 를 푸는 값은 그 10분의 1이다).
 */
function listDir(p) {
  try { return readdirSync(p); } catch { return []; }
}

export function sourcesFor(fxRoot, dir, kind) {
  const out = [];
  const here = new Set(listDir(join(fxRoot, dir)));
  const inBakes = new Set(listDir(join(fxRoot, dir, 'bakes')));

  const origName = `${kind}-orig.gif`;
  const liveName = `${dir}-${kind}-fx.gif`;
  const hasOrig = inBakes.has(origName);
  const hasLive = here.has(liveName);

  // 'old' 는 이미 저장된 조리법들이 가리키는 이름이라 뜻을 바꾸면 안 된다.
  if (hasOrig) out.push({ id: 'old', label: '원본', path: origPath(fxRoot, dir, kind) });
  else if (hasLive) out.push({ id: 'old', label: '지금 쓰는 것', path: join(fxRoot, dir, liveName) });

  // 굽기 기록. 번호가 클수록 최근이다. 'attack' 은 'attacked-v1.gif' 와 안 겹친다
  // — 종류 뒤에 바로 '-v' 가 와야 하기 때문이다.
  const re = new RegExp('^' + kind + '-v(\\d+)\\.gif$');
  [...inBakes].map(f => re.exec(f)).filter(Boolean)
    .map(m => +m[1]).sort((a, b) => a - b)
    .forEach(n => out.push({ id: 'b' + n, label: `굽기 ${n}회차`, path: bakePath(fxRoot, dir, kind, n) }));

  // 편집기에서 섞어 만들어 저장했던 판들.
  const reSave = new RegExp('^' + kind + '-save(\\d+)\\.gif$');
  [...inBakes].map(f => reSave.exec(f)).filter(Boolean)
    .map(m => +m[1]).sort((a, b) => a - b)
    .forEach(n => out.push({ id: 's' + n, label: `저장본 ${n}회차`, path: savePath(fxRoot, dir, kind, n) }));

  // 'old' 가 원본을 가리키고 있으면 지금 쓰는 파일이 목록에서 빠진다.
  // 다시 굽고 나면 그게 제일 최근 판이라 반드시 보여야 한다.
  if (hasOrig && hasLive) out.push({ id: 'live', label: '지금 쓰는 것', path: join(fxRoot, dir, liveName) });

  // 예전에 --keep 으로 옆에 쌓아 둔 것들. 옛 조리법이 이 이름을 쓴다.
  for (let v = 2; v <= 9; v++) {
    const f = `${dir}-${kind}-fx-v${v}.gif`;
    if (here.has(f)) out.push({ id: v === 2 ? 'new' : 'v' + v, label: `다시 구운 것 v${v}`, path: join(fxRoot, dir, f) });
  }
  return out;
}

/**
 * 크기와 장수만 본다. 픽셀은 안 푼다.
 *
 * 목록 화면은 62개 항목 × 재료 여러 줄을 훑는데, 장수를 세겠다고 gif 를 통째로
 * 풀면 굽기 기록이 쌓일수록 목록이 계속 느려진다. 머리글만 읽으면 그럴 일이 없다.
 */
export function probeGif(path) {
  const r = new GifReader(readFileSync(path));
  return { w: r.width, h: r.height, n: r.numFrames() };
}

/** skillFX 폴더를 훑어 편집할 수 있는 항목을 모은다. */
export function listItems(fxRoot) {
  const items = [];
  for (const dir of readdirSync(fxRoot)) {
    const p = join(fxRoot, dir);
    if (!statSync(p).isDirectory()) continue;
    for (const kind of ['attack', 'attacked']) {
      const srcs = sourcesFor(fxRoot, dir, kind);
      if (!srcs.length) continue;
      const head = probeGif(srcs[0].path);
      items.push({
        id: `${dir} ${kind}`, dir, kind,
        canvas: `${head.w}×${head.h}`, w: head.w, h: head.h,
        sources: srcs.map(s => ({ id: s.id, label: s.label, frames: probeGif(s.path).n })),
      });
    }
  }
  items.sort((a, b) => parseInt(a.dir, 10) - parseInt(b.dir, 10) || a.kind.localeCompare(b.kind));
  return items;
}
