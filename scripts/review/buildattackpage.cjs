const fs = require('fs');
const { GifReader } = require('E:/Projects/skoolclass-pro/node_modules/omggif');

const FXD = 'E:/Projects/skoolclass-pro/SkoolClassAssets/skillFX/';
const a1 = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));   // attackaudit.json
const a2 = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));   // attackaudit2.json
const OUT = process.argv[4];

const NAMES = {
  '1-bulbasaur': '이상해씨', '2-ivysaur': '이상해풀', '3-venusaur': '이상해꽃',
  '4-charmander': '파이리', '5-charmeleon': '리자드', '6-charizard': '리자몽',
  '7-squirtle': '꼬부기', '8-wartortle': '어니부기', '9-blastoise': '거북왕',
  '10-caterpie': '캐터피', '11-metapod': '단데기', '12-butterfree': '버터플',
  '13-weedle': '뿔충', '14-kakuna': '딱충이', '15-beedrill': '독침붕',
  '16-pidgey': '구구', '17-pidgeotto': '피죤', '18-pidgeot': '피죤투',
  '19-rattata': '꼬렛', '20-raticate': '레트라', '21-spearow': '깨비참', '22-fearow': '깨비드릴조',
  '23-ekans': '아보', '24-arbok': '아보크', '27-sandshrew': '모래두지', '28-sandslash': '고지',
  '37-vulpix': '식스테일', '38-ninetales': '나인테일',
  '41-zubat': '주바트', '42-golbat': '골뱃', '169-crobat': '크로뱃',
};
const SKILLS = {
  '1-bulbasaur': 'Vine Whip', '2-ivysaur': 'Razor Leaf', '3-venusaur': 'Solar Beam',
  '4-charmander': 'Ember', '5-charmeleon': 'Flamethrower', '6-charizard': 'Fire Blast',
  '7-squirtle': 'Water Gun', '8-wartortle': 'Water Pulse', '9-blastoise': 'Hydro Pump',
  '10-caterpie': 'String Shot', '11-metapod': 'Harden', '12-butterfree': 'Confusion',
  '13-weedle': 'Poison Sting', '14-kakuna': 'Harden', '15-beedrill': 'Twineedle',
  '16-pidgey': 'Gust', '17-pidgeotto': 'Wing Attack', '18-pidgeot': 'Hurricane',
  '19-rattata': 'Quick Attack', '20-raticate': 'Hyper Fang', '21-spearow': 'Peck', '22-fearow': 'Drill Peck',
  '23-ekans': 'Wrap', '24-arbok': 'Gunk Shot', '27-sandshrew': 'Scratch', '28-sandslash': 'Earthquake',
  '37-vulpix': 'Ember', '38-ninetales': 'Fire Blast',
  '41-zubat': 'Leech Life', '42-golbat': 'Air Cutter', '169-crobat': 'Cross Poison',
};
const DEX = k => parseInt(k, 10);

const find = (arr, key, kind) => arr.find(r => r.key === key && r.kind === kind) || {};
const b64 = p => fs.readFileSync(p).toString('base64');

const species = [...new Set(a1.map(r => r.key))].sort((x, y) => DEX(x) - DEX(y));
const cards = [];
for (const key of species) {
  const parts = {};
  for (const kind of ['attack', 'attacked']) {
    const p = FXD + key + '/' + key + '-' + kind + '-fx.gif';
    if (!fs.existsSync(p)) continue;
    const r1 = find(a1, key, kind), r2 = find(a2, key, kind);
    const flags = [];
    if (r2.sprite0Area < 0.02) flags.push('첫 프레임이 빔');
    const wrongCorner = kind === 'attack' ? (r2.anchorX > 0.55 || r2.anchorY < 0.45) : (r2.anchorX < 0.45 || r2.anchorY > 0.55);
    if (wrongCorner && r2.sprite0Area >= 0.02) flags.push('코너 반대');
    if (r2.redraw > 0.28) flags.push('캐릭터 다시 그려짐');
    if ((r1.blobsMax || 0) >= 3) flags.push('복제 의심');
    if ((r1.growMax || 0) > 6) flags.push('이펙트가 삼킴');
    if ((r1.frames || 4) < 4) flags.push('프레임 ' + r1.frames + '장');
    parts[kind] = { b64: b64(p), flags, frames: r1.frames, size: r1.size, grow: r1.growMax, corner: [r2.anchorX, r2.anchorY] };
  }
  cards.push({ key, name: NAMES[key] || key, skill: SKILLS[key] || '', ...parts });
}

