const { GifReader } = require('E:/Projects/skoolclass-pro/node_modules/omggif');
const { PNG } = require('E:/Projects/skoolclass-pro/node_modules/pngjs');
const fs = require('fs');

const FXD = 'E:/Projects/skoolclass-pro/SkoolClassAssets/skillFX/';
const LIST = 'E:/Projects/skoolclass-pro/pixelLab/redo-2026-08-22.txt';
const OUT = process.argv[2];
const A = 40;

const NAMES = {
  '6-charizard': '리자몽', '7-squirtle': '꼬부기', '8-wartortle': '어니부기',
  '13-weedle': '뿔充', '15-beedrill': '독침붕', '17-pidgeotto': '피죤', '18-pidgeot': '피죤투',
  '19-rattata': '꼬렛', '20-raticate': '레트라', '21-spearow': '깨비참', '22-fearow': '깨비드릴조',
  '24-arbok': '아보크', '27-sandshrew': '모래두지', '28-sandslash': '고지',
  '37-vulpix': '식스테일', '38-ninetales': '나인테일', '41-zubat': '주바트', '42-golbat': '골뱃',
};

// Every frame in these gifs is full-canvas with disposal=2 (restore to background),
// so each one must be decoded onto a CLEARED buffer. Blitting cumulatively -- which is
// what this did at first -- stacks every frame onto the last: the frames looked
// overlapped on screen and every area number came out inflated.
function framesPng(p) {
  const r = new GifReader(fs.readFileSync(p));
  const n = r.width * r.height * 4;
  const out = [];
  let prev = null;
  for (let i = 0; i < r.numFrames(); i++) {
    const info = r.frameInfo(i);
    const buf = new Uint8Array(n);
    if (prev && (info.disposal === 0 || info.disposal === 1)) buf.set(prev);
    r.decodeAndBlitFrameRGBA(i, buf);
    prev = buf;
    const png = new PNG({ width: r.width, height: r.height });
    png.data.set(buf);
    let fill = 0;
    for (let k = 0; k < r.width * r.height; k++) if (buf[k * 4 + 3] > A) fill++;
    out.push({ b64: PNG.sync.write(png).toString('base64'), fill: fill / (r.width * r.height) });
  }
  return out;
}

