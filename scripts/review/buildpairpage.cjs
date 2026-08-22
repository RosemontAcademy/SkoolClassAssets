const fs = require('fs');
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const OUT = process.argv[3];
const FXD = 'E:/Projects/skoolclass-pro/SkoolClassAssets/skillFX/';

const NAMES = {
  '6-charizard': '리자몽', '7-squirtle': '꼬부기', '8-wartortle': '어니부기',
  '13-weedle': '뿔充', '15-beedrill': '독침붕', '17-pidgeotto': '피죤', '18-pidgeot': '피죤투',
  '19-rattata': '꼬렛', '20-raticate': '레트라', '21-spearow': '깨비참', '22-fearow': '깨비드릴조',
  '24-arbok': '아보크', '27-sandshrew': '모래두지', '28-sandslash': '고지',
  '37-vulpix': '식스테일', '38-ninetales': '나인테일', '41-zubat': '주바트', '42-golbat': '골뱃',
};
const b64 = p => fs.readFileSync(p).toString('base64');
const dexOf = k => parseInt(k, 10);

rows.sort((a, b) => dexOf(a.dir) - dexOf(b.dir) || a.kind.localeCompare(b.kind));

const badge = s => s.flags.length
  ? `<span class="mark bad">${s.flags.join(' · ')}</span>`
  : `<span class="mark ok">이상 없음</span>`;

const card = r => {
  const id = r.dir + ' ' + r.kind;
  const oldB = b64(FXD + r.dir + '/' + r.dir + '-' + r.kind + '-fx.gif');
  const newB = b64(FXD + r.dir + '/' + r.dir + '-' + r.kind + '-fx-v2.gif');
  const stat = s => `${s.frames}장 · ${s.grow.toFixed(1)}배 · 덩어리 ${s.blobs}`;
  return `
      <article class="pair" data-id="${id}">
        <header>
          <span class="nm">${NAMES[r.dir] || r.dir}</span>
          <span class="kd mono">${r.kind}</span>
          <span class="dx mono">${r.dir}</span>
        </header>
        <div class="two">
          <figure>
            <div class="frame"><img src="data:image/gif;base64,${oldB}" alt="옛것" loading="lazy" /></div>
            <figcaption><b>지금 쓰는 것</b><span class="mono">${stat(r.old)}</span>${badge(r.old)}</figcaption>
          </figure>
          <figure>
            <div class="frame"><img src="data:image/gif;base64,${newB}" alt="새것" loading="lazy" /></div>
            <figcaption><b>새로 구운 것</b><span class="mono">${stat(r.neu)}</span>${badge(r.neu)}</figcaption>
          </figure>
        </div>
        <div class="choice" role="radiogroup" aria-label="${id} 선택">
          <button type="button" data-v="new">새것 쓰기</button>
          <button type="button" data-v="keep" aria-pressed="true">지금 것 두기</button>
          <button type="button" data-v="redo">다시 굽기</button>
        </div>
      </article>`;
};

