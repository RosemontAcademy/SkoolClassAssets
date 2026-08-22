#!/usr/bin/env node
/**
 * scripts/fx-studio.mjs — 공격 연출 편집기 (원장님 PC에서 도는 도구)
 *
 *   node scripts/fx-studio.mjs          → http://localhost:4321 열기
 *   node scripts/fx-studio.mjs --port 5000
 *
 * 하는 일: skillFX 폴더를 훑어 낱장으로 펼치고, 골라 담고, 섞고, 지우고,
 * 저장하면 gif 를 그 자리에서 만들어 제자리에 넣는다. 목록을 복사해 넘길 필요가 없다.
 *
 * 왜 웹앱이 아니라 이 형태인가:
 *  - 파일을 직접 읽고 쓴다. gif 를 base64 로 박아 6MB 짜리 화면을 만들 필요가 없다.
 *  - 쓰는 사람이 한 명이라 로그인·권한·업로드가 전부 필요 없다.
 *  - 자산이 GitHub 저장소에 살아서 웹앱은 어차피 못 쓴다.
 *
 * 저장하면:
 *  - 옛 파일은 _prev/ 로 복사
 *  - 결과물은 게임이 읽는 이름 그대로 덮어씀
 *  - 조리법을 recipe.{종류}.json 으로 같이 남김 (같은 결과를 언제든 다시 만들 수 있게)
 *  - jsDelivr purge 주소를 찍어줌 (덮어쓰면 최대 12시간 옛 파일이 나간다)
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { PNG } from 'pngjs';
import { readFrames, encodeGif, applyEdits, fillRatio, paletteOf, listItems, sourcesFor } from './lib/fxgif.mjs';

// 경로는 전부 이 파일 위치 기준이다. 이동식 SSD라 드라이브 문자가 바뀌고,
// 어느 폴더에서 실행하든 같게 동작해야 한다.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FXD = join(__dirname, '..', 'skillFX');
const args = process.argv.slice(2);
const WANT_PORT = args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1], 10) : 4321;
const OPEN = args.includes('--open');
const REPO = 'RosemontAcademy/SkoolClassAssets';

if (!existsSync(FXD)) {
  console.error('');
  console.error('  skillFX 폴더를 못 찾았습니다: ' + FXD);
  console.error('  이 파일이 SkoolClassAssets/scripts/ 안에 있어야 합니다.');
  console.error('');
  process.exit(1);
}

// ── 낱장 캐시 (한 번 뽑으면 들고 있는다) ─────────────────────────────────────
const cache = new Map();
function framesOf(dir, kind, srcId) {
  const key = `${dir}|${kind}|${srcId}`;
  if (cache.has(key)) return cache.get(key);
  const src = sourcesFor(FXD, dir, kind).find(s => s.id === srcId);
  if (!src) return null;
  const got = readFrames(src.path);
  cache.set(key, got);
  return got;
}

function framePng(dir, kind, srcId, i) {
  const got = framesOf(dir, kind, srcId);
  if (!got || !got.frames[i]) return null;
  const png = new PNG({ width: got.w, height: got.h });
  png.data.set(got.frames[i]);
  return PNG.sync.write(png);
}

// ── 저장 ─────────────────────────────────────────────────────────────────────
function save(body) {
  const { dir, kind, seq, fitMs, delayMs } = body;
  if (!dir || !kind || !Array.isArray(seq) || !seq.length) throw new Error('빈 조리법입니다');

  const picked = [];
  let w = 0, h = 0;
  for (const step of seq) {
    const got = framesOf(dir, kind, step.src);
    if (!got || !got.frames[step.i]) throw new Error(`${step.src}${step.i} 낱장을 못 찾았습니다`);
    if (!w) { w = got.w; h = got.h; }
    if (got.w !== w || got.h !== h) throw new Error('캔버스 크기가 서로 다른 낱장은 못 섞습니다');
    const px = new Uint8Array(got.frames[step.i]);
    if (step.erase && step.erase.length) applyEdits(px, w, h, step.erase);
    picked.push(px);
  }

  const per = fitMs ? Math.max(20, Math.round(fitMs / picked.length / 10) * 10)
    : (delayMs || framesOf(dir, kind, seq[0].src).delay);
  const buf = encodeGif(w, h, picked, per);

  const target = join(FXD, dir, `${dir}-${kind}-fx.gif`);
  if (existsSync(target)) {
    const prev = join(FXD, dir, '_prev');
    mkdirSync(prev, { recursive: true });
    copyFileSync(target, join(prev, `${dir}-${kind}-fx.gif`));
  }
  writeFileSync(target, buf);

  // 조리법도 같이 남긴다 — 같은 결과를 언제든 다시 만들 수 있게
  const recipe = { species: dir, kind, canvas: `${w}x${h}`, delay_ms: per, frames: picked.length, steps: seq, saved_at: new Date().toISOString() };
  writeFileSync(join(FXD, dir, `recipe.${kind}.json`), JSON.stringify(recipe, null, 2));

  cache.delete(`${dir}|${kind}|old`);
  const rel = `skillFX/${dir}/${dir}-${kind}-fx.gif`;
  return {
    ok: true, frames: picked.length, delay_ms: per, loop_ms: per * picked.length,
    file: rel,
    purge: `https://purge.jsdelivr.net/gh/${REPO}@main/${rel}`,
  };
}

// ── 서버 ─────────────────────────────────────────────────────────────────────
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);

    if (url.pathname === '/api/items') return json(res, 200, listItems(FXD));

    if (url.pathname === '/api/frames') {
      const dir = url.searchParams.get('dir'), kind = url.searchParams.get('kind'), src = url.searchParams.get('src');
      const got = framesOf(dir, kind, src);
      if (!got) return json(res, 404, { error: '없음' });
      return json(res, 200, {
        w: got.w, h: got.h, delay: got.delay,
        fills: got.frames.map(f => +(fillRatio(f, got.w, got.h) * 100).toFixed(1)),
      });
    }

    if (url.pathname === '/frame.png') {
      const png = framePng(url.searchParams.get('dir'), url.searchParams.get('kind'),
        url.searchParams.get('src'), +url.searchParams.get('i'));
      if (!png) return json(res, 404, { error: '없음' });
      return send(res, 200, 'image/png', png);
    }

    if (url.pathname === '/api/palette') {
      const got = framesOf(url.searchParams.get('dir'), url.searchParams.get('kind'), url.searchParams.get('src'));
      const i = +url.searchParams.get('i');
      if (!got || !got.frames[i]) return json(res, 404, { error: '없음' });
      return json(res, 200, paletteOf(got.frames[i], got.w, got.h));
    }

    if (url.pathname === '/api/recipe') {
      const p = join(FXD, url.searchParams.get('dir'), `recipe.${url.searchParams.get('kind')}.json`);
      return json(res, 200, existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
    }

    if (url.pathname === '/api/save' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        try { json(res, 200, save(JSON.parse(raw))); }
        catch (e) { json(res, 400, { error: e.message }); }
      });
      return;
    }

    json(res, 404, { error: '없는 주소' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// 포트가 이미 쓰이고 있으면 다음 번호로 옮겨 뜬다. "연결 안 됨"의 흔한 원인이 이것이다.
// 배너는 listen 시도마다가 아니라 'listening' 에 한 번만 걸어야 한다 —
// 시도마다 콜백을 넘기면 재시도할 때 옛 콜백이 남아 옛 포트 번호로 두 번 찍힌다.
let tries = 12;
server.on('error', err => {
  if (err.code === 'EADDRINUSE' && tries-- > 0) {
    const next = server.__port + 1;
    console.log('  ' + server.__port + '번은 이미 쓰는 중 — ' + next + '번으로 옮깁니다');
    open(next);
  } else {
    console.error('  서버를 못 열었습니다: ' + err.message);
    process.exit(1);
  }
});
server.on('listening', () => {
  const url = 'http://localhost:' + server.address().port;
  console.log('');
  console.log('  ┌────────────────────────────────────┐');
  console.log('  │   공격 연출 편집기가 열렸습니다     │');
  console.log('  └────────────────────────────────────┘');
  console.log('');
  console.log('     ' + url);
  console.log('');
  console.log('  브라우저가 안 뜨면 위 주소를 직접 열어주세요.');
  console.log('  자산 폴더: ' + FXD);
  console.log('  끝낼 때는 이 창에서 Ctrl+C  (창을 닫으면 편집기도 꺼집니다)');
  console.log('');
  if (OPEN) spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
});
function open(port) { server.__port = port; server.listen(port, '127.0.0.1'); }
open(WANT_PORT);

// ── 화면 ─────────────────────────────────────────────────────────────────────
const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>공격 연출 편집기</title>
<style>
  :root{--ground:#F3F4F6;--surface:#fff;--line:#DEE0E6;--ink:#171821;--muted:#666A78;
    --accent:#3B4CC0;--old:#5B6270;--drop:#A03030;--cell:#22242C;--cell2:#2B2E37}
  @media (prefers-color-scheme:dark){:root{--ground:#101117;--surface:#191B22;--line:#292C36;
    --ink:#E9EAF2;--muted:#969AAA;--accent:#8FA0FF;--old:#98A0B4;--drop:#F08A8A;--cell:#0A0B0F;--cell2:#131520}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.6 "Pretendard","Malgun Gothic","Segoe UI",system-ui,sans-serif;
    display:grid;grid-template-columns:230px 1fr;height:100vh;overflow:hidden}
  .mono{font-family:ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}
  aside{border-right:1px solid var(--line);overflow-y:auto;background:var(--surface)}
  aside h1{margin:0;padding:13px 15px 9px;font-size:15px;font-weight:800;border-bottom:1px solid var(--line)}
  .it{display:flex;gap:7px;align-items:baseline;padding:7px 15px;cursor:pointer;border-bottom:1px solid color-mix(in srgb,var(--line) 45%,transparent)}
  .it:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}
  .it.on{background:color-mix(in srgb,var(--accent) 16%,transparent);font-weight:800}
  .it small{color:var(--muted);font-size:11px;font-family:ui-monospace,Consolas,monospace}
  .it .done{margin-left:auto;color:var(--accent);font-size:11px}
  main{overflow-y:auto;padding:0 18px 40px;display:flex;flex-direction:column;gap:12px}
  .bar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:8;
    background:color-mix(in srgb,var(--ground) 95%,transparent);backdrop-filter:blur(8px);padding:10px 0;border-bottom:1px solid var(--line)}
  button{font:inherit;font-size:13px;font-weight:700;color:var(--ink);background:var(--surface);
    border:1px solid var(--line);border-radius:8px;padding:6px 11px;cursor:pointer}
  button:hover{border-color:var(--accent)}
  button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button:disabled{opacity:.4;cursor:default}
  .lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700}
  .row{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:9px;display:flex;gap:11px;align-items:flex-start}
  .row.seq{border-color:color-mix(in srgb,var(--accent) 40%,transparent);background:color-mix(in srgb,var(--accent) 6%,transparent)}
  .stage{width:calc(96px * var(--z,1));height:calc(96px * var(--z,1));flex:0 0 auto;border-radius:9px;border:1px solid var(--line);display:grid;place-items:center;
    background-color:var(--cell);background-image:linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%),
    linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%);background-size:16px 16px;background-position:0 0,8px 8px}
  .stage img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
  .cap{font-size:11px;color:var(--muted);text-align:center;margin-top:3px}
  .strip{display:flex;gap:6px;overflow-x:auto;flex:1;padding-bottom:4px;min-height:60px}
  .fr,.slot{position:relative;flex:0 0 auto;padding:3px;border-radius:9px;border:2px solid var(--line);background:var(--cell);cursor:pointer}
  .fr img,.slot img{width:calc(66px * var(--z,1));height:calc(66px * var(--z,1));object-fit:contain;image-rendering:pixelated;display:block;border-radius:5px;
    background-image:linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%),
    linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%);background-size:12px 12px;background-position:0 0,6px 6px}
  .fr .m,.slot .m{font-size:9.5px;color:var(--muted);text-align:center;font-family:ui-monospace,Consolas,monospace}
  .fr.blank{border-style:dashed}.fr.blank .m{color:var(--drop);font-weight:800}
  .fr.edited{box-shadow:0 0 0 2px color-mix(in srgb,var(--drop) 60%,transparent) inset}
  .fr.sel{border-color:var(--accent)}
  .fr .add{position:absolute;top:3px;right:3px;padding:0 5px;font-size:11px;line-height:1.5;border-radius:5px;background:color-mix(in srgb,var(--surface) 88%,transparent)}
  .slot{border-color:var(--accent)}.slot.old{border-color:var(--old)}
  .slot.dragging,.fr.dragging{opacity:.4}
  .ops{display:flex;gap:2px;justify-content:center}
  .ops button{padding:0 4px;font-size:11px;line-height:1.5;border-radius:5px}
  .ops .x{color:var(--drop)}
  .mark{flex:0 0 auto;width:4px;align-self:stretch;border-radius:2px;background:var(--accent)}
  body[data-bg=dark] .stage,body[data-bg=dark] .fr img,body[data-bg=dark] .slot img,body[data-bg=dark] .cw{background-image:none;background-color:#0A0B0F}
  body[data-bg=light] .stage,body[data-bg=light] .fr img,body[data-bg=light] .slot img,body[data-bg=light] .cw{background-image:none;background-color:#fff}
  body[data-bg=grey] .stage,body[data-bg=grey] .fr img,body[data-bg=grey] .slot img,body[data-bg=grey] .cw{background-image:none;background-color:#8A8F9A}
  body[data-bg=none] .stage,body[data-bg=none] .fr img,body[data-bg=none] .slot img,body[data-bg=none] .cw{background-image:none;background-color:transparent}

  /* ── 큰 편집기 (프레임을 누르면 아래에 펼쳐진다) ── */
  .ed{background:var(--surface);border:2px solid var(--accent);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:10px}
  .ed h2{margin:0;font-size:14px;font-weight:800;display:flex;align-items:center;gap:8px}
  .ed h2 .mono{font-weight:600;font-size:12px;color:var(--muted)}
  .ed .close{margin-left:auto}
  .edmain{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
  .cw{border-radius:12px;padding:8px;background-color:var(--cell);position:relative;
    background-image:linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%),
    linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%);background-size:16px 16px;background-position:0 0,8px 8px}
  #cv{image-rendering:pixelated;cursor:crosshair;touch-action:none;border-radius:4px;display:block}
  #onion{position:absolute;left:8px;top:8px;pointer-events:none;image-rendering:pixelated;opacity:.28;border-radius:4px}
  #grid{position:absolute;left:8px;top:8px;pointer-events:none;border-radius:4px}
  .tools{display:flex;flex-direction:column;gap:8px;min-width:210px}
  .tgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}
  .tgrid button{padding:7px 4px;font-size:12px}
  .pal{display:flex;flex-wrap:wrap;gap:4px;max-width:230px}
  .sw{width:20px;height:20px;border-radius:5px;border:2px solid var(--line);cursor:pointer;padding:0}
  .sw.on{border-color:var(--accent);transform:scale(1.12)}
  .cur{display:flex;align-items:center;gap:7px;font-size:12px}
  .cur .box{width:26px;height:26px;border-radius:6px;border:1px solid var(--line)}
  .msg{font-size:13px;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--surface)}
  .msg.ok{border-color:color-mix(in srgb,var(--accent) 50%,transparent);color:var(--accent)}
  .msg.err{border-color:color-mix(in srgb,var(--drop) 50%,transparent);color:var(--drop)}
  code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;background:var(--ground);padding:1px 5px;border-radius:4px}
