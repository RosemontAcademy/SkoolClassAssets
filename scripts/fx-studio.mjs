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
import { readFrames, encodeGif, rubOut, fillRatio, listItems, sourcesFor } from './lib/fxgif.mjs';

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
    if (step.erase && step.erase.length) rubOut(px, w, h, step.erase);
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
    display:grid;grid-template-columns:250px 1fr;height:100vh;overflow:hidden}
  .mono{font-family:ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}
  aside{border-right:1px solid var(--line);overflow-y:auto;background:var(--surface)}
  aside h1{margin:0;padding:14px 16px 10px;font-size:15px;font-weight:800;border-bottom:1px solid var(--line)}
  .it{display:flex;gap:8px;align-items:baseline;padding:8px 16px;cursor:pointer;border-bottom:1px solid color-mix(in srgb,var(--line) 50%,transparent)}
  .it:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}
  .it.on{background:color-mix(in srgb,var(--accent) 16%,transparent);font-weight:800}
  .it small{color:var(--muted);font-size:11px;font-family:ui-monospace,Consolas,monospace}
  .it .done{margin-left:auto;color:var(--accent);font-size:11px}
  main{overflow-y:auto;padding:16px 20px 40px;display:flex;flex-direction:column;gap:14px}
  .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;position:sticky;top:-16px;z-index:5;
    background:color-mix(in srgb,var(--ground) 94%,transparent);backdrop-filter:blur(8px);padding:10px 0;border-bottom:1px solid var(--line)}
  button{font:inherit;font-size:13px;font-weight:700;color:var(--ink);background:var(--surface);
    border:1px solid var(--line);border-radius:8px;padding:7px 12px;cursor:pointer}
  button:hover{border-color:var(--accent)}
  button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button:disabled{opacity:.45;cursor:default}
  .lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700}
  .row{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px;display:flex;gap:12px;align-items:flex-start}
  .row.seq{border-color:color-mix(in srgb,var(--accent) 40%,transparent);background:color-mix(in srgb,var(--accent) 6%,transparent)}
  .stage{width:120px;height:120px;flex:0 0 auto;border-radius:9px;border:1px solid var(--line);display:grid;place-items:center;
    background-color:var(--cell);background-image:linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%),
    linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%);background-size:16px 16px;background-position:0 0,8px 8px}
  .stage img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
  .cap{font-size:11px;color:var(--muted);text-align:center;margin-top:3px}
  .strip{display:flex;gap:7px;overflow-x:auto;flex:1;padding-bottom:4px;min-height:104px}
  .fr,.slot{position:relative;flex:0 0 auto;padding:4px;border-radius:9px;border:2px solid var(--line);background:var(--cell);cursor:pointer}
  .fr img,.slot img{width:76px;height:76px;object-fit:contain;image-rendering:pixelated;display:block;border-radius:5px;
    background-image:linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%),
    linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%);background-size:12px 12px;background-position:0 0,6px 6px}
  .fr .m,.slot .m{font-size:9.5px;color:var(--muted);text-align:center;font-family:ui-monospace,Consolas,monospace}
  .fr.blank{border-style:dashed}.fr.blank .m{color:var(--drop);font-weight:800}
  .fr.edited{box-shadow:0 0 0 2px color-mix(in srgb,var(--drop) 55%,transparent) inset}
  .slot{border-color:var(--accent)}.slot.old{border-color:var(--old)}
  .ops{display:flex;gap:2px;justify-content:center}
  .ops button{padding:0 5px;font-size:11px;line-height:1.5;border-radius:5px}
  .ops .x{color:var(--drop)}
  .edit{position:absolute;top:4px;right:4px;padding:0 5px;font-size:11px;border-radius:5px;background:color-mix(in srgb,var(--surface) 85%,transparent)}
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:50;padding:20px}
  .modal[hidden]{display:none}
  .sheet{background:var(--surface);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:11px;max-width:min(94vw,700px)}
  .sheet h2{margin:0;font-size:15px;font-weight:800}
  .cw{display:grid;place-items:center;border-radius:12px;padding:10px;background-color:var(--cell);
    background-image:linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%),
    linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%);background-size:16px 16px;background-position:0 0,8px 8px}
  #cv{image-rendering:pixelated;cursor:crosshair;touch-action:none;border-radius:6px;max-width:100%}
  .msg{font-size:13px;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--surface)}
  .msg.ok{border-color:color-mix(in srgb,var(--accent) 50%,transparent);color:var(--accent)}
  .msg.err{border-color:color-mix(in srgb,var(--drop) 50%,transparent);color:var(--drop)}
  code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;background:var(--ground);padding:1px 5px;border-radius:4px}
