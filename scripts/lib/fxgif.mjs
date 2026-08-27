/**
 * scripts/lib/fxgif.mjs — gif 낱장을 읽고, 지우고, 다시 굽는 공용 부분.
 *
 * mix_frames.mjs(명령줄)와 fx-studio.mjs(편집기)가 같은 코드를 쓴다.
 * 복사해 두면 한쪽만 고쳐져 조용히 갈라진다.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { GifReader, GifWriter } from 'omggif';
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
/**
 * 색을 하나도 안 바꾸고 저장한다 — 쓰인 색이 255가지 이하일 때(픽셀아트는 거의 늘 그렇다).
 *
 * 왜 필요한가: gif-encoder-2 의 'neuquant' 는 **색을 새로 고른다.** 2026-08-25 실측으로
 * 캐릭터 픽셀의 59.5% 만 원본 색으로 남고 나머지가 조금씩 밀렸다(품질을 최고로 올려도 같다).
 * 'octree' 로 바꿔 보니 색은 100% 지켜지는데 **투명이 통째로 죽었다**(투명 86%→0.1%,
 * 배경이 마젠타로 굳음). 그래서 둘 다 안 쓰고, 쓰인 색을 그대로 팔레트에 담아 쓴다.
 *
 * 256색을 넘으면 null 을 주고, 부르는 쪽이 예전 방식으로 떨어진다.
 */
function exactGif(w, h, frames, per, delayMs) {
  const idx = new Map();                 // 'r,g,b' → 팔레트 자리
  const pal = [0xFF00FF];                // 0번은 투명 자리
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 4) {
      if (f[i + 3] < 128) continue;
      const k = (f[i] << 16) | (f[i + 1] << 8) | f[i + 2];
      if (!idx.has(k)) { idx.set(k, pal.length); pal.push(k); if (pal.length > 256) return null; }
    }
  }
  let size = 2; while (size < pal.length) size *= 2;      // gif 팔레트는 2의 제곱만 된다
  while (pal.length < size) pal.push(0);

  const buf = Buffer.alloc(w * h * frames.length + 4096 + size * 3);
  const gw = new GifWriter(buf, w, h, { loop: 0, palette: pal });
  const px = new Uint8Array(w * h);
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    for (let p = 0, i = 0; p < px.length; p++, i += 4) {
      px[p] = f[i + 3] < 128 ? 0 : idx.get((f[i] << 16) | (f[i + 1] << 8) | f[i + 2]);
    }
    const d = per ? (per[k] ?? per[per.length - 1]) : delayMs;
    gw.addFrame(0, 0, w, h, px, { delay: Math.round(d / 10), transparent: 0, disposal: 2 });
  }
  return Buffer.from(buf.slice(0, gw.end()));
}