</style></head><body>
<aside><h1>공격 연출</h1><div id="list"></div></aside>
<main>
  <div class="bar" id="bar"><span class="lbl">왼쪽에서 종을 고르세요</span></div>
  <div id="work"></div>
</main>
<script>
const $=s=>document.querySelector(s), el=(t,c)=>{const e=document.createElement(t);if(c)e.className=c;return e};
let items=[],cur=null,meta={},seq=[],edits={},fit=3000,zoom=1,playT=null,openEd=null;
const furl=(src,i)=>'/frame.png?dir='+encodeURIComponent(cur.dir)+'&kind='+cur.kind+'&src='+src+'&i='+i;
const K=(src,i)=>src+i;
const nEdits=(src,i)=>(edits[K(src,i)]||[]).length;

async function boot(){
  items=await (await fetch('/api/items')).json();
  const L=$('#list');
  items.forEach(it=>{const d=el('div','it');d.dataset.id=it.id;
    d.innerHTML='<span>'+it.dir.replace(/^\\d+-/,'')+'</span><small>'+it.kind+'</small>';
    d.onclick=()=>load(it);L.appendChild(d)});
}
async function load(it){
  cur=it;seq=[];edits={};openEd=null;
  document.querySelectorAll('.it').forEach(n=>n.classList.toggle('on',n.dataset.id===it.id));
  meta={};
  for(const s of it.sources) meta[s.id]=await (await fetch('/api/frames?dir='+encodeURIComponent(it.dir)+'&kind='+it.kind+'&src='+s.id)).json();
  const r=await (await fetch('/api/recipe?dir='+encodeURIComponent(it.dir)+'&kind='+it.kind)).json();
  if(r&&r.steps){seq=r.steps.map(s=>({src:s.src,i:s.i}));r.steps.forEach(s=>{if(s.erase&&s.erase.length)edits[K(s.src,s.i)]=s.erase})}
  else seq=meta.old.fills.map((_,i)=>({src:'old',i}));
  render();
}
function render(){
  const b=$('#bar');b.innerHTML='';
  const t=el('span','lbl');t.textContent=cur.dir+' · '+cur.kind+' · '+cur.canvas;b.appendChild(t);
  cur.sources.forEach(s=>{const x=el('button');x.textContent=s.label+' 전부';
    x.onclick=()=>{seq=meta[s.id].fills.map((_,i)=>({src:s.id,i}));render()};b.appendChild(x)});
  const cl=el('button');cl.textContent='비우기';cl.onclick=()=>{seq=[];render()};b.appendChild(cl);
  b.appendChild(gap());
  b.appendChild(lab('배경'));
  [['체커',''],['어두움','dark'],['밝음','light'],['회색','grey'],['없음','none']].forEach(([n,v])=>{
    const x=el('button');x.textContent=n;x.setAttribute('aria-pressed',String((document.body.dataset.bg||'')===v));
    x.onclick=()=>{if(v)document.body.dataset.bg=v;else delete document.body.dataset.bg;render()};b.appendChild(x)});
  b.appendChild(lab('크기'));
  [1,1.5,2].forEach(v=>{const x=el('button');x.textContent=v+'배';x.setAttribute('aria-pressed',String(zoom===v));
    x.onclick=()=>{zoom=v;document.documentElement.style.setProperty('--z',v);render()};b.appendChild(x)});
  b.appendChild(gap());
  b.appendChild(lab('창'));
  [1500,2000,3000].forEach(v=>{const x=el('button');x.textContent=(v/1000)+'초';x.setAttribute('aria-pressed',String(fit===v));
    x.onclick=()=>{fit=v;render()};b.appendChild(x)});
  const sv=el('button','primary');sv.textContent='저장';sv.disabled=!seq.length;sv.onclick=save;b.appendChild(sv);

  const W=$('#work');W.innerHTML='';
  cur.sources.forEach(s=>W.appendChild(strip(s)));
  W.appendChild(seqRow());
  const per=seq.length?Math.max(20,Math.round(fit/seq.length/10)*10):0;
  const info=el('div','msg');
  info.innerHTML=seq.length?seq.length+'장 · 장당 <b>'+per+'ms</b> · 한 바퀴 <b>'+(per*seq.length)+'ms</b> → 창 '+(fit/1000)+'초 안에서 <b>'+(fit/(per*seq.length)).toFixed(2)+'바퀴</b>'
    :'낱장을 눌러 크게 보고, ＋로 담으세요.';
  W.appendChild(info);
  if(openEd) W.appendChild(editor());
  play();
}
const gap=()=>{const s=el('span');s.style.flex='1';return s};
const lab=t=>{const s=el('span','lbl');s.textContent=t;return s};