const allFlags = cards.flatMap(c => [...(c.attack?.flags || []), ...(c.attacked?.flags || [])]);
const tally = {};
allFlags.forEach(f => tally[f] = (tally[f] || 0) + 1);
const flagged = cards.filter(c => (c.attack?.flags.length || 0) + (c.attacked?.flags.length || 0) > 0).length;

const pane = (p, label, hint, id) => !p ? `<div class="pane empty">없음</div>` : `
          <label class="pane${p.flags.length ? ' flagged' : ''}">
            <input type="checkbox" class="pick" value="${id}" />
            <span class="frame"><img src="data:image/gif;base64,${p.b64}" alt="${label}" loading="lazy" /><span class="tick" aria-hidden="true"></span></span>
            <span class="cap">
              <span class="lbl">${label}</span>
              <span class="hint mono">${hint} · ${p.size} · ${p.frames}장</span>
            </span>
            ${p.flags.length ? `<span class="flags">${p.flags.map(f => `<span>${f}</span>`).join('')}</span>` : ''}
          </label>`;

const card = c => `
      <article class="sp${(c.attack?.flags.length || 0) + (c.attacked?.flags.length || 0) ? ' has-flag' : ''}">
        <header>
          <span class="dex mono">#${DEX(c.key)}</span>
          <span class="nm">${c.name}</span>
          <span class="sk mono">${c.skill}</span>
        </header>
        <div class="panes">
          ${pane(c.attack, 'attack', '학생 자리 · 뒷모습 · ↗', c.key + ' attack')}
          ${pane(c.attacked, 'attacked', '보스 자리 · 앞모습 · ↙', c.key + ' attacked')}
        </div>
      </article>`;