const html = `<title>새로 구운 것 고르기</title>
<style>
  :root{
    --ground:#F4F5F2; --surface:#FFFFFF; --line:#DFE2DA; --ink:#191C17; --muted:#666B60;
    --accent:#2F6B45; --pick:#1F5A38; --redo:#9A4A1B; --bad:#9A3412; --ok:#3F6212;
    --cell:#242720; --cell-alt:#2E3129;
    --shadow:0 1px 2px rgba(25,28,23,.06),0 10px 26px rgba(25,28,23,.05);
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --ground:#111310; --surface:#1A1D18; --line:#2C3028; --ink:#E9EDE5; --muted:#98A08F;
      --accent:#6FCB93; --pick:#8BE0AC; --redo:#EE9A5E; --bad:#F0895C; --ok:#A3C165;
      --cell:#0A0C09; --cell-alt:#121510;
      --shadow:0 1px 2px rgba(0,0,0,.45),0 12px 30px rgba(0,0,0,.4);
    }
  }
  :root[data-theme="dark"]{
    --ground:#111310; --surface:#1A1D18; --line:#2C3028; --ink:#E9EDE5; --muted:#98A08F;
    --accent:#6FCB93; --pick:#8BE0AC; --redo:#EE9A5E; --bad:#F0895C; --ok:#A3C165;
    --cell:#0A0C09; --cell-alt:#121510;
    --shadow:0 1px 2px rgba(0,0,0,.45),0 12px 30px rgba(0,0,0,.4);
  }
  *{box-sizing:border-box}
  body{margin:0; background:var(--ground); color:var(--ink);
    font-family:"Pretendard","Malgun Gothic","Apple SD Gothic Neo","Segoe UI",system-ui,sans-serif;
    font-size:15px; line-height:1.6; -webkit-font-smoothing:antialiased}
  .mono{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; font-variant-numeric:tabular-nums}
  .wrap{max-width:1150px; margin:0 auto; padding:40px 22px 40px; display:flex; flex-direction:column; gap:26px}
  .eyebrow{margin:0; font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); font-weight:700}
  h1{margin:6px 0 0; font-size:clamp(27px,4.2vw,38px); line-height:1.15; letter-spacing:-.02em; font-weight:800; text-wrap:balance}
  .lede{margin:10px 0 0; max-width:64ch; color:var(--muted); font-size:16px}

  .stats{display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:1px;
    background:var(--line); border:1px solid var(--line); border-radius:14px; overflow:hidden}
  .stat{background:var(--surface); padding:14px 16px; display:flex; flex-direction:column; gap:2px}
  .stat b{font-size:24px; font-weight:800; letter-spacing:-.02em}
  .stat span{font-size:12px; color:var(--muted)}

  .toolbar{display:flex; gap:9px; flex-wrap:wrap; align-items:center}
  .toolbar span{font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; font-weight:700}
  button{font:inherit; font-size:13px; font-weight:700; color:var(--ink); background:var(--surface);
    border:1px solid var(--line); border-radius:8px; padding:7px 13px; cursor:pointer}
  button:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
  button[aria-pressed="true"]{background:var(--accent); border-color:var(--accent); color:#fff}

  .grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:15px}
  .pair{background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:13px;
    display:flex; flex-direction:column; gap:10px; box-shadow:var(--shadow)}
  .pair.is-new{border-color:var(--pick)}
  .pair.is-redo{border-color:var(--redo)}
  .pair header{display:flex; align-items:baseline; gap:8px; flex-wrap:wrap}
  .nm{font-weight:800; font-size:15px; letter-spacing:-.01em}
  .kd{font-size:11.5px; color:var(--muted)}
  .dx{font-size:10.5px; color:var(--muted); opacity:.7; margin-left:auto}

  .two{display:grid; grid-template-columns:1fr 1fr; gap:10px}
  .two figure{margin:0; display:flex; flex-direction:column; gap:6px}
  .frame{aspect-ratio:1; border-radius:9px; overflow:hidden; display:grid; place-items:center;
    background-color:var(--cell); border:1px solid var(--line);
    background-image:linear-gradient(45deg,var(--cell-alt) 25%,transparent 25%,transparent 75%,var(--cell-alt) 75%),
                     linear-gradient(45deg,var(--cell-alt) 25%,transparent 25%,transparent 75%,var(--cell-alt) 75%);
    background-size:16px 16px; background-position:0 0,8px 8px}
  .frame img{width:calc(100% * var(--zoom,1)); height:calc(100% * var(--zoom,1));
    object-fit:contain; image-rendering:pixelated; display:block}
  figcaption{display:flex; flex-direction:column; gap:2px; font-size:11.5px}
  figcaption b{font-size:12px; font-weight:800}
  figcaption .mono{color:var(--muted); font-size:10.5px}
  .mark{font-size:10.5px; font-weight:700; border-radius:5px; padding:1px 6px; align-self:flex-start; border:1px solid}
  .mark.bad{color:var(--bad); border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
  .mark.ok{color:var(--ok); border-color:color-mix(in srgb,var(--ok) 35%,transparent)}
  body.hide-marks .mark{display:none}

  .choice{display:flex; gap:6px}
  .choice button{flex:1; padding:7px 4px; font-size:12px}
  .choice button[data-v="new"][aria-pressed="true"]{background:var(--pick); border-color:var(--pick); color:#08110C}
  .choice button[data-v="redo"][aria-pressed="true"]{background:var(--redo); border-color:var(--redo); color:#fff}

  .out{position:sticky; bottom:0; z-index:20;
    background:color-mix(in srgb,var(--surface) 94%,transparent); backdrop-filter:blur(10px);
    border:1px solid var(--line); border-radius:14px; padding:14px 16px; box-shadow:var(--shadow);
    display:flex; flex-direction:column; gap:10px}
  .out-top{display:flex; align-items:center; gap:14px; flex-wrap:wrap}
  .tally{font-size:14px; font-weight:800}
  .tally i{font-style:normal; font-family:ui-monospace,Consolas,monospace}
  .out-top .spacer{flex:1}
  .out textarea{width:100%; min-height:84px; resize:vertical; font-family:ui-monospace,Consolas,monospace;
    font-size:12px; line-height:1.5; color:var(--ink); background:var(--ground);
    border:1px solid var(--line); border-radius:9px; padding:9px 11px}
  .out .tip{margin:0; font-size:12px; color:var(--muted)}
  footer{color:var(--muted); font-size:12.5px; border-top:1px solid var(--line); padding-top:14px}
  @media (prefers-reduced-motion:reduce){*{animation:none!important; transition:none!important}}
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">SkoolClass · 레이드 이펙트</p>
    <h1>다시 구운 25개, 전후 비교</h1>
    <p class="lede">왼쪽이 지금 게임에 쓰이는 것, 오른쪽이 새로 구운 것입니다. <b>프롬프트는 하나도 바꾸지 않고</b>
      그대로 다시 구웠습니다. 각 칸 아래에서 골라주세요 — 아무것도 안 누르면 <b>지금 것을 그대로 둡니다</b>.</p>
  </header>

  <div class="stats">
    <div class="stat"><b class="mono">25</b><span>다시 구운 항목</span></div>
    <div class="stat"><b class="mono">25/25</b><span>생성 성공</span></div>
    <div class="stat"><b class="mono">~700</b><span>쓴 생성량</span></div>
    <div class="stat"><b class="mono">1,195</b><span>이번 달 남음</span></div>
  </div>

  <div class="toolbar">
    <span>확대</span>
    <button type="button" data-zoom="1" aria-pressed="true">1배</button>
    <button type="button" data-zoom="2" aria-pressed="false">2배</button>
    <button type="button" data-zoom="3" aria-pressed="false">3배</button>
    <span style="margin-left:8px">표시</span>
    <button type="button" id="marks" aria-pressed="false">자동검사 끄기</button>
    <span style="margin-left:8px">한번에</span>
    <button type="button" id="allnew">전부 새것</button>
    <button type="button" id="allkeep">전부 지금 것</button>
  </div>

  <section class="grid">${rows.map(card).join('')}</section>

  <div class="out">
    <div class="out-top">
      <span class="tally">새것 <i id="c-new">0</i> · 지금 것 <i id="c-keep">25</i> · 다시 <i id="c-redo">0</i></span>
      <span class="spacer"></span>
      <button type="button" id="copy">목록 복사</button>
    </div>
    <textarea id="list" readonly aria-label="결정 목록"></textarea>
    <p class="tip">고른 것은 이 브라우저에 저장됩니다. 복사해서 주시면 그대로 반영합니다.</p>
  </div>

  <footer>숫자 읽는 법 · <b>N장</b>은 프레임 수, <b>N배</b>는 첫 프레임 스프라이트 대비 칠해진 면적, <b>덩어리</b>는 캐릭터만 한 덩이의 개수(2 이상이면 복제 의심). 새것은 모두 5프레임으로 나왔습니다.</footer>
</div>

<script>
  const zb = [...document.querySelectorAll('[data-zoom]')];
  zb.forEach(b => b.addEventListener('click', () => {
    zb.forEach(o => o.setAttribute('aria-pressed', String(o === b)));
    document.documentElement.style.setProperty('--zoom', b.dataset.zoom);
  }));
  const mk = document.getElementById('marks');
  mk.addEventListener('click', () => {
    const on = mk.getAttribute('aria-pressed') !== 'true';
    mk.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('hide-marks', on);
  });

  const KEY = 'skoolclass-fx-pair-choice';
  const cards = [...document.querySelectorAll('.pair')];
  const state = {};
  try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) {}

  function paint(card) {
    const id = card.dataset.id, v = state[id] || 'keep';
    card.classList.toggle('is-new', v === 'new');
    card.classList.toggle('is-redo', v === 'redo');
    card.querySelectorAll('.choice button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.v === v));
    });
  }

  function render() {
    const nw = [], rd = [];
    cards.forEach(function (c) {
      const v = state[c.dataset.id] || 'keep';
      if (v === 'new') nw.push(c.dataset.id);
      if (v === 'redo') rd.push(c.dataset.id);
      paint(c);
    });
    document.getElementById('c-new').textContent = nw.length;
    document.getElementById('c-redo').textContent = rd.length;
    document.getElementById('c-keep').textContent = cards.length - nw.length - rd.length;
    const NL = String.fromCharCode(10);
    let t = '';
    if (nw.length) t += '# 새것으로 바꿀 것' + NL + nw.join(NL) + NL;
    if (rd.length) t += (t ? NL : '') + '# 다시 구울 것' + NL + rd.join(NL) + NL;
    document.getElementById('list').value = t || '(전부 지금 것을 유지합니다)';
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  cards.forEach(function (c) {
    c.querySelectorAll('.choice button').forEach(function (b) {
      b.addEventListener('click', function () { state[c.dataset.id] = b.dataset.v; render(); });
    });
  });
  document.getElementById('allnew').addEventListener('click', function () {
    cards.forEach(function (c) { state[c.dataset.id] = 'new'; }); render();
  });
  document.getElementById('allkeep').addEventListener('click', function () {
    cards.forEach(function (c) { state[c.dataset.id] = 'keep'; }); render();
  });

  const cb = document.getElementById('copy'), le = document.getElementById('list');
  cb.addEventListener('click', function () {
    const done = function (m) { cb.textContent = m; setTimeout(function () { cb.textContent = '목록 복사'; }, 1700); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(le.value).then(function () { done('복사했습니다'); })
        .catch(function () { le.removeAttribute('readonly'); le.select(); done('직접 복사하세요'); });
    } else { le.removeAttribute('readonly'); le.select(); done('직접 복사하세요'); }
  });

  render();
</script>
`;

fs.writeFileSync(OUT, html);
console.log('wrote ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + 'KB), ' + rows.length + '쌍');