</style></head><body>
<aside><h1>공격 연출</h1><div id="list"></div></aside>
<main>
  <div class="bar" id="bar"><span class="lbl">종을 고르세요</span></div>
  <div id="work"></div>
</main>

<div class="modal" hidden id="modal"><div class="sheet">
  <h2>지우기 <span class="mono" id="etitle" style="font-weight:600;color:var(--muted);font-size:12px"></span></h2>
  <div class="cw"><canvas id="cv"></canvas></div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <button id="tb" aria-pressed="true">동그라미</button><button id="tr" aria-pressed="false">네모</button>
    <label class="mono" style="font-size:12px">굵기 <input type="range" id="sz" min="2" max="40" value="10"> <span id="szv">10</span></label>
    <span style="flex:1"></span>
    <button id="eu">되돌리기</button><button id="er">처음으로</button><button id="ed" class="primary">적용</button>
  </div>
</div></div>

<script>
const $=s=>document.querySelector(s), el=(t,c)=>{const e=document.createElement(t);if(c)e.className=c;return e};
let items=[], cur=null, meta={}, seq=[], erase={}, delay=null, fit=3000, playT=null;
const furl=(src,i)=>'/frame.png?dir='+encodeURIComponent(cur.dir)+'&kind='+cur.kind+'&src='+src+'&i='+i;
const ekey=(src,i)=>src+i;

async function boot(){
  items=await (await fetch('/api/items')).json();
  const L=$('#list');
  items.forEach(it=>{
    const d=el('div','it'); d.dataset.id=it.id;
    d.innerHTML='<span>'+it.dir.replace(/^\\d+-/,'')+'</span><small>'+it.kind+'</small>';
    d.onclick=()=>open(it); L.appendChild(d);
  });
}

async function open(it){
  cur=it; seq=[]; erase={}; delay=null;
  document.querySelectorAll('.it').forEach(n=>n.classList.toggle('on',n.dataset.id===it.id));
  meta={};
  for(const s of it.sources) meta[s.id]=await (await fetch('/api/frames?dir='+encodeURIComponent(it.dir)+'&kind='+it.kind+'&src='+s.id)).json();
  const r=await (await fetch('/api/recipe?dir='+encodeURIComponent(it.dir)+'&kind='+it.kind)).json();
  if(r&&r.steps){ seq=r.steps.map(s=>({src:s.src,i:s.i})); r.steps.forEach(s=>{ if(s.erase&&s.erase.length) erase[ekey(s.src,s.i)]=s.erase; }); }
  else seq=meta.old.fills.map((_,i)=>({src:'old',i}));
  render();
}

function render(){
  $('#bar').innerHTML='';
  const b=$('#bar');
  const t=el('span','lbl'); t.textContent=cur.dir+' · '+cur.kind+' · '+cur.canvas; b.appendChild(t);
  cur.sources.forEach(s=>{ const x=el('button'); x.textContent=s.label+' 전부';
    x.onclick=()=>{ seq=meta[s.id].fills.map((_,i)=>({src:s.id,i})); render(); }; b.appendChild(x); });
  const cl=el('button'); cl.textContent='비우기'; cl.onclick=()=>{seq=[];render()}; b.appendChild(cl);
  const sp=el('span'); sp.style.flex='1'; b.appendChild(sp);
  const fl=el('span','lbl'); fl.textContent='창'; b.appendChild(fl);
  [1500,2000,3000].forEach(v=>{ const x=el('button'); x.textContent=(v/1000)+'초'; x.setAttribute('aria-pressed',String(fit===v));
    x.onclick=()=>{fit=v;render()}; b.appendChild(x); });
  const sv=el('button','primary'); sv.textContent='저장'; sv.disabled=!seq.length; sv.onclick=save; b.appendChild(sv);

  const W=$('#work'); W.innerHTML='';
  cur.sources.forEach(s=>W.appendChild(strip(s)));
  W.appendChild(seqRow());
  const per=seq.length?Math.max(20,Math.round(fit/seq.length/10)*10):0;
  const info=el('div','msg');
  info.innerHTML=seq.length? seq.length+'장 · 장당 <b>'+per+'ms</b> · 한 바퀴 <b>'+(per*seq.length)+'ms</b> → 창 '+(fit/1000)+'초 안에서 <b>'+(fit/(per*seq.length)).toFixed(2)+'바퀴</b>'
    : '낱장을 눌러 담으세요.';
  W.appendChild(info);
  play();
}