const html = `<title>공격 연출 검수대</title>
<style>
  :root{
    --ground:#F5F4F1; --surface:#FFFFFF; --line:#E3E0D9; --ink:#1D1B16; --muted:#6E6A60;
    --accent:#B4531A; --flag:#9A3412; --ok:#3F6212;
    --cell:#26241F; --cell-alt:#302D27;
    --shadow:0 1px 2px rgba(29,27,22,.06),0 10px 26px rgba(29,27,22,.05);
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --ground:#15140F; --surface:#1E1C17; --line:#312E27; --ink:#EFEBE2; --muted:#A09A8D;
      --accent:#E8863F; --flag:#F0895C; --ok:#A3C165;
      --cell:#0B0A08; --cell-alt:#141210;
      --shadow:0 1px 2px rgba(0,0,0,.45),0 12px 30px rgba(0,0,0,.4);
    }
  }
  :root[data-theme="dark"]{
    --ground:#15140F; --surface:#1E1C17; --line:#312E27; --ink:#EFEBE2; --muted:#A09A8D;
    --accent:#E8863F; --flag:#F0895C; --ok:#A3C165;
    --cell:#0B0A08; --cell-alt:#141210;
    --shadow:0 1px 2px rgba(0,0,0,.45),0 12px 30px rgba(0,0,0,.4);
  }
  *{box-sizing:border-box}
  body{margin:0; background:var(--ground); color:var(--ink);
    font-family:"Pretendard","Malgun Gothic","Apple SD Gothic Neo","Segoe UI",system-ui,sans-serif;
    font-size:15px; line-height:1.6; -webkit-font-smoothing:antialiased}
  .mono{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; font-variant-numeric:tabular-nums}
  .wrap{max-width:1180px; margin:0 auto; padding:40px 22px 72px; display:flex; flex-direction:column; gap:28px}

  .eyebrow{margin:0; font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); font-weight:700}
  h1{margin:6px 0 0; font-size:clamp(28px,4.4vw,40px); line-height:1.15; letter-spacing:-.02em; font-weight:800; text-wrap:balance}
  .lede{margin:10px 0 0; max-width:64ch; color:var(--muted); font-size:16px}

  .stats{display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1px;
    background:var(--line); border:1px solid var(--line); border-radius:14px; overflow:hidden}
  .stat{background:var(--surface); padding:15px 17px; display:flex; flex-direction:column; gap:2px}
  .stat b{font-size:25px; font-weight:800; letter-spacing:-.02em}
  .stat span{font-size:12px; color:var(--muted)}

  .legend{background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:15px 18px; box-shadow:var(--shadow)}
  .legend h2{margin:0 0 8px; font-size:14px; font-weight:800}
  .legend dl{margin:0; display:grid; grid-template-columns:auto 1fr; gap:4px 12px; font-size:13.5px}
  .legend dt{font-family:ui-monospace,Consolas,monospace; font-size:12px; color:var(--flag); font-weight:700; white-space:nowrap}
  .legend dd{margin:0; color:var(--muted)}

  .toolbar{display:flex; gap:9px; flex-wrap:wrap; align-items:center}
  .toolbar span{font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; font-weight:700}
  button{font:inherit; font-size:13px; font-weight:700; color:var(--ink); background:var(--surface);
    border:1px solid var(--line); border-radius:8px; padding:7px 13px; cursor:pointer}
  button[aria-pressed="true"]{background:var(--accent); border-color:var(--accent); color:#fff}
  button:focus-visible{outline:2px solid var(--accent); outline-offset:2px}

  .grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:15px}
  .sp{background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:13px;
    display:flex; flex-direction:column; gap:11px; box-shadow:var(--shadow)}
  .sp.has-flag{border-color:color-mix(in srgb,var(--flag) 45%,var(--line))}
  body.only-flagged .sp:not(.has-flag){display:none}
  .sp header{display:flex; align-items:baseline; gap:8px; flex-wrap:wrap}
  .dex{font-size:11px; color:var(--muted)}
  .nm{font-weight:800; font-size:15px; letter-spacing:-.01em}
  .sk{font-size:11.5px; color:var(--muted)}

  .panes{display:grid; grid-template-columns:1fr 1fr; gap:10px}
  .pane{margin:0; display:flex; flex-direction:column; gap:6px; position:relative; cursor:pointer;
    border-radius:11px; padding:5px; border:1.5px solid transparent; transition:border-color .12s, background .12s}
  .pane:hover{background:color-mix(in srgb,var(--accent) 7%,transparent)}
  .pane.picked{border-color:var(--accent); background:color-mix(in srgb,var(--accent) 11%,transparent)}
  .pane .pick{position:absolute; opacity:0; width:1px; height:1px; pointer-events:none}
  .pane:focus-within{outline:2px solid var(--accent); outline-offset:2px}
  .pane .tick{position:absolute; top:8px; right:8px; width:21px; height:21px; border-radius:50%;
    border:1.5px solid var(--line); background:color-mix(in srgb,var(--surface) 84%,transparent);
    display:grid; place-items:center; pointer-events:none}
  .pane .tick::after{content:"✓"; font-size:12px; font-weight:900; color:transparent; line-height:1}
  .pane.picked .tick{background:var(--accent); border-color:var(--accent)}
  .pane.picked .tick::after{color:#fff}
  .pane .cap{display:flex; flex-direction:column; gap:1px}
  .pane .frame{position:relative}
  .pane.empty{display:grid; place-items:center; color:var(--muted); font-size:12px;
    border:1px dashed var(--line); border-radius:9px; aspect-ratio:1}
  .frame{aspect-ratio:1; border-radius:9px; overflow:hidden; display:grid; place-items:center;
    background-color:var(--cell); border:1px solid var(--line);
    background-image:linear-gradient(45deg,var(--cell-alt) 25%,transparent 25%,transparent 75%,var(--cell-alt) 75%),
                     linear-gradient(45deg,var(--cell-alt) 25%,transparent 25%,transparent 75%,var(--cell-alt) 75%);
    background-size:16px 16px; background-position:0 0,8px 8px}
  .pane.flagged .frame{border-color:color-mix(in srgb,var(--flag) 55%,var(--line))}
  .frame img{width:calc(100% * var(--zoom,1)); height:calc(100% * var(--zoom,1));
    object-fit:contain; image-rendering:pixelated; display:block}
  figcaption{display:flex; flex-direction:column; gap:1px}
  .lbl{font-family:ui-monospace,Consolas,monospace; font-size:12px; font-weight:700}
  .hint{font-size:10.5px; color:var(--muted)}
  .flags{display:flex; flex-wrap:wrap; gap:4px}
  .flags span{font-size:10.5px; font-weight:700; color:var(--flag); border:1px solid color-mix(in srgb,var(--flag) 40%,transparent);
    border-radius:5px; padding:1px 6px}
  body.hide-flags .flags{display:none}
  body.hide-flags .sp.has-flag{border-color:var(--line)}
  body.hide-flags .pane.flagged .frame{border-color:var(--line)}

  .picker{position:sticky; bottom:0; z-index:20; margin-top:6px;
    background:color-mix(in srgb,var(--surface) 94%,transparent); backdrop-filter:blur(10px);
    border:1px solid var(--line); border-radius:14px; padding:14px 16px; box-shadow:var(--shadow);
    display:flex; flex-direction:column; gap:10px}
  .picker-top{display:flex; align-items:center; gap:10px; flex-wrap:wrap}
  .picker-top b{font-size:16px; font-weight:800}
  .picker-top .spacer{flex:1}
  .picker textarea{width:100%; min-height:74px; resize:vertical; font-family:ui-monospace,Consolas,monospace;
    font-size:12px; line-height:1.5; color:var(--ink); background:var(--ground);
    border:1px solid var(--line); border-radius:9px; padding:9px 11px}
  .picker textarea:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
  .picker .tip{font-size:12px; color:var(--muted); margin:0}

  .plain{background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:18px 20px; box-shadow:var(--shadow)}
  .plain h3{margin:0 0 8px; font-size:14px; font-weight:800}
  .plain p{margin:0 0 8px; font-size:14px; color:var(--muted)}
  .plain p:last-child{margin:0}
  h2.sec{margin:0; font-size:13px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:var(--muted)}
  footer{color:var(--muted); font-size:12.5px; border-top:1px solid var(--line); padding-top:15px}
  @media (prefers-reduced-motion:reduce){*{animation:none!important; transition:none!important}}
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">SkoolClass · 레이드 이펙트</p>
    <h1>공격 연출 62개, 한자리에</h1>
    <p class="lede">구운 31종의 <b>attack</b>(학생 자리·뒷모습·오른쪽 위로)과 <b>attacked</b>(보스 자리·앞모습·왼쪽 아래로)를
      전부 재생합니다. <b>마음에 안 드는 것을 눌러서 고르세요.</b> 맨 아래 상자에 목록이 쌓입니다 —
      복사해서 주시면 그것만 다시 굽습니다. 붉은 표시는 자동 검사 결과일 뿐이니
      <b>무시하고 눈으로만 고르셔도 됩니다.</b></p>
  </header>

  <div class="stats">
    <div class="stat"><b class="mono">62</b><span>연출 개수</span></div>
    <div class="stat"><b class="mono">${flagged}종</b><span>자동 검사에 걸림</span></div>
    <div class="stat"><b class="mono">${allFlags.length}건</b><span>지적 사항</span></div>
    <div class="stat"><b class="mono">31</b><span>대상 종</span></div>
  </div>

  <div class="legend">
    <h2>자동 검사가 보는 것</h2>
    <dl>
      <dt>첫 프레임이 빔</dt><dd>애니메이션이 스프라이트에서 시작하지 않음 — 만들기가 실패한 것</dd>
      <dt>코너 반대</dt><dd>attack은 왼쪽 아래, attacked는 오른쪽 위에 서야 하는데 반대쪽에 있음</dd>
      <dt>캐릭터 다시 그려짐</dt><dd>첫 프레임 실루엣 안의 색이 크게 달라짐 — 모델이 캐릭터를 새로 그린 것</dd>
      <dt>복제 의심</dt><dd>캐릭터만 한 덩어리가 세 개 이상 — 빈 canvas를 복제로 채운 것</dd>
      <dt>이펙트가 삼킴</dt><dd>칠해진 면적이 스프라이트의 6배 넘음</dd>
      <dt>프레임 N장</dt><dd>4장이 기본인데 그보다 짧음</dd>
    </dl>
  </div>

  <div class="toolbar">
    <span>확대</span>
    <button type="button" data-zoom="1" aria-pressed="true">1배</button>
    <button type="button" data-zoom="2" aria-pressed="false">2배</button>
    <button type="button" data-zoom="3" aria-pressed="false">3배</button>
    <span style="margin-left:10px">보기</span>
    <button type="button" id="filter" aria-pressed="false">걸린 것만</button>
    <button type="button" id="noflags" aria-pressed="false">검사 표시 끄기</button>
  </div>

  <section class="grid">${cards.map(card).join('')}</section>

  <div class="picker">
    <div class="picker-top">
      <b id="count">0개 고름</b>
      <span class="spacer"></span>
      <button type="button" id="copy">목록 복사</button>
      <button type="button" id="clear">전부 해제</button>
    </div>
    <textarea id="list" readonly aria-label="고른 목록" placeholder="위에서 마음에 안 드는 연출을 눌러 고르세요. 여기에 목록이 쌓입니다."></textarea>
    <p class="tip">고른 것은 이 브라우저에 저장돼 새로고침해도 남습니다.</p>
  </div>

  <h2 class="sec">눈으로만 잡히는 것</h2>
  <div class="plain">
    <h3>기계가 못 보는 세 가지</h3>
    <p><b>돌아선 얼굴.</b> attack은 등을 보이며 오른쪽 위로 공격해야 하는데, 모델이 캐릭터를 앞으로 돌려 얼굴을 보여주며
      공격하게 그리는 일이 잦습니다. 실루엣 색만으로는 앞뒤를 구분할 수 없습니다.</p>
    <p><b>이펙트 방향.</b> attack의 이펙트는 오른쪽 위로, attacked는 왼쪽 아래로 뻗어야 합니다. 방향이 반대여도 면적·색 검사는 통과합니다.</p>
    <p><b>기술다움.</b> 물대포가 물처럼 보이는가, 채찍이 채찍처럼 보이는가 — 이건 재는 방법이 없습니다.</p>
  </div>

  <footer>측정 방법 · 첫 프레임은 패딩된 원본 스프라이트라 기준으로 삼았습니다. 그 실루엣 안의 색이 얼마나 달라졌는지, 칠해진 면적이 몇 배로 늘었는지, 캐릭터만 한 덩어리가 몇 개인지를 프레임마다 재서 가장 나쁜 값을 씁니다.</footer>
</div>

<script>
  const zb = [...document.querySelectorAll('[data-zoom]')];
  zb.forEach(b => b.addEventListener('click', () => {
    zb.forEach(o => o.setAttribute('aria-pressed', String(o === b)));
    document.documentElement.style.setProperty('--zoom', b.dataset.zoom);
  }));
  const f = document.getElementById('filter');
  f.addEventListener('click', () => {
    const on = f.getAttribute('aria-pressed') !== 'true';
    f.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('only-flagged', on);
  });
  const nf = document.getElementById('noflags');
  nf.addEventListener('click', () => {
    const on = nf.getAttribute('aria-pressed') !== 'true';
    nf.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('hide-flags', on);
  });

  const KEY = 'skoolclass-fx-redo';
  const boxes = [...document.querySelectorAll('.pick')];
  const listEl = document.getElementById('list');
  const countEl = document.getElementById('count');

  function save() {
    const picked = boxes.filter(b => b.checked).map(b => b.value);
    try { localStorage.setItem(KEY, JSON.stringify(picked)); } catch (e) {}
    countEl.textContent = picked.length + '개 고름';
    listEl.value = picked.join(String.fromCharCode(10));
  }

  boxes.forEach(function (b) {
    b.addEventListener('change', function () {
      b.closest('.pane').classList.toggle('picked', b.checked);
      save();
    });
  });

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    boxes.forEach(function (b) {
      if (saved.indexOf(b.value) !== -1) { b.checked = true; b.closest('.pane').classList.add('picked'); }
    });
  } catch (e) {}
  save();

  document.getElementById('clear').addEventListener('click', function () {
    boxes.forEach(function (b) { b.checked = false; b.closest('.pane').classList.remove('picked'); });
    save();
  });

  const copyBtn = document.getElementById('copy');
  copyBtn.addEventListener('click', function () {
    if (!listEl.value) {
      copyBtn.textContent = '고른 것이 없습니다';
      setTimeout(function () { copyBtn.textContent = '목록 복사'; }, 1600);
      return;
    }
    const done = function (msg) {
      copyBtn.textContent = msg;
      setTimeout(function () { copyBtn.textContent = '목록 복사'; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(listEl.value).then(function () { done('복사했습니다'); })
        .catch(function () { listEl.removeAttribute('readonly'); listEl.select(); done('직접 복사하세요'); });
    } else {
      listEl.removeAttribute('readonly'); listEl.select(); done('직접 복사하세요');
    }
  });
</script>
`;

fs.writeFileSync(OUT, html);
console.log('wrote ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
console.log('카드 ' + cards.length + '종 / 걸린 종 ' + flagged + ' / 지적 ' + allFlags.length + '건');
Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k + ': ' + v));
