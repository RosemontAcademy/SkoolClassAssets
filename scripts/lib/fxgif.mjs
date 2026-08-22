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

/** 지운 자국을 실제로 없앤다. 동그라미는 거리 제곱으로 재서 화면의 지우개와 모양이 같다. */
export function rubOut(px, w, h, strokes) {
  for (const st of strokes || []) {
    if (st.t === 'r') {
      const x0 = Math.max(0, Math.floor(st.x)), y0 = Math.max(0, Math.floor(st.y));
      const x1 = Math.min(w, Math.ceil(st.x + st.w)), y1 = Math.min(h, Math.ceil(st.y + st.h));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[(y * w + x) * 4 + 3] = 0;
    } else {
      const rr = st.r * st.r;
      const x0 = Math.max(0, Math.floor(st.x - st.r)), y0 = Math.max(0, Math.floor(st.y - st.r));
      const x1 = Math.min(w, Math.ceil(st.x + st.r)), y1 = Math.min(h, Math.ceil(st.y + st.r));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - st.x, dy = y + 0.5 - st.y;
        if (dx * dx + dy * dy <= rr) px[(y * w + x) * 4 + 3] = 0;
      }
    }
  }
}

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