const items = fs.readFileSync(LIST, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  .map(l => { const [dir, kind] = l.split(/\s+/); return { dir, kind }; })
  .sort((a, b) => parseInt(a.dir, 10) - parseInt(b.dir, 10) || a.kind.localeCompare(b.kind));

const cards = [];
for (const it of items) {
  const np = FXD + it.dir + '/' + it.dir + '-' + it.kind + '-fx-v2.gif';
  const op = FXD + it.dir + '/' + it.dir + '-' + it.kind + '-fx.gif';
  if (!fs.existsSync(np) || !fs.existsSync(op)) continue;
  cards.push({
    id: it.dir + ' ' + it.kind, dir: it.dir, kind: it.kind, name: NAMES[it.dir] || it.dir,
    old: framesPng(op), neu: framesPng(np),
  });
}

const pctOf = v => (v * 100).toFixed(0) + '%';

const strip = (frames, side) => `
          <div class="track" data-side="${side}">
            <div class="preview">
              <div class="stage"><img data-play alt="미리보기" /></div>
              <span class="plabel">${side === 'old' ? '지금 쓰는 것' : '새로 구운 것'}
                <b class="mono" data-count>${frames.length}장</b></span>
            </div>
            <div class="strip">
              ${frames.map((f, i) => `
                <div class="frwrap">
                  <button type="button" draggable="true" class="fr${i > 0 && f.fill < frames[0].fill * 0.25 ? ' blank' : ''}" data-i="${i}" aria-pressed="true">
                    <img src="data:image/png;base64,${f.b64}" data-orig="data:image/png;base64,${f.b64}" alt="프레임 ${i}" loading="lazy" />
                    <span class="fmeta mono">${side === 'old' ? '지금' : '새'}${i} ${pctOf(f.fill)}</span>
                  </button>
                  <button type="button" class="edit" data-edit="${i}" title="이 장에서 지우기">✎</button>
                </div>`).join('')}
            </div>
          </div>`;

const card = c => `
      <article class="item" data-id="${c.id}" data-nold="${c.old.length}" data-nnew="${c.neu.length}">
        <header>
          <span class="nm">${c.name}</span>
          <span class="kd mono">${c.kind}</span>
          <span class="dx mono">${c.dir}</span>
          <span class="verdict mono" data-verdict></span>
        </header>
        ${strip(c.old, 'old')}
        ${strip(c.neu, 'new')}
        <div class="build">
          <div class="preview">
            <div class="stage"><img data-play-seq alt="조립 결과 미리보기" /></div>
            <span class="plabel">만든 것 <b class="mono" data-seqcount>0장</b></span>
          </div>
          <div class="seq" data-seq></div>
        </div>
        <div class="quick">
          <button type="button" data-fill="old">지금 것 전부</button>
          <button type="button" data-fill="new">새것 전부</button>
          <button type="button" data-fill="clear">비우기</button>
        </div>
      </article>`;

const html = `<title>프레임 골라내기</title>
<style>
  :root{
    --ground:#F3F4F6; --surface:#FFFFFF; --line:#DEE0E6; --ink:#171821; --muted:#666A78;
    --accent:#3B4CC0; --old:#5B6270; --drop:#A03030;
    --cell:#22242C; --cell-alt:#2B2E37;
    --shadow:0 1px 2px rgba(23,24,33,.06),0 10px 26px rgba(23,24,33,.05);
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --ground:#101117; --surface:#191B22; --line:#292C36; --ink:#E9EAF2; --muted:#969AAA;
      --accent:#8FA0FF; --old:#98A0B4; --drop:#F08A8A;
      --cell:#0A0B0F; --cell-alt:#131520;
      --shadow:0 1px 2px rgba(0,0,0,.45),0 12px 30px rgba(0,0,0,.4);
    }
  }
  :root[data-theme="dark"]{
    --ground:#101117; --surface:#191B22; --line:#292C36; --ink:#E9EAF2; --muted:#969AAA;
    --accent:#8FA0FF; --old:#98A0B4; --drop:#F08A8A;
    --cell:#0A0B0F; --cell-alt:#131520;
    --shadow:0 1px 2px rgba(0,0,0,.45),0 12px 30px rgba(0,0,0,.4);
  }
  *{box-sizing:border-box}
  body{margin:0; background:var(--ground); color:var(--ink);
    font-family:"Pretendard","Malgun Gothic","Apple SD Gothic Neo","Segoe UI",system-ui,sans-serif;
    font-size:15px; line-height:1.6; -webkit-font-smoothing:antialiased}
  .mono{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; font-variant-numeric:tabular-nums}
  .wrap{max-width:1180px; margin:0 auto; padding:38px 22px 40px; display:flex; flex-direction:column; gap:22px}
  .eyebrow{margin:0; font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); font-weight:700}
  h1{margin:6px 0 0; font-size:clamp(27px,4.2vw,38px); line-height:1.15; letter-spacing:-.02em; font-weight:800; text-wrap:balance}
  .lede{margin:10px 0 0; max-width:66ch; color:var(--muted); font-size:16px}

  .toolbar{display:flex; gap:9px; flex-wrap:wrap; align-items:center;
    position:sticky; top:0; z-index:30; margin:0 -8px; padding:10px 8px;
    background:color-mix(in srgb,var(--ground) 92%,transparent); backdrop-filter:blur(10px);
    border-bottom:1px solid var(--line)}
  .toolbar span.lbl{font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; font-weight:700}
  button{font:inherit; font-size:13px; font-weight:700; color:var(--ink); background:var(--surface);
    border:1px solid var(--line); border-radius:8px; padding:7px 13px; cursor:pointer}
  button:focus-visible{outline:2px solid var(--accent); outline-offset:2px}

  .list{display:flex; flex-direction:column; gap:14px}
  .item{background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:14px 15px;
    display:flex; flex-direction:column; gap:10px; box-shadow:var(--shadow)}
  .item.use-new{border-color:var(--accent)}
  .item header{display:flex; align-items:baseline; gap:9px}
  .nm{font-weight:800; font-size:16px; letter-spacing:-.01em}
  .kd{font-size:12px; color:var(--muted)}
  .dx{font-size:10.5px; color:var(--muted); opacity:.65}
  .verdict{margin-left:auto; font-size:11.5px; font-weight:700; color:var(--muted);
    border:1px solid var(--line); border-radius:6px; padding:1px 8px}
  .item.use-new .verdict{color:var(--accent); border-color:color-mix(in srgb,var(--accent) 45%,transparent)}

  .track{display:flex; gap:12px; align-items:flex-start; padding:8px; border-radius:11px;
    border:1.5px solid transparent}
  .item.use-old .track[data-side="old"], .item.use-new .track[data-side="new"]{
    border-color:color-mix(in srgb,var(--accent) 40%,transparent);
    background:color-mix(in srgb,var(--accent) 6%,transparent)}
  .track[data-side="old"] .plabel b{color:var(--old)}
  .track[data-side="new"] .plabel b{color:var(--accent)}

  .preview{display:flex; flex-direction:column; gap:4px; flex:0 0 auto}
  .stage{width:112px; height:112px; border-radius:10px; overflow:hidden; display:grid; place-items:center;
    background-color:var(--cell); border:1px solid var(--line);
    background-image:linear-gradient(45deg,var(--cell-alt) 25%,transparent 25%,transparent 75%,var(--cell-alt) 75%),
                     linear-gradient(45deg,var(--cell-alt) 25%,transparent 25%,transparent 75%,var(--cell-alt) 75%);
    background-size:16px 16px; background-position:0 0,8px 8px}
  .stage img{width:100%; height:100%; object-fit:contain; image-rendering:pixelated; display:block}

  /* 배경 조절 — 체커는 투명을 확인하는 용도, 나머지는 실제로 어떻게 보일지 보는 용도 */
  body[data-bg="dark"] .stage, body[data-bg="dark"] .fr img, body[data-bg="dark"] .slot img,
  body[data-bg="light"] .stage, body[data-bg="light"] .fr img, body[data-bg="light"] .slot img,
  body[data-bg="grey"] .stage, body[data-bg="grey"] .fr img, body[data-bg="grey"] .slot img{background-image:none}
  body[data-bg="dark"] .stage, body[data-bg="dark"] .fr img, body[data-bg="dark"] .slot img{background-color:#0A0B0F}
  body[data-bg="light"] .stage, body[data-bg="light"] .fr img, body[data-bg="light"] .slot img{background-color:#FFFFFF}
  body[data-bg="grey"] .stage, body[data-bg="grey"] .fr img, body[data-bg="grey"] .slot img{background-color:#8A8F9A}
  body[data-bg="page"] .stage, body[data-bg="page"] .fr img, body[data-bg="page"] .slot img{background-image:none; background-color:transparent}
  body[data-bg="page"] .stage{border-color:color-mix(in srgb,var(--line) 60%,transparent)}

  .fr.blank{border-style:dashed}
  .fr.blank .fmeta{color:var(--drop); font-weight:800}
  .fr.blank .fmeta::after{content:" 빔"}
  .plabel{font-size:11px; color:var(--muted); display:flex; gap:5px; align-items:baseline}
  .plabel b{font-size:11px}

  .strip{display:flex; gap:7px; overflow-x:auto; padding-bottom:4px; flex:1}
  .fr{position:relative; padding:4px; border-radius:9px; border:2px solid var(--line); background:var(--cell);
    display:flex; flex-direction:column; gap:2px; align-items:center; flex:0 0 auto; cursor:pointer}
  .fr img{width:80px; height:80px; object-fit:contain; image-rendering:pixelated; display:block; border-radius:5px;
    background-image:linear-gradient(45deg,var(--cell-alt) 25%,transparent 25%,transparent 75%,var(--cell-alt) 75%),
                     linear-gradient(45deg,var(--cell-alt) 25%,transparent 25%,transparent 75%,var(--cell-alt) 75%);
    background-size:12px 12px; background-position:0 0,6px 6px}
  .fmeta{font-size:9.5px; color:var(--muted)}
  .fr[aria-pressed="true"]{border-color:var(--accent)}
  .track[data-side="old"] .fr[aria-pressed="true"]{border-color:var(--old)}
  .fr[aria-pressed="false"]{border-color:transparent; opacity:.3}
  .fr[aria-pressed="false"] img{filter:grayscale(1)}
  .fr[aria-pressed="false"]::after{content:"뺌"; position:absolute; top:6px; right:7px; font-size:9.5px;
    font-weight:800; color:var(--drop); background:var(--surface); border-radius:4px; padding:0 4px}

  .build{display:flex; gap:12px; align-items:flex-start; padding:9px 8px; border-radius:11px;
    border:1.5px solid color-mix(in srgb,var(--accent) 35%,transparent);
    background:color-mix(in srgb,var(--accent) 6%,transparent)}
  .seq{display:flex; gap:7px; overflow-x:auto; padding-bottom:4px; flex:1; min-height:112px; align-items:flex-start}
  .seq:empty::before{content:"위 낱장을 눌러 순서대로 담으세요"; color:var(--muted); font-size:12.5px; align-self:center}
  .slot{position:relative; flex:0 0 auto; display:flex; flex-direction:column; gap:2px; align-items:center;
    padding:4px; border-radius:9px; border:2px solid var(--accent); background:var(--cell)}
  .slot.from-old{border-color:var(--old)}
  .slot img{width:74px; height:74px; object-fit:contain; image-rendering:pixelated; display:block; border-radius:5px;
    background-image:linear-gradient(45deg,var(--cell-alt) 25%,transparent 25%,transparent 75%,var(--cell-alt) 75%),
                     linear-gradient(45deg,var(--cell-alt) 25%,transparent 25%,transparent 75%,var(--cell-alt) 75%);
    background-size:12px 12px; background-position:0 0,6px 6px}
  .slot .src{font-size:9.5px; color:var(--muted); font-family:ui-monospace,Consolas,monospace}
  .slot .ops{display:flex; gap:2px}
  .slot .ops button{padding:0 5px; font-size:11px; line-height:1.5; border-radius:5px; font-weight:800}
  .slot .ops .x{color:var(--drop)}
  .quick{display:flex; gap:8px}
  .quick button{flex:1}

  .frwrap{position:relative; flex:0 0 auto}
  .frwrap .edit{position:absolute; top:5px; right:5px; padding:1px 6px; font-size:11px; line-height:1.4;
    border-radius:6px; background:color-mix(in srgb,var(--surface) 88%,transparent)}
  .fr.edited{border-style:solid; box-shadow:0 0 0 2px color-mix(in srgb,var(--drop) 55%,transparent) inset}
  .frwrap .edit.on{background:var(--drop); border-color:var(--drop); color:#fff}

  .modal{position:fixed; inset:0; z-index:100; display:grid; place-items:center;
    background:color-mix(in srgb,#000 55%,transparent); padding:20px}
  .modal[hidden]{display:none}
  .sheet{background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:16px;
    display:flex; flex-direction:column; gap:12px; max-width:min(94vw,720px); box-shadow:0 20px 60px rgba(0,0,0,.4)}
  .sheet h2{margin:0; font-size:16px; font-weight:800; display:flex; align-items:baseline; gap:8px}
  .sheet h2 small{font-weight:600; font-size:12px; color:var(--muted); font-family:ui-monospace,Consolas,monospace}
  .canvaswrap{display:grid; place-items:center; border-radius:12px; padding:10px;
    background-color:var(--cell);
    background-image:linear-gradient(45deg,var(--cell-alt) 25%,transparent 25%,transparent 75%,var(--cell-alt) 75%),
                     linear-gradient(45deg,var(--cell-alt) 25%,transparent 25%,transparent 75%,var(--cell-alt) 75%);
    background-size:16px 16px; background-position:0 0,8px 8px}
  #ecanvas{image-rendering:pixelated; cursor:crosshair; touch-action:none; border-radius:6px; max-width:100%}
  .etools{display:flex; gap:8px; align-items:center; flex-wrap:wrap}
  .etools input[type=range]{width:130px}
  .etools .grow{flex:1}
  .etools button[aria-pressed="true"]{background:var(--accent); border-color:var(--accent); color:#fff}
  .ehint{margin:0; font-size:12px; color:var(--muted)}

  /* 끌어놓기 */
  .fr, .slot{-webkit-user-drag:element}
  .fr[draggable="true"], .slot[draggable="true"]{cursor:grab}
  .fr.dragging, .slot.dragging{opacity:.4}
  .seq.over{outline:2px dashed var(--accent); outline-offset:2px}
  .seq .drop-mark{flex:0 0 auto; width:4px; align-self:stretch; border-radius:2px; background:var(--accent)}
  .slot .grip{position:absolute; top:3px; left:5px; font-size:10px; color:var(--muted); pointer-events:none}

  .out{position:sticky; bottom:0; z-index:20;
    background:color-mix(in srgb,var(--surface) 94%,transparent); backdrop-filter:blur(10px);
    border:1px solid var(--line); border-radius:14px; padding:14px 16px; box-shadow:var(--shadow);
    display:flex; flex-direction:column; gap:10px}
  .out-top{display:flex; align-items:center; gap:14px; flex-wrap:wrap}
  .out-top b{font-size:15px}
  .out-top .spacer{flex:1}
  .out textarea{width:100%; min-height:92px; resize:vertical; font-family:ui-monospace,Consolas,monospace;
    font-size:12px; line-height:1.5; color:var(--ink); background:var(--ground);
    border:1px solid var(--line); border-radius:9px; padding:9px 11px}
  .out .tip{margin:0; font-size:12px; color:var(--muted)}
  footer{color:var(--muted); font-size:12.5px; border-top:1px solid var(--line); padding-top:14px}
  @media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">SkoolClass · 레이드 이펙트</p>
    <h1>어느 쪽을, 어느 프레임까지</h1>
    <p class="lede">위 두 줄이 재료입니다 — <b>지금 쓰는 것</b>과 <b>새로 구운 것</b>의 낱장.
      낱장을 <b>누르면</b> 아래 <b>만든 것</b> 끝에 붙고, <b>끌어다 놓으면</b> 원하는 자리에 꽂힙니다.
      쌓인 낱장끼리도 끌어서 순서를 바꿉니다(◀▶×도 그대로 됩니다).
      <b>양쪽을 섞어도 됩니다</b> — 지금 것 0번으로 시작해 새것 2·3번으로 잇는 식으로.
      거의 빈 장은 <b>빔</b>으로 표시해뒀습니다. 배경은 위 도구줄에서 바꿉니다.</p>
  </header>

  <div class="toolbar">
    <span class="lbl">한번에</span>
    <button type="button" id="allnew">전부 새것으로</button>
    <button type="button" id="allold">전부 지금 것으로</button>
    <button type="button" id="droplast">마지막 장 빼기</button>
    <button type="button" id="dropblank">빈 장 빼기</button>
    <button type="button" id="reset">전부 비우기</button>
    <span class="lbl" style="margin-left:8px">배경</span>
    <button type="button" data-bg="checker" aria-pressed="true">체커</button>
    <button type="button" data-bg="dark" aria-pressed="false">어두움</button>
    <button type="button" data-bg="light" aria-pressed="false">밝음</button>
    <button type="button" data-bg="grey" aria-pressed="false">회색</button>
    <button type="button" data-bg="page" aria-pressed="false">배경 없음</button>
    <span class="lbl" style="margin-left:8px">재생</span>
    <button type="button" id="slower">느리게</button>
    <button type="button" id="faster">빠르게</button>
    <span class="mono" id="speed">150ms</span>
  </div>

  <section class="list">${cards.map(card).join('')}</section>

  <div class="out">
    <div class="out-top">
      <b>손댄 항목 <span class="mono" id="ccut">0</span>개 · 섞은 것 <span class="mono" id="cmix">0</span>개</b>
      <span class="spacer"></span>
      <button type="button" id="copy">목록 복사</button>
    </div>
    <textarea id="list" readonly aria-label="결정 목록"></textarea>
    <p class="tip">지금 것을 그대로 두는 항목은 목록에 안 나옵니다. <b>old0</b>은 지금 것의 0번 장, <b>new2</b>는 새것의 2번 장입니다. 브라우저에 저장됩니다.</p>
  </div>

  <div class="modal" id="editor" hidden>
    <div class="sheet">
      <h2>지우기 <small id="etitle"></small></h2>
      <div class="canvaswrap"><canvas id="ecanvas"></canvas></div>
      <div class="etools">
        <button type="button" id="tbrush" aria-pressed="true">동그란 지우개</button>
        <button type="button" id="tbox" aria-pressed="false">네모 지우개</button>
        <label class="mono" style="font-size:12px">굵기 <input type="range" id="esize" min="2" max="40" value="10" /> <span id="esizev">10</span>px</label>
        <span class="grow"></span>
        <button type="button" id="eundo">한 번 되돌리기</button>
        <button type="button" id="ereset">처음으로</button>
        <button type="button" id="edone">적용</button>
      </div>
      <p class="ehint">칠하듯 끌면 그 부분이 투명해집니다. 지운 자국은 좌표로 기록돼서 실제 gif를 만들 때 똑같이 적용됩니다 — 원본 파일은 그대로 둡니다.</p>
    </div>
  </div>

  <footer>낱장 밑 숫자 · 왼쪽이 프레임 번호, 오른쪽이 그 장에서 칠해진 면적입니다. 면적이 갑자기 튀는 장이 대개 튀는 그 장입니다.</footer>
</div>

<script>
  const KEY = 'skoolclass-fx-mix';
  const items = [...document.querySelectorAll('.item')];
  let delay = 150;
  const timers = new Map();

  const trackOf = (item, side) => item.querySelector('.track[data-side="' + side + '"]');
  const btnsOf = (item, side) => [...trackOf(item, side).querySelectorAll('.fr')];
  const srcImg = (item, side, i) => btnsOf(item, side)[i].querySelector('img').src;
  const seqBox = item => item.querySelector('[data-seq]');
  const seqOf = item => [...seqBox(item).children].map(el => ({ side: el.dataset.side, i: +el.dataset.i }));
  const asText = f => (f.side === 'old' ? 'old' : 'new') + f.i;

  // the untouched state for an item is "the current gif, every frame, in order"
  function isDefault(item) {
    const q = seqOf(item), n = +item.dataset.nold;
    if (q.length !== n) return false;
    return q.every((f, k) => f.side === 'old' && f.i === k);
  }

  function loop(item, side, key, getSrcs) {
    const img = side ? trackOf(item, side).querySelector('[data-play]') : item.querySelector('[data-play-seq]');
    const srcs = getSrcs();
    clearInterval(timers.get(key));
    if (!srcs.length) { img.removeAttribute('src'); return; }
    let i = 0; img.src = srcs[0];
    timers.set(key, setInterval(function () { i = (i + 1) % srcs.length; img.src = srcs[i]; }, delay));
  }

  function playAll(item) {
    ['old', 'new'].forEach(function (side) {
      loop(item, side, side + '|' + item.dataset.id, function () {
        return btnsOf(item, side).map(b => b.querySelector('img').src);
      });
    });
    loop(item, null, 'seq|' + item.dataset.id, function () {
      return seqOf(item).map(f => srcImg(item, f.side, f.i));
    });
  }

  function makeSlot(item, side, i) {
    const el = document.createElement('div');
    el.className = 'slot' + (side === 'old' ? ' from-old' : '');
    el.dataset.side = side; el.dataset.i = String(i);
    el.draggable = true;
    el.addEventListener('dragstart', function (e) {
      dragging = { kind: 'move', el: el, item: item };
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', 'move'); } catch (err) {}
    });
    el.addEventListener('dragend', function () { el.classList.remove('dragging'); clearMark(); dragging = null; });
    const grip = document.createElement('span');
    grip.className = 'grip'; grip.textContent = '⠿';
    el.appendChild(grip);
    const img = document.createElement('img');
    img.src = srcImg(item, side, i); img.alt = side + i;
    const src = document.createElement('span');
    src.className = 'src'; src.textContent = (side === 'old' ? '지금' : '새') + i;
    const ops = document.createElement('div');
    ops.className = 'ops';
    [['◀', -1], ['▶', 1], ['×', 0]].forEach(function (pair) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = pair[0];
      if (pair[1] === 0) b.className = 'x';
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        const box = seqBox(item);
        if (pair[1] === 0) { el.remove(); }
        else if (pair[1] === -1 && el.previousElementSibling) { box.insertBefore(el, el.previousElementSibling); }
        else if (pair[1] === 1 && el.nextElementSibling) { box.insertBefore(el.nextElementSibling, el); }
        refresh();
      });
      ops.appendChild(b);
    });
    el.append(img, src, ops);
    return el;
  }

  function setSeq(item, frames) {
    const box = seqBox(item);
    box.textContent = '';
    frames.forEach(function (f) { box.appendChild(makeSlot(item, f.side, f.i)); });
  }

  function fillFrom(item, side) {
    const n = side === 'old' ? +item.dataset.nold : +item.dataset.nnew;
    setSeq(item, Array.from({ length: n }, function (_, i) { return { side: side, i: i }; }));
  }

  function refresh() {
    let touched = 0, mixed = 0;
    const lines = [];
    items.forEach(function (item) {
      const q = seqOf(item);
      item.querySelector('[data-seqcount]').textContent = q.length + '장';
      const sides = new Set(q.map(f => f.side));
      const isMix = sides.size > 1;
      const def = isDefault(item);
      item.classList.toggle('use-new', !def);
      if (!def) { touched++; lines.push(item.dataset.id + ' = ' + (q.length ? q.map(asText).join(',') : '(비움)')); }
      if (isMix) mixed++;
      item.querySelector('[data-verdict]').textContent =
        def ? '지금 것 그대로' : (isMix ? '섞음 · ' + q.length + '장' : (sides.has('new') ? '새것 · ' : '지금 것 · ') + q.length + '장');
      playAll(item);
    });
    document.getElementById('ccut').textContent = touched;
    document.getElementById('cmix').textContent = mixed;
    const NL = String.fromCharCode(10);
    const el = (typeof eraseLines === 'function') ? eraseLines() : [];
    const all = lines.concat(el);
    document.getElementById('list').value = all.length ? all.join(NL) : '(전부 지금 것을 그대로 둡니다)';
    const save = {};
    items.forEach(function (it) { save[it.dataset.id] = seqOf(it); });
    try { localStorage.setItem(KEY, JSON.stringify(save)); } catch (e) {}
  }

  // ── 끌어놓기 ──────────────────────────────────────────────────────────
  let dragging = null;
  let mark = null;
  function clearMark() { if (mark && mark.parentNode) mark.remove(); mark = null; }
  function markAt(box, x) {
    if (!mark) { mark = document.createElement('div'); mark.className = 'drop-mark'; }
    const slots = [...box.children].filter(c => c.classList.contains('slot') && !c.classList.contains('dragging'));
    let before = null;
    for (const sl of slots) {
      const r = sl.getBoundingClientRect();
      if (x < r.left + r.width / 2) { before = sl; break; }
    }
    if (before) box.insertBefore(mark, before); else box.appendChild(mark);
  }

  function wireDrop(item) {
    const box = seqBox(item);
    box.addEventListener('dragover', function (e) {
      if (!dragging || dragging.item !== item) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = dragging.kind === 'move' ? 'move' : 'copy';
      box.classList.add('over');
      markAt(box, e.clientX);
    });
    box.addEventListener('dragleave', function (e) {
      if (e.target === box) { box.classList.remove('over'); clearMark(); }
    });
    box.addEventListener('drop', function (e) {
      if (!dragging || dragging.item !== item) return;
      e.preventDefault();
      box.classList.remove('over');
      const el = dragging.kind === 'move' ? dragging.el : makeSlot(item, dragging.side, dragging.i);
      if (mark && mark.parentNode === box) box.insertBefore(el, mark); else box.appendChild(el);
      clearMark();
      dragging = null;
      refresh();
    });
  }

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}

  items.forEach(function (item) {
    wireDrop(item);
    ['old', 'new'].forEach(function (side) {
      btnsOf(item, side).forEach(function (b, i) {
        b.addEventListener('click', function () {
          seqBox(item).appendChild(makeSlot(item, side, i));
          refresh();
        });
        b.addEventListener('dragstart', function (e) {
          dragging = { kind: 'add', side: side, i: i, item: item };
          b.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'copy';
          try { e.dataTransfer.setData('text/plain', side + i); } catch (err) {}
        });
        b.addEventListener('dragend', function () { b.classList.remove('dragging'); clearMark(); dragging = null; });
      });
    });
    item.querySelectorAll('[data-fill]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.fill === 'clear') setSeq(item, []);
        else fillFrom(item, b.dataset.fill);
        refresh();
      });
    });
    const sv = saved[item.dataset.id];
    if (Array.isArray(sv) && sv.length) setSeq(item, sv);
    else fillFrom(item, 'old');
  });

  document.getElementById('allnew').addEventListener('click', function () {
    items.forEach(function (it) { fillFrom(it, 'new'); }); refresh();
  });
  document.getElementById('allold').addEventListener('click', function () {
    items.forEach(function (it) { fillFrom(it, 'old'); }); refresh();
  });
  document.getElementById('reset').addEventListener('click', function () {
    items.forEach(function (it) { setSeq(it, []); }); refresh();
  });
  document.getElementById('droplast').addEventListener('click', function () {
    items.forEach(function (it) { const q = seqOf(it); if (q.length > 1) setSeq(it, q.slice(0, -1)); }); refresh();
  });
  document.getElementById('dropblank').addEventListener('click', function () {
    items.forEach(function (it) {
      const q = seqOf(it).filter(function (f) {
        return !btnsOf(it, f.side)[f.i].classList.contains('blank');
      });
      setSeq(it, q);
    });
    refresh();
  });

  function setSpeed(d) {
    delay = Math.max(60, Math.min(600, d));
    document.getElementById('speed').textContent = delay + 'ms';
    items.forEach(playAll);
  }
  document.getElementById('slower').addEventListener('click', function () { setSpeed(delay + 40); });
  document.getElementById('faster').addEventListener('click', function () { setSpeed(delay - 40); });

  const bgb = [...document.querySelectorAll('[data-bg]')];
  bgb.forEach(function (b) {
    b.addEventListener('click', function () {
      bgb.forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
      if (b.dataset.bg === 'checker') document.body.removeAttribute('data-bg');
      else document.body.setAttribute('data-bg', b.dataset.bg);
    });
  });

  // ── 지우개 ────────────────────────────────────────────────────────────
  // 지운 자국은 이미지가 아니라 '좌표 기록'으로 남긴다. 그래야 목록에 글자로 담겨
  // 나가고, mix_frames.mjs 가 같은 자국을 원본 프레임에 그대로 다시 적용할 수 있다.
  const EKEY = 'skoolclass-fx-erase';
  let erase = {};
  try { erase = JSON.parse(localStorage.getItem(EKEY) || '{}'); } catch (e) {}

  const eKeyOf = (item, side, i) => item.dataset.id + '|' + side + i;
  const modal = document.getElementById('editor');
  const cv = document.getElementById('ecanvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let ed = null;

  function strokesFor(item, side, i) { return erase[eKeyOf(item, side, i)] || []; }

  function applyStrokes(canvas, strokes) {
    const c = canvas.getContext('2d');
    c.save();
    c.globalCompositeOperation = 'destination-out';
    for (const st of strokes) {
      c.beginPath();
      if (st.t === 'r') c.rect(st.x, st.y, st.w, st.h);
      else c.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  function renderEdited(item, side, i, cb2) {
    const btn = btnsOf(item, side)[i];
    const img = btn.querySelector('img');
    const strokes = strokesFor(item, side, i);
    const base = new Image();
    base.onload = function () {
      const c = document.createElement('canvas');
      c.width = base.width; c.height = base.height;
      c.getContext('2d').drawImage(base, 0, 0);
      if (strokes.length) applyStrokes(c, strokes);
      const url = c.toDataURL('image/png');
      img.src = url;
      btn.classList.toggle('edited', strokes.length > 0);
      const eb = btn.parentNode.querySelector('.edit');
      if (eb) eb.classList.toggle('on', strokes.length > 0);
      if (cb2) cb2();
    };
    base.src = img.dataset.orig;
  }

  function openEditor(item, side, i) {
    const btn = btnsOf(item, side)[i];
    const base = new Image();
    base.onload = function () {
      const zoom = Math.max(1, Math.min(5, Math.floor(460 / base.width)));
      cv.width = base.width; cv.height = base.height;
      cv.style.width = base.width * zoom + 'px';
      cv.style.height = base.height * zoom + 'px';
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(base, 0, 0);
      ed = { item: item, side: side, i: i, base: base, zoom: zoom, strokes: strokesFor(item, side, i).slice() };
      applyStrokes(cv, ed.strokes);
      document.getElementById('etitle').textContent =
        item.dataset.id + ' · ' + (side === 'old' ? '지금' : '새') + i + ' · ' + base.width + '×' + base.height;
      modal.hidden = false;
    };
    base.src = btn.querySelector('img').dataset.orig;
  }

  function redrawEditor() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(ed.base, 0, 0);
    applyStrokes(cv, ed.strokes);
  }

  let tool = 'c', size = 10, painting = false, boxStart = null;
  const posOf = e => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / ed.zoom, y: (e.clientY - r.top) / ed.zoom };
  };
  const round = v => Math.round(v * 10) / 10;

  cv.addEventListener('pointerdown', function (e) {
    if (!ed) return;
    cv.setPointerCapture(e.pointerId);
    const p = posOf(e);
    if (tool === 'r') { boxStart = p; }
    else { painting = true; ed.strokes.push({ t: 'c', x: round(p.x), y: round(p.y), r: size / 2 }); redrawEditor(); }
  });
  cv.addEventListener('pointermove', function (e) {
    if (!ed || !painting || tool !== 'c') return;
    const p = posOf(e);
    ed.strokes.push({ t: 'c', x: round(p.x), y: round(p.y), r: size / 2 });
    redrawEditor();
  });
  cv.addEventListener('pointerup', function (e) {
    if (!ed) return;
    if (tool === 'r' && boxStart) {
      const p = posOf(e);
      const x = Math.min(boxStart.x, p.x), y = Math.min(boxStart.y, p.y);
      const w = Math.abs(p.x - boxStart.x), h = Math.abs(p.y - boxStart.y);
      if (w > 0.5 && h > 0.5) { ed.strokes.push({ t: 'r', x: round(x), y: round(y), w: round(w), h: round(h) }); redrawEditor(); }
      boxStart = null;
    }
    painting = false;
  });

  document.getElementById('tbrush').addEventListener('click', function () {
    tool = 'c'; this.setAttribute('aria-pressed', 'true'); document.getElementById('tbox').setAttribute('aria-pressed', 'false');
  });
  document.getElementById('tbox').addEventListener('click', function () {
    tool = 'r'; this.setAttribute('aria-pressed', 'true'); document.getElementById('tbrush').setAttribute('aria-pressed', 'false');
  });
  document.getElementById('esize').addEventListener('input', function () {
    size = +this.value; document.getElementById('esizev').textContent = this.value;
  });
  document.getElementById('eundo').addEventListener('click', function () {
    if (!ed || !ed.strokes.length) return;
    // a brush drag lands as many dots -- drop the whole run in one go
    const last = ed.strokes[ed.strokes.length - 1];
    if (last.t === 'r') ed.strokes.pop();
    else { while (ed.strokes.length && ed.strokes[ed.strokes.length - 1].t === 'c') ed.strokes.pop(); }
    redrawEditor();
  });
  document.getElementById('ereset').addEventListener('click', function () { if (ed) { ed.strokes = []; redrawEditor(); } });
  document.getElementById('edone').addEventListener('click', function () {
    if (!ed) { modal.hidden = true; return; }
    const k = eKeyOf(ed.item, ed.side, ed.i);
    if (ed.strokes.length) erase[k] = ed.strokes; else delete erase[k];
    try { localStorage.setItem(EKEY, JSON.stringify(erase)); } catch (e) {}
    const it = ed.item, sd = ed.side, ix = ed.i;
    modal.hidden = true; ed = null;
    renderEdited(it, sd, ix, function () {
      // sequence slots reuse the source image, so rebuild them from the strip
      const q = seqOf(it); setSeq(it, q); refresh();
    });
  });
  modal.addEventListener('click', function (e) { if (e.target === modal) { modal.hidden = true; ed = null; } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) { modal.hidden = true; ed = null; } });

  items.forEach(function (item) {
    ['old', 'new'].forEach(function (side) {
      trackOf(item, side).querySelectorAll('[data-edit]').forEach(function (b) {
        b.addEventListener('click', function (e) { e.stopPropagation(); openEditor(item, side, +b.dataset.edit); });
      });
      btnsOf(item, side).forEach(function (_, i) {
        if (strokesFor(item, side, i).length) renderEdited(item, side, i);
      });
    });
  });

  function eraseLines() {
    const out = [];
    Object.keys(erase).forEach(function (k) {
      const st = erase[k];
      if (!st || !st.length) return;
      const parts = k.split('|');
      const txt = st.map(function (v) {
        return v.t === 'r' ? 'r' + v.x + ',' + v.y + ',' + v.w + ',' + v.h : 'c' + v.x + ',' + v.y + ',' + v.r;
      }).join(' ');
      out.push('  erase ' + parts[1] + ' @ ' + parts[0] + ' : ' + txt);
    });
    return out;
  }

  const cb = document.getElementById('copy'), le = document.getElementById('list');
  cb.addEventListener('click', function () {
    const done = function (m) { cb.textContent = m; setTimeout(function () { cb.textContent = '목록 복사'; }, 1700); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(le.value).then(function () { done('복사했습니다'); })
        .catch(function () { le.removeAttribute('readonly'); le.select(); done('직접 복사하세요'); });
    } else { le.removeAttribute('readonly'); le.select(); done('직접 복사하세요'); }
  });

  refresh();
</script>
`;

fs.writeFileSync(OUT, html);
const nf = cards.reduce((n, c) => n + c.old.length + c.neu.length, 0);
console.log('wrote ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + 'KB) · ' + cards.length + '항목 · 프레임 ' + nf + '장');