function strip(s){
  const row=el('div','row');
  const box=el('div');const st=el('div','stage');const im=el('img');st.appendChild(im);box.appendChild(st);
  const c=el('div','cap');c.textContent=s.label+' '+s.frames+'장';box.appendChild(c);row.appendChild(box);
  let k=0;setInterval(()=>{if(!meta[s.id])return;k=(k+1)%s.frames;im.src=furl(s.id,k)},250);
  const sp=el('div','strip');
  for(let i=0;i<s.frames;i++){
    const f=meta[s.id].fills[i],blank=i>0&&f<meta[s.id].fills[0]*0.25;
    const b=el('div','fr'+(blank?' blank':'')+(nEdits(s.id,i)?' edited':'')+(openEd&&openEd.src===s.id&&openEd.i===i?' sel':''));
    b.draggable=true;
    const img=el('img');img.src=furl(s.id,i)+'&t='+nEdits(s.id,i);b.appendChild(img);
    const m=el('div','m');m.textContent=i+' · '+f+'%'+(blank?' 빔':'');b.appendChild(m);
    b.onclick=()=>{openEd={src:s.id,i};render();setTimeout(()=>document.querySelector('.ed').scrollIntoView({behavior:'smooth',block:'nearest'}),30)};
    const a=el('button','add');a.textContent='＋';a.title='만든 것에 담기';
    a.onclick=e=>{e.stopPropagation();seq.push({src:s.id,i});render()};b.appendChild(a);
    b.addEventListener('dragstart',e=>{drag={kind:'add',src:s.id,i};b.classList.add('dragging');e.dataTransfer.effectAllowed='copy'});
    b.addEventListener('dragend',()=>{b.classList.remove('dragging');clearMark();drag=null});
    sp.appendChild(b);
  }
  row.appendChild(sp);return row;
}
function seqRow(){
  const row=el('div','row seq');
  const box=el('div');const st=el('div','stage');const im=el('img');im.id='seqimg';st.appendChild(im);box.appendChild(st);
  const c=el('div','cap');c.textContent='만든 것 '+seq.length+'장';box.appendChild(c);row.appendChild(box);
  const sp=el('div','strip');sp.id='seqstrip';
  seq.forEach((s,n)=>{
    const b=el('div','slot'+(s.src==='old'?' old':''));b.draggable=true;b.dataset.n=n;
    const img=el('img');img.src=furl(s.src,s.i)+'&t='+nEdits(s.src,s.i);b.appendChild(img);
    const m=el('div','m');m.textContent=(s.src==='old'?'지금':'새')+s.i;b.appendChild(m);
    const ops=el('div','ops');
    [['◀',-1],['▶',1],['×',0]].forEach(([t,d])=>{const x=el('button',d===0?'x':'');x.textContent=t;
      x.onclick=e=>{e.stopPropagation();if(d===0)seq.splice(n,1);else{const j=n+d;if(j<0||j>=seq.length)return;[seq[n],seq[j]]=[seq[j],seq[n]]}render()};ops.appendChild(x)});
    b.appendChild(ops);
    b.addEventListener('dragstart',e=>{drag={kind:'move',n};b.classList.add('dragging');e.dataTransfer.effectAllowed='move'});
    b.addEventListener('dragend',()=>{b.classList.remove('dragging');clearMark();drag=null});
    sp.appendChild(b);
  });
  sp.addEventListener('dragover',e=>{if(!drag)return;e.preventDefault();markAt(sp,e.clientX)});
  sp.addEventListener('drop',e=>{if(!drag)return;e.preventDefault();
    const at=markIndex(sp);
    if(drag.kind==='add')seq.splice(at,0,{src:drag.src,i:drag.i});
    else{const [m]=seq.splice(drag.n,1);seq.splice(at>drag.n?at-1:at,0,m)}
    clearMark();drag=null;render()});
  row.appendChild(sp);return row;
}
let drag=null,mark=null;
function clearMark(){if(mark&&mark.parentNode)mark.remove();mark=null}
function markAt(box,x){
  if(!mark){mark=el('div','mark')}
  const slots=[...box.children].filter(c=>c.classList.contains('slot')&&!c.classList.contains('dragging'));
  let before=null;
  for(const s of slots){const r=s.getBoundingClientRect();if(x<r.left+r.width/2){before=s;break}}
  if(before)box.insertBefore(mark,before);else box.appendChild(mark);
}
function markIndex(box){
  let n=0;for(const c of box.children){if(c===mark)return n;if(c.classList.contains('slot'))n++}
  return seq.length;
}
function play(){
  clearInterval(playT);
  const im=$('#seqimg');if(!im||!seq.length)return;
  const per=Math.max(20,Math.round(fit/seq.length/10)*10);
  let k=0;im.src=furl(seq[0].src,seq[0].i)+'&t='+nEdits(seq[0].src,seq[0].i);
  playT=setInterval(()=>{k=(k+1)%seq.length;im.src=furl(seq[k].src,seq[k].i)+'&t='+nEdits(seq[k].src,seq[k].i)},per);
}
async function save(){
  const steps=seq.map(s=>({src:s.src,i:s.i,erase:edits[K(s.src,s.i)]||[]}));
  const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({dir:cur.dir,kind:cur.kind,seq:steps,fitMs:fit})});
  const j=await r.json();
  const m=el('div','msg '+(j.ok?'ok':'err'));
  m.innerHTML=j.ok?'저장했습니다 — '+j.frames+'장 · 한 바퀴 '+j.loop_ms+'ms<br>옛 파일은 _prev/ 에. 올린 뒤 CDN 비우기: <code>'+j.purge+'</code>':'실패: '+j.error;
  $('#work').appendChild(m);m.scrollIntoView({behavior:'smooth',block:'nearest'});
  if(j.ok){const n=document.querySelector('.it.on');if(n&&!n.querySelector('.done')){const d=el('span','done');d.textContent='●';n.appendChild(d)}}
}