function strip(s){
  const row=el('div','row');
  const box=el('div'); const st=el('div','stage'); const im=el('img'); st.appendChild(im); box.appendChild(st);
  const c=el('div','cap'); c.textContent=s.label+' '+s.frames+'장'; box.appendChild(c); row.appendChild(box);
  let k=0; setInterval(()=>{ if(!meta[s.id])return; k=(k+1)%s.frames; im.src=furl(s.id,k); },250);
  const sp=el('div','strip');
  for(let i=0;i<s.frames;i++){
    const f=meta[s.id].fills[i], blank=i>0&&f<meta[s.id].fills[0]*0.25;
    const b=el('div','fr'+(blank?' blank':'')+(erase[ekey(s.id,i)]?' edited':''));
    const img=el('img'); img.src=furl(s.id,i); b.appendChild(img);
    const m=el('div','m'); m.textContent=i+' · '+f+'%'+(blank?' 빔':''); b.appendChild(m);
    b.onclick=()=>{ seq.push({src:s.id,i}); render(); };
    const e=el('button','edit'); e.textContent='✎'; e.onclick=ev=>{ev.stopPropagation();openEd(s.id,i)}; b.appendChild(e);
    sp.appendChild(b);
  }
  row.appendChild(sp); return row;
}

function seqRow(){
  const row=el('div','row seq');
  const box=el('div'); const st=el('div','stage'); const im=el('img'); im.id='seqimg'; st.appendChild(im); box.appendChild(st);
  const c=el('div','cap'); c.textContent='만든 것 '+seq.length+'장'; box.appendChild(c); row.appendChild(box);
  const sp=el('div','strip');
  seq.forEach((s,n)=>{
    const b=el('div','slot'+(s.src==='old'?' old':''));
    const img=el('img'); img.src=furl(s.src,s.i); b.appendChild(img);
    const m=el('div','m'); m.textContent=(s.src==='old'?'지금':'새')+s.i; b.appendChild(m);
    const ops=el('div','ops');
    [['◀',-1],['▶',1],['×',0]].forEach(([t,d])=>{ const x=el('button',d===0?'x':''); x.textContent=t;
      x.onclick=ev=>{ev.stopPropagation();
        if(d===0) seq.splice(n,1);
        else{ const j=n+d; if(j<0||j>=seq.length)return; [seq[n],seq[j]]=[seq[j],seq[n]]; }
        render(); }; ops.appendChild(x); });
    b.appendChild(ops); sp.appendChild(b);
  });
  row.appendChild(sp); return row;
}

function play(){
  clearInterval(playT);
  const im=$('#seqimg'); if(!im||!seq.length)return;
  const per=Math.max(20,Math.round(fit/seq.length/10)*10);
  let k=0; im.src=furl(seq[0].src,seq[0].i);
  playT=setInterval(()=>{ k=(k+1)%seq.length; im.src=furl(seq[k].src,seq[k].i); },per);
}

