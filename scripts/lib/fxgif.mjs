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

/** delay 는 ms. gif는 10ms 단위로만 저장하니 그 단위로 맞춰 들어와야 한다. */
export function encodeGif(w, h, frames, delayMs) {
  const enc = new GifEncoder(w, h, 'neuquant', true, frames.length);
  enc.setDelay(delayMs);
  enc.setRepeat(0);
  enc.setTransparent(MAGENTA);
  enc.start();
  for (const src of frames) {
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

/** 한 종·한 종류가 가진 재료 파일들. -fx.gif(지금 쓰는 것)와 -fx-v2/-v3…(다시 구운 것). */
export function sourcesFor(fxRoot, dir, kind) {
  const out = [];
    const base = join(fxRoot, dir, `${dir}-${kind}-fx.gif`);
  if (existsSync(base)) out.push({ id: 'old', label: '지금 쓰는 것', path: base });
  for (let v = 2; v <= 9; v++) {
    const p = join(fxRoot, dir, `${dir}-${kind}-fx-v${v}.gif`);
    if (existsSync(p)) out.push({ id: v === 2 ? 'new' : 'v' + v, label: `다시 구운 것 v${v}`, path: p });
  }
  return out;
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
      const head = readFrames(srcs[0].path);
      items.push({
        id: `${dir} ${kind}`, dir, kind,
        canvas: `${head.w}×${head.h}`, w: head.w, h: head.h,
        sources: srcs.map(s => ({ id: s.id, label: s.label, frames: readFrames(s.path).frames.length })),
      });
    }
  }
  items.sort((a, b) => parseInt(a.dir, 10) - parseInt(b.dir, 10) || a.kind.localeCompare(b.kind));
  return items;
}