// ── 큰 편집기 ────────────────────────────────────────────────────────────
let tool='pencil',color='#ffffff',brush=2,tol=20,onionOn=true,strokes=[],base=null,pal=[];
function editor(){
  const wrap=el('div','ed');
  const h=el('h2');h.innerHTML='낱장 편집 <span class="mono">'+(openEd.src==='old'?'지금':'새')+openEd.i+'</span>';
  const cls=el('button','close');cls.textContent='닫기';cls.onclick=()=>{openEd=null;render()};h.appendChild(cls);
  wrap.appendChild(h);

  const main=el('div','edmain');
  const cw=el('div','cw');
  const on=el('canvas');on.id='onion';const gr=el('canvas');gr.id='grid';const cv=el('canvas');cv.id='cv';
  cw.append(on,cv,gr);main.appendChild(cw);

  const T=el('div','tools');
  const tg=el('div','tgrid');
  [['pencil','연필'],['eraser','지우개'],['picker','스포이드'],['bucket','페인트통'],['swap','색바꾸기'],['move','이동']]
    .forEach(([id,n])=>{const x=el('button');x.textContent=n;x.setAttribute('aria-pressed',String(tool===id));
      x.onclick=()=>{tool=id;render()};tg.appendChild(x)});
  T.appendChild(tg);

  const cur=el('div','cur');const box=el('div','box');box.style.background=color;
  const ci=el('input');ci.type='color';ci.value=color;ci.oninput=e=>{color=e.target.value;box.style.background=color};
  cur.append(box,ci);const bl=el('span');bl.className='mono';bl.textContent='굵기';cur.appendChild(bl);
  const bi=el('input');bi.type='range';bi.min=1;bi.max=24;bi.value=brush;bi.style.width='90px';
  bi.oninput=e=>{brush=+e.target.value;bs.textContent=brush};const bs=el('span');bs.className='mono';bs.textContent=brush;
  cur.append(bi,bs);T.appendChild(cur);

  const tl=el('div','cur');tl.innerHTML='<span class="mono">비슷한 색 허용</span>';
  const ti=el('input');ti.type='range';ti.min=0;ti.max=90;ti.value=tol;ti.style.width='90px';
  const tv=el('span');tv.className='mono';tv.textContent=tol;ti.oninput=e=>{tol=+e.target.value;tv.textContent=tol};
  tl.append(ti,tv);T.appendChild(tl);

  const pw=el('div','pal');T.appendChild(pw);
  const opts=el('div','cur');
  const ob=el('button');ob.textContent='어니언스킨';ob.setAttribute('aria-pressed',String(onionOn));
  ob.onclick=()=>{onionOn=!onionOn;render()};opts.appendChild(ob);
  const ub=el('button');ub.textContent='되돌리기';ub.onclick=()=>{if(!strokes.length)return;
    const l=strokes[strokes.length-1];if(l.t==='p'||l.t==='c'){while(strokes.length&&(strokes[strokes.length-1].t==='p'||strokes[strokes.length-1].t==='c'))strokes.pop()}else strokes.pop();redraw()};
  const rb=el('button');rb.textContent='처음으로';rb.onclick=()=>{strokes=[];redraw()};
  opts.append(ub,rb);T.appendChild(opts);

  const ap=el('button','primary');ap.textContent='이 낱장에 적용';
  ap.onclick=()=>{const k=K(openEd.src,openEd.i);if(strokes.length)edits[k]=strokes.slice();else delete edits[k];openEd=null;render()};
  T.appendChild(ap);
  const hint=el('div');hint.className='cap';hint.style.textAlign='left';
  hint.textContent='손댄 자국은 좌표로 저장됩니다. 원본 gif 는 안 바뀝니다.';
  T.appendChild(hint);
  main.appendChild(T);wrap.appendChild(main);

  setTimeout(()=>mount(cv,on,gr,pw),0);
  return wrap;
}
function mount(cv,on,gr,pw){
  const img=new Image();
  img.onload=()=>{
    const z=Math.max(2,Math.min(6,Math.floor(460/img.width)));
    base={img,z,w:img.width,h:img.height};
    [cv,on,gr].forEach(c=>{c.width=img.width;c.height=img.height;c.style.width=img.width*z+'px';c.style.height=img.height*z+'px'});
    strokes=(edits[K(openEd.src,openEd.i)]||[]).slice();
    redraw();drawGrid(gr,z);drawOnion(on);buildPal(pw);
    bindCanvas(cv);
  };
  img.src=furl(openEd.src,openEd.i);
}
function ctxOf(){return document.getElementById('cv').getContext('2d',{willReadFrequently:true})}
function redraw(){
  const c=ctxOf();c.clearRect(0,0,base.w,base.h);c.drawImage(base.img,0,0);
  for(const s of strokes)applyOne(c,s);
}
function applyOne(c,s){
  if(s.t==='c'){c.save();c.globalCompositeOperation='destination-out';c.beginPath();c.arc(s.x,s.y,s.r,0,7);c.fill();c.restore()}
  else if(s.t==='r'){c.save();c.globalCompositeOperation='destination-out';c.fillRect(s.x,s.y,s.w,s.h);c.restore()}
  else if(s.t==='p'){c.fillStyle='rgb('+s.color.join(',')+')';c.beginPath();c.arc(s.x,s.y,s.r,0,7);c.fill()}
  else if(s.t==='swap'||s.t==='fill'||s.t==='shift'){pixelOp(c,s)}
}
function pixelOp(c,s){
  const d=c.getImageData(0,0,base.w,base.h),px=d.data,w=base.w,h=base.h;
  if(s.t==='swap'){const [fr,fg,fb]=s.from,[tr,tg,tb]=s.to,t=(s.tol??20)**2*3;
    for(let i=0;i<px.length;i+=4){if(px[i+3]<40)continue;const a=px[i]-fr,b=px[i+1]-fg,g=px[i+2]-fb;
      if(a*a+b*b+g*g<=t){px[i]=tr;px[i+1]=tg;px[i+2]=tb}}}
  else if(s.t==='fill'){
    const sx=Math.floor(s.x),sy=Math.floor(s.y);if(sx<0||sy<0||sx>=w||sy>=h)return;
    const si=(sy*w+sx)*4,seed=[px[si],px[si+1],px[si+2],px[si+3]],[tr,tg,tb]=s.color,t=(s.tol??20)**2*3;
    const near=i=>{if(seed[3]<40)return px[i+3]<40;if(px[i+3]<40)return false;
      const a=px[i]-seed[0],b=px[i+1]-seed[1],g=px[i+2]-seed[2];return a*a+b*b+g*g<=t};
    const seen=new Uint8Array(w*h),st=[sy*w+sx];seen[sy*w+sx]=1;
    while(st.length){const p=st.pop(),i=p*4;if(!near(i))continue;
      px[i]=tr;px[i+1]=tg;px[i+2]=tb;px[i+3]=255;
      const x=p%w,y=(p/w)|0;
      if(x>0&&!seen[p-1]){seen[p-1]=1;st.push(p-1)}if(x<w-1&&!seen[p+1]){seen[p+1]=1;st.push(p+1)}
      if(y>0&&!seen[p-w]){seen[p-w]=1;st.push(p-w)}if(y<h-1&&!seen[p+w]){seen[p+w]=1;st.push(p+w)}}}
  else if(s.t==='shift'){const out=new Uint8ClampedArray(px.length);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const sx=x-s.dx,sy=y-s.dy;if(sx<0||sy<0||sx>=w||sy>=h)continue;
      const a=(sy*w+sx)*4,b=(y*w+x)*4;out[b]=px[a];out[b+1]=px[a+1];out[b+2]=px[a+2];out[b+3]=px[a+3]}
    px.set(out)}
  c.putImageData(d,0,0);
}
function drawGrid(gr,z){
  const c=gr.getContext('2d');c.clearRect(0,0,gr.width,gr.height);
  if(z<4)return;
  c.strokeStyle='rgba(255,255,255,.09)';c.lineWidth=1/z;c.save();c.scale(1,1);
  for(let x=0;x<=gr.width;x++){c.beginPath();c.moveTo(x,0);c.lineTo(x,gr.height);c.stroke()}
  for(let y=0;y<=gr.height;y++){c.beginPath();c.moveTo(0,y);c.lineTo(gr.width,y);c.stroke()}
  c.restore();
}
function drawOnion(on){
  const c=on.getContext('2d');c.clearRect(0,0,on.width,on.height);
  if(!onionOn||openEd.i===0)return;
  const prev=new Image();prev.onload=()=>c.drawImage(prev,0,0);prev.src=furl(openEd.src,openEd.i-1);
}
async function buildPal(pw){
  const r=await fetch('/api/palette?dir='+encodeURIComponent(cur.dir)+'&kind='+cur.kind+'&src='+openEd.src+'&i='+openEd.i);
  pal=await r.json();pw.innerHTML='';
  pal.forEach(p=>{const b=el('button','sw'+(p.hex===color?' on':''));b.style.background=p.hex;b.title=p.hex+' · '+p.n+'px';
    b.onclick=()=>{color=p.hex;render()};pw.appendChild(b)});
}
const hex2rgb=h=>[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
function bindCanvas(cv){
  let painting=false,last=null;
  const pos=e=>{const r=cv.getBoundingClientRect();return{x:(e.clientX-r.left)/base.z,y:(e.clientY-r.top)/base.z}};
  const rd=v=>Math.round(v*10)/10;
  cv.onpointerdown=e=>{
    cv.setPointerCapture(e.pointerId);const p=pos(e);
    if(tool==='picker'){const c=ctxOf();const d=c.getImageData(Math.floor(p.x),Math.floor(p.y),1,1).data;
      color='#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join('');render();return}
    if(tool==='bucket'){strokes.push({t:'fill',x:rd(p.x),y:rd(p.y),color:hex2rgb(color),tol});redraw();return}
    if(tool==='swap'){const c=ctxOf();const d=c.getImageData(Math.floor(p.x),Math.floor(p.y),1,1).data;
      strokes.push({t:'swap',from:[d[0],d[1],d[2]],to:hex2rgb(color),tol});redraw();return}
    if(tool==='move'){last=p;painting=true;return}
    painting=true;stroke(p);
  };
  cv.onpointermove=e=>{if(!painting)return;const p=pos(e);
    if(tool==='move'){const dx=Math.round(p.x-last.x),dy=Math.round(p.y-last.y);
      if(dx||dy){strokes.push({t:'shift',dx,dy});last=p;redraw()}return}
    stroke(p)};
  cv.onpointerup=()=>{painting=false;last=null};
  function stroke(p){
    const rd=v=>Math.round(v*10)/10;
    if(tool==='eraser')strokes.push({t:'c',x:rd(p.x),y:rd(p.y),r:brush/2});
    else strokes.push({t:'p',x:rd(p.x),y:rd(p.y),r:brush/2,color:hex2rgb(color)});
    redraw();
  }
}
boot();
</script></body></html>`;