export function encodeGif(w, h, frames, delayMs) {
  const per = Array.isArray(delayMs) ? delayMs : null;
  const exact = exactGif(w, h, frames, per, delayMs);
  if (exact) return exact;
  // 256색이 넘는 그림 — 예전 방식으로 떨어진다(색이 조금 밀린다).
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
 *   { t:'blit', sx,sy,sw,sh, dx,dy,dw,dh, rot,fx,fy,cut }  이 그림 안의 조각을 옮기기
 *   { t:'stamp', sw,sh,data, dx,dy,dw,dh, rot,fx,fy }      다른 낱장에서 온 조각 붙이기
 *   { t:'em', x,y,w,h, mask }            표대로 비우기(올가미·마술봉)
 *   { t:'pm', x,y,w,h, mask, color }     표대로 칠하기(직선·네모·타원)
 *   { t:'sh', x,y,w,h, steps, dir, ramp } 명암 — 쓰던 색들 사이를 한 눈금씩
 *   { t:'stamps', sw,sh,data, at:[[x,y],..] } 고른 조각을 붓으로 툭툭
 *   { t:'adj', x,y,w,h, mask, hue,sat,val,con }  색 손보기
 *   { t:'shift', dx,dy }                 그림 전체 밀기
 */
/**
 * 색 손보기 한 판. 편집기와 굽는 쪽이 **글자 그대로 같은 셈** 이어야 하므로
 * 두 파일에 같은 함수를 둔다(scripts/test-strokes.mjs 가 매번 둘을 맞대 본다).
 *   hue -180~180 도 돌리기 · sat/val 0~200 % · con -100~100 대비
 * 차례: 색조·진하기·밝기 를 먼저, 대비를 마지막에. 투명한 점은 안 건드린다.
 */
function adjPixels(px,w,h,s){
  const X0=Math.max(0,Math.floor(s.x??0)),Y0=Math.max(0,Math.floor(s.y??0));
  const X1=Math.min(w,Math.ceil((s.x??0)+(s.w??w))),Y1=Math.min(h,Math.ceil((s.y??0)+(s.h??h)));
  const m=s.mask?new Uint8Array(Buffer.from(String(s.mask||''),'base64')):null;
  const mw=s.w??w;
  if(m&&m.length<(s.w??w)*(s.h??h))return;
  const hue=(s.hue||0),sat=(s.sat===undefined?100:s.sat)/100,val=(s.val===undefined?100:s.val)/100;
  const con=s.con||0,k=(259*(con+255))/(255*(259-con));
  for(let y=Y0;y<Y1;y++)for(let x=X0;x<X1;x++){
    if(m&&!m[(y-Y0)*mw+(x-X0)])continue;
    const i=(y*w+x)*4;
    if(px[i+3]===0)continue;
    let r=px[i]/255,g=px[i+1]/255,b=px[i+2]/255;
    if(hue||sat!==1||val!==1){
      const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;
      let H=0;
      if(d){
        if(mx===r)H=((g-b)/d+(g<b?6:0));
        else if(mx===g)H=(b-r)/d+2;
        else H=(r-g)/d+4;
        H*=60;
      }
      let S=mx?d/mx:0,V=mx;
      H=(H+hue)%360; if(H<0)H+=360;
      S=Math.max(0,Math.min(1,S*sat));
      V=Math.max(0,Math.min(1,V*val));
      const c2=V*S,xx=c2*(1-Math.abs((H/60)%2-1)),m2=V-c2;
      const t=Math.floor(H/60)%6;
      const rgb=[[c2,xx,0],[xx,c2,0],[0,c2,xx],[0,xx,c2],[xx,0,c2],[c2,0,xx]][t];
      r=rgb[0]+m2;g=rgb[1]+m2;b=rgb[2]+m2;
    }
    let R=r*255,G=g*255,B=b*255;
    if(con){R=(R-128)*k+128;G=(G-128)*k+128;B=(B-128)*k+128}
    px[i]=Math.max(0,Math.min(255,Math.round(R)));
    px[i+1]=Math.max(0,Math.min(255,Math.round(G)));
    px[i+2]=Math.max(0,Math.min(255,Math.round(B)));
  }
}

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
    } else if (st.t === 'adj') {
      // 색 손보기 — 편집기와 «글자 그대로 같은» 함수를 쓴다.
      adjPixels(px, w, h, st);
    } else if (st.t === 'stamps') {
      // 고른 조각을 «붓» 으로 — 알갱이 꾸러미 하나를 여러 자리에 툭툭 찍는다.
      const buf = new Uint8Array(Buffer.from(String(st.data || ''), 'base64'));
      const sw = Math.max(1, st.sw | 0), sh = Math.max(1, st.sh | 0);
      if (buf.length < sw * sh * 4) continue;
      for (const at of (st.at || [])) {
        const dx = Math.round(at[0]), dy = Math.round(at[1]);
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
          const b = (y * sw + x) * 4; if (buf[b + 3] === 0) continue;
          const gx = dx + x, gy = dy + y;
          if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
          const a = (gy * w + gx) * 4;
          px[a] = buf[b]; px[a + 1] = buf[b + 1]; px[a + 2] = buf[b + 2]; px[a + 3] = buf[b + 3];
        }
      }
    } else if (st.t === 'sh') {
      // 명암 — 그 낱장이 쓰던 색들(ramp) 사이를 한 눈금씩 오간다. 색 수가 안 늘어난다.
      // steps 는 점마다 몇 눈금 옮길지, dir 은 +1 밝게 / -1 어둡게. 편집기와 같은 셈이다.
      const sm = new Uint8Array(Buffer.from(String(st.steps || ''), 'base64'));
      const ramp = st.ramp || [];
      if (!ramp.length || sm.length < st.w * st.h) continue;
      const dir = st.dir < 0 ? -1 : 1;
      for (let y = 0; y < st.h; y++) for (let x = 0; x < st.w; x++) {
        const n = sm[y * st.w + x]; if (!n) continue;
        const gx = st.x + x, gy = st.y + y;
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        const i = (gy * w + gx) * 4; if (px[i + 3] === 0) continue;
        let best = 0, bd = 1e9;
        for (let k = 0; k < ramp.length; k++) {
          const a = px[i] - ramp[k][0], b = px[i + 1] - ramp[k][1], g = px[i + 2] - ramp[k][2];
          const dd = a * a + b * b + g * g; if (dd < bd) { bd = dd; best = k; }
        }
        const j = Math.max(0, Math.min(ramp.length - 1, best + dir * n));
        px[i] = ramp[j][0]; px[i + 1] = ramp[j][1]; px[i + 2] = ramp[j][2];
      }
    } else if (st.t === 'pm') {
      // 표대로 칠하기 — 직선·네모·타원이 전부 이 하나로 구워진다.
      // mask 는 한 점에 한 자(1이면 칠함)를 base64 로 적은 것. w×h 만큼 담긴다.
      const m = new Uint8Array(Buffer.from(String(st.mask || ''), 'base64'));
      if (m.length < st.w * st.h) continue;
      const [cr, cg, cb] = st.color || [255, 255, 255];
      for (let y = 0; y < st.h; y++) for (let x = 0; x < st.w; x++) {
        if (!m[y * st.w + x]) continue;
        const gx = st.x + x, gy = st.y + y;
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        const i = (gy * w + gx) * 4;
        px[i] = cr; px[i + 1] = cg; px[i + 2] = cb; px[i + 3] = 255;
      }
    } else if (st.t === 'em') {
      // 표대로 비우기 — 올가미·마술봉으로 고른 «네모 아닌» 자리를 지운다.
      // mask 는 한 점에 한 자(1이면 지움)를 base64 로 적은 것. w×h 만큼 담긴다.
      const m = new Uint8Array(Buffer.from(String(st.mask || ''), 'base64'));
      if (m.length < st.w * st.h) continue;
      for (let y = 0; y < st.h; y++) for (let x = 0; x < st.w; x++) {
        if (!m[y * st.w + x]) continue;
        const gx = st.x + x, gy = st.y + y;
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        px[(gy * w + gx) * 4 + 3] = 0;
      }
    } else if (st.t === 'c') {
      circle(st, i => { px[i + 3] = 0; });
    } else if (st.t === 'p') {
      const [r, g, b] = st.color || [255, 255, 255];
      // 무늬(dith)가 켜져 있으면 «한 점 걸러» 만 칠한다 — 편집기와 같은 셈이다.
      circle(st, i => {
        if (st.dith) { const q = i / 4; if (((q % w) + ((q / w) | 0)) % 2 !== 0) return; }
        px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
      });
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
        // 무늬(dith)면 «한 점 걸러» 만 칠한다 — 번지는 범위는 그대로다(편집기와 같은 셈).
        if (!st.dith || ((p % w) + ((p / w) | 0)) % 2 === 0) { px[i] = tr; px[i + 1] = tg; px[i + 2] = tb; px[i + 3] = 255; }
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x < w - 1 && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
        if (y < h - 1 && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
      }
    } else if (st.t === 'blit' || st.t === 'stamp') {
      // 고른 사각형을 떠서 돌리고·크기를 바꿔 다른 자리에 놓는다.
      //   sx,sy,sw,sh  떠 올 자리        dx,dy,dw,dh  놓을 자리(크기까지)
      //   rot 0/90/180/270 (시계 방향)   fx,fy 좌우·위아래 뒤집기   cut 1이면 떠 온 자리는 비운다
      // 픽셀아트라 «가장 가까운 점» 으로만 늘린다(부드럽게 섞으면 도트가 뭉갠다).
      // 투명한 점은 안 그린다 — 붙인 조각이 바탕을 지우면 안 되기 때문이다.
      //
      // stamp 는 «다른 낱장에서 온 조각» 이다. 이 낱장엔 원본이 없으니 알갱이(data)를
      // 지고 다닌다 — 점 하나에 RGBA 넉 자를 통째로 base64 로 적은 것, sw×sh 크기.
      // 편집기(fx-studio)와 여기가 **같은 셈** 이어야 화면과 gif 가 안 갈린다.
      const sx = Math.round(st.sx || 0), sy = Math.round(st.sy || 0);
      const sw = Math.max(1, Math.round(st.sw)), sh = Math.max(1, Math.round(st.sh));
      const dw = Math.max(1, Math.round(st.dw ?? sw)), dh = Math.max(1, Math.round(st.dh ?? sh));
      const dx = Math.round(st.dx), dy = Math.round(st.dy);
      const rot = ((Math.round((st.rot || 0) / 90) * 90) % 360 + 360) % 360;

      let cut;
      if (st.t === 'stamp') {
        cut = new Uint8Array(Buffer.from(String(st.data || ''), 'base64'));
        if (cut.length < sw * sh * 4) continue;   // 담긴 알갱이가 모자라면 손대지 않는다
      } else {
        cut = new Uint8Array(sw * sh * 4);
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
          const gx = sx + x, gy = sy + y;
          if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
          const a = (gy * w + gx) * 4, b = (y * sw + x) * 4;
          cut[b] = px[a]; cut[b + 1] = px[a + 1]; cut[b + 2] = px[a + 2]; cut[b + 3] = px[a + 3];
        }
        if (st.cut) {
          for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
            const gx = sx + x, gy = sy + y;
            if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
            px[(gy * w + gx) * 4 + 3] = 0;
          }
        }
      }
      const rw = (rot === 90 || rot === 270) ? sh : sw;
      const rh = (rot === 90 || rot === 270) ? sw : sh;
      for (let oy = 0; oy < dh; oy++) for (let ox = 0; ox < dw; ox++) {
        const rx = Math.min(rw - 1, Math.floor(ox * rw / dw));
        const ry = Math.min(rh - 1, Math.floor(oy * rh / dh));
        let u, v;
        if (rot === 0) { u = rx; v = ry; }
        else if (rot === 90) { u = ry; v = rh - 1 - rx; }
        else if (rot === 180) { u = rw - 1 - rx; v = rh - 1 - ry; }
        else { u = rw - 1 - ry; v = rx; }
        if (st.fx) u = sw - 1 - u;
        if (st.fy) v = sh - 1 - v;
        if (u < 0 || v < 0 || u >= sw || v >= sh) continue;
        const b = (v * sw + u) * 4;
        if (cut[b + 3] === 0) continue;
        const gx = dx + ox, gy = dy + oy;
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        const a = (gy * w + gx) * 4;
        px[a] = cut[b]; px[a + 1] = cut[b + 1]; px[a + 2] = cut[b + 2]; px[a + 3] = cut[b + 3];
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
/**
 * 조리법 한 벌을 낱장 알갱이로 굽는다 (gif 로 만들기 «직전» 까지).
 *
 * 한 칸은 바닥 낱장 하나와 그 위에 얹은 층들(over)로 이뤄진다.
 * 층의 바닥으로 **'blank'** 를 쓰면 «투명한 빈 낱장» 이 된다 — 그러면 그 층은
 * 「빈 바닥 + 손질 줄」 이 되어, 아무 그림이나 그려 넣는 층이 손질 엔진만으로 굳는다.
 * 굽는 셈을 새로 넣을 필요가 없고, over 항목이 하나 느는 것뿐이라 옛 저장본도 그대로 읽힌다.
 *
 *   get(dir, kind, srcId) → { w, h, frames:[알갱이...] } · 없으면 null
 *
 * 서버가 아니라 여기 두는 이유: 편집기 대본은 부르는 순간 서버가 뜨므로 검사에서 못 쓴다.
 */
export function composeSeq({ dir, kind, seq }, get) {
  if (!dir || !kind || !Array.isArray(seq) || !seq.length) throw new Error('빈 조리법입니다');
  let w = 0, h = 0;
  const frameOf = (d, k, srcId, i, what) => {
    if (srcId === 'blank') {
      // 빈 층은 «위에 얹는 것» 이라 크기를 스스로 못 정한다. 바닥이 먼저 서 있어야 한다.
      if (!w) throw new Error('빈 층이 맨 아래에 있습니다 — 바닥 낱장이 먼저 있어야 합니다');
      return new Uint8Array(w * h * 4);
    }
    const got = get(d, k, srcId);
    if (!got || !got.frames[i]) throw new Error(`${what} 낱장을 못 찾았습니다 (${d} ${k} ${srcId}·${i})`);
    if (!w) { w = got.w; h = got.h; }
    if (got.w !== w || got.h !== h)
      throw new Error(`캔버스 크기가 다릅니다 — ${d} ${k} 는 ${got.w}×${got.h}, 이 종은 ${w}×${h}`);
    return got.frames[i];
  };
  const picked = [];
  for (const step of seq) {
    const px = new Uint8Array(frameOf(dir, kind, step.src, step.i, '바닥'));
    if (step.erase && step.erase.length) applyEdits(px, w, h, step.erase);
    for (const L of step.over || []) {
      if (L.off) continue;                       // 눈을 끈 층은 굽기에서 뺀다
      const lay = new Uint8Array(frameOf(L.dir || dir, L.kind || kind, L.src, L.i, '얹은 층'));
      if (L.erase && L.erase.length) applyEdits(lay, w, h, L.erase);
      compositeInto(px, lay, w, h, L.dx || 0, L.dy || 0, L.blend || 'normal',
        L.op === undefined ? 1 : L.op);
    }
    picked.push(px);
  }
  return { w, h, picked };
}

export function compositeInto(dst, src, w, h, dx = 0, dy = 0, blend = 'normal', opacity = 1) {
  const ox = Math.round(dx), oy = Math.round(dy);
  for (let y = 0; y < h; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < w; x++) {
      const tx = x + ox;
      if (tx < 0 || tx >= w) continue;
      const s = (y * w + x) * 4, d = (ty * w + tx) * 4;
      const as = (src[s + 3] / 255) * opacity;
      if (as <= 0) continue;
      const ab = dst[d + 3] / 255;

      // 화면(캔버스)이 쓰는 셈 그대로 한다. 색만 섞고 알파를 대충 다루면
      // **투명한 자리 위에 반투명 층**에서 크게 어긋난다 — 검정과 섞이며
      // 어두워져서, 편집기에서 고른 것과 게임에 나가는 것이 달라진다(실측 119 차이).
      let ao, inv;
      if (blend === 'add') {
        // 'add' 는 섞는 방식이 아니라 겹치는 방식이다(캔버스의 lighter). 식이 다르다.
        ao = Math.min(1, as + ab);
        if (ao <= 0) continue;
        for (let c = 0; c < 3; c++) {
          const co = as * (src[s + c] / 255) + ab * (dst[d + c] / 255);
          dst[d + c] = Math.max(0, Math.min(255, Math.round((co / ao) * 255)));
        }
      } else {
        ao = as + ab * (1 - as);
        if (ao <= 0) continue;
        inv = 1 / ao;
        for (let c = 0; c < 3; c++) {
          const Cs = src[s + c] / 255, Cb = dst[d + c] / 255;
          const B = blend === 'screen' ? (Cs + Cb - Cs * Cb) : Cs;
          const co = as * (1 - ab) * Cs + as * ab * B + (1 - as) * ab * Cb;
          dst[d + c] = Math.max(0, Math.min(255, Math.round(co * inv * 255)));
        }
      }
      dst[d + 3] = Math.round(ao * 255);
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
 * 그림이 실제로 있는 네모. 256칸 한가운데 점만 있는 이펙트를
 * 칸 전체에 맞추면 캐릭터가 점으로 보이므로, 편집기·미리보기가 여기로 맞춘다.
 */
export function contentBox(px, w, h, alpha = 40) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > alpha) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w, h };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
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
    for (const kind of ['attack', 'attacked', 'hit']) {
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