async function save(){
  const per=Math.max(20,Math.round(fit/seq.length/10)*10);
  const steps=seq.map(s=>({src:s.src,i:s.i,erase:erase[ekey(s.src,s.i)]||[]}));
  const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({dir:cur.dir,kind:cur.kind,seq:steps,fitMs:fit})});
  const j=await r.json();
  const m=el('div','msg '+(j.ok?'ok':'err'));
  m.innerHTML=j.ok? '저장했습니다 — '+j.frames+'장 · 한 바퀴 '+j.loop_ms+'ms<br>옛 파일은 _prev/ 에. 올린 뒤 CDN 비우기: <code>'+j.purge+'</code>'
    : '실패: '+j.error;
  $('#work').appendChild(m);
  if(j.ok){ const n=document.querySelector('.it.on'); if(n&&!n.querySelector('.done')){const d=el('span','done');d.textContent='●';n.appendChild(d);} }
}

// ── 지우개 ────────────────────────────────────────────────────────────────
let ed=null,tool='c',size=10,paint=false,bs=null;
const cv=$('#cv'), ctx=cv.getContext('2d',{willReadFrequently:true});
function openEd(src,i){
  const img=new Image();
  img.onload=()=>{ const z=Math.max(1,Math.min(5,Math.floor(440/img.width)));
    cv.width=img.width;cv.height=img.height;cv.style.width=img.width*z+'px';cv.style.height=img.height*z+'px';
    ed={src,i,img,z,st:(erase[ekey(src,i)]||[]).slice()};
    redraw(); $('#etitle').textContent=src+i+' · '+img.width+'×'+img.height; $('#modal').hidden=false; };
  img.src=furl(src,i);
}
function redraw(){ ctx.clearRect(0,0,cv.width,cv.height); ctx.drawImage(ed.img,0,0);
  ctx.save(); ctx.globalCompositeOperation='destination-out';
  for(const s of ed.st){ ctx.beginPath(); if(s.t==='r')ctx.rect(s.x,s.y,s.w,s.h); else ctx.arc(s.x,s.y,s.r,0,7); ctx.fill(); }
  ctx.restore(); }
const pos=e=>{const r=cv.getBoundingClientRect();return{x:(e.clientX-r.left)/ed.z,y:(e.clientY-r.top)/ed.z}};
const rd=v=>Math.round(v*10)/10;
cv.onpointerdown=e=>{ if(!ed)return; cv.setPointerCapture(e.pointerId); const p=pos(e);
  if(tool==='r')bs=p; else{paint=true;ed.st.push({t:'c',x:rd(p.x),y:rd(p.y),r:size/2});redraw()} };
cv.onpointermove=e=>{ if(!ed||!paint||tool!=='c')return; const p=pos(e); ed.st.push({t:'c',x:rd(p.x),y:rd(p.y),r:size/2}); redraw() };
cv.onpointerup=e=>{ if(!ed)return; if(tool==='r'&&bs){const p=pos(e);
  const x=Math.min(bs.x,p.x),y=Math.min(bs.y,p.y),w=Math.abs(p.x-bs.x),h=Math.abs(p.y-bs.y);
  if(w>.5&&h>.5){ed.st.push({t:'r',x:rd(x),y:rd(y),w:rd(w),h:rd(h)});redraw()} bs=null;} paint=false };
$('#tb').onclick=()=>{tool='c';$('#tb').setAttribute('aria-pressed','true');$('#tr').setAttribute('aria-pressed','false')};
$('#tr').onclick=()=>{tool='r';$('#tr').setAttribute('aria-pressed','true');$('#tb').setAttribute('aria-pressed','false')};
$('#sz').oninput=function(){size=+this.value;$('#szv').textContent=this.value};
$('#eu').onclick=()=>{ if(!ed||!ed.st.length)return; const l=ed.st[ed.st.length-1];
  if(l.t==='r')ed.st.pop(); else while(ed.st.length&&ed.st[ed.st.length-1].t==='c')ed.st.pop(); redraw() };
$('#er').onclick=()=>{ if(ed){ed.st=[];redraw()} };
$('#ed').onclick=()=>{ if(!ed){$('#modal').hidden=true;return}
  const k=ekey(ed.src,ed.i); if(ed.st.length)erase[k]=ed.st; else delete erase[k];
  $('#modal').hidden=true; ed=null; render(); };
$('#modal').onclick=e=>{ if(e.target===$('#modal')){$('#modal').hidden=true;ed=null} };
addEventListener('keydown',e=>{ if(e.key==='Escape'){$('#modal').hidden=true;ed=null} });

boot();
</script></body></html>`;
