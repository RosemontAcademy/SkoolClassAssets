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
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import { PNG } from 'pngjs';
import { readFrames, encodeGif, applyEdits, fillRatio, paletteOf, listItems, sourcesFor, origPath } from './lib/fxgif.mjs';

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

// ── 게임의 배치 ──────────────────────────────────────────────────────────────
// 미리보기가 게임과 같으려면 슬롯 좌표도 게임에서 가져와야 한다. 숫자를 여기 박아 두면
// 원장님이 게임에서 CALIBRATE 로 배치를 바꿀 때마다 조용히 어긋난다.
// 정본은 DB(skoolclass_settings.raid_calib_layout), 못 읽으면 코드 기본값으로 떨어진다.
const CALIB_FALLBACK = [
  { x: 516, y: 19, size: 117 },   // 보스
  { x: 355, y: 208, size: 97 },   // 학생
  { x: 268, y: 222, size: 81 },   // 파티
  { x: 353, y: 99, size: 200 },   // Attack FX
  { x: 357, y: 36, size: 276 },   // Attacked FX
  { x: 516, y: 52, size: 94 },    // Hit(보스)
  { x: 353, y: 214, size: 98 },   // Hit(학생)
];

function readEnv() {
  const p = join(__dirname, '..', '..', '.env.local');
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][\w]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return out;
}

let calibCache = null;
async function calibration(force = false) {
  if (calibCache && !force) return calibCache;
  const env = readEnv();
  const url = env.VITE_SUPABASE_URL, key = env.SUPABASE_SERVICE_KEY || env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return (calibCache = { items: CALIB_FALLBACK, source: '코드 기본값 (.env.local 을 못 읽음)' });
  try {
    const r = await fetch(`${url}/rest/v1/skoolclass_settings?key=eq.raid_calib_layout&select=value,updated_at`,
      { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return (calibCache = { items: CALIB_FALLBACK, source: '코드 기본값 (DB에 저장된 배치 없음)' });
    const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    const items = v.items || v;
    if (!Array.isArray(items) || items.length < 5) return (calibCache = { items: CALIB_FALLBACK, source: '코드 기본값 (DB 값 모양이 이상함)' });
    return (calibCache = { items, source: '게임에 저장된 배치', updated_at: rows[0].updated_at, canvas: [v.calibW || 820, v.calibH || 700] });
  } catch (e) {
    return (calibCache = { items: CALIB_FALLBACK, source: '코드 기본값 (DB에 못 닿음: ' + e.message + ')' });
  }
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

  // 0번 장은 이펙트가 아직 없는 맨 스프라이트다. 다른 장과 같은 시간을 주면
  // 공격이 시작되기 전에 화면이 멈춰 있는 것처럼 보인다.
  let per;
  if (fitMs) {
    const round10 = v => Math.max(20, Math.round(v / 10) * 10);
    if (body.leadShort && picked.length > 1) {
      const lead = round10(Math.min(160, fitMs * 0.06));
      const rest = round10((fitMs - lead) / (picked.length - 1));
      per = [lead, ...Array(picked.length - 1).fill(rest)];
    } else {
      per = round10(fitMs / picked.length);
    }
  } else {
    per = delayMs || framesOf(dir, kind, seq[0].src).delay;
  }
  const buf = encodeGif(w, h, picked, per);
  const loopMs = Array.isArray(per) ? per.reduce((a, b) => a + b, 0) : per * picked.length;

  const target = join(FXD, dir, `${dir}-${kind}-fx.gif`);

  // 처음 저장하기 전에 원본을 떠 둔다. 이걸 안 하면 결과물이 재료를 덮어써서
  // 다음에 열었을 때 쓸 수 있는 낱장이 줄어 있다(4장으로 저장 → 재료도 4장).
  const orig = origPath(FXD, dir, kind);
  if (!existsSync(orig) && existsSync(target)) {
    mkdirSync(dirname(orig), { recursive: true });
    copyFileSync(target, orig);
  }

  if (existsSync(target)) {
    const prev = join(FXD, dir, '_prev');
    mkdirSync(prev, { recursive: true });
    copyFileSync(target, join(prev, `${dir}-${kind}-fx.gif`));
  }
  writeFileSync(target, buf);

  // 조리법도 같이 남긴다 — 같은 결과를 언제든 다시 만들 수 있게
  const recipe = { species: dir, kind, canvas: `${w}x${h}`, delay_ms: per, loop_ms: loopMs,
    lead_short: !!body.leadShort, fit_ms: fitMs || null,
    frames: picked.length, steps: seq, saved_at: new Date().toISOString() };
  writeFileSync(join(FXD, dir, `recipe.${kind}.json`), JSON.stringify(recipe, null, 2));

  // 결과물이 바뀌었을 뿐 재료(bakes/원본)는 그대로다. 캐시는 그래도 비워 둔다.
  cache.delete(`${dir}|${kind}|old`);
  const rel = `skillFX/${dir}/${dir}-${kind}-fx.gif`;
  return {
    ok: true, frames: picked.length, delay_ms: per, loop_ms: loopMs,
    file: rel,
    purge: `https://purge.jsdelivr.net/gh/${REPO}@main/${rel}`,
  };
}

// ── 올리기 ───────────────────────────────────────────────────────────────────
// 저장은 이 PC 의 파일만 바꾼다. 게임은 GitHub → jsDelivr 에서 읽으므로
// 커밋·푸시·CDN 비우기까지 가야 아이들 화면에 나온다. 그 세 걸음을 한 번에 한다.
//
// 안전장치: **방금 만진 파일만** 골라 담는다. git add -A 를 쓰면 원장님이 다른 창에서
// 하던 작업까지 딸려 나간다. commit 도 경로를 지정해 인덱스에 뭐가 올라와 있든
// 그 경로만 담기게 한다.
function sh(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: join(__dirname, '..'), encoding: 'utf8', windowsHide: true });
  // stdout 을 다듬지 않는다. `git status --porcelain` 은 앞 두 칸이 상태 표시라
  // ` M path` 처럼 공백으로 시작하는데, trim 하면 그 공백이 날아가 경로가 한 글자
  // 갉아먹힌다. stderr 도 섞지 않는다 — 경고 한 줄이 목록에 끼어든다.
  return { code: r.status, out: r.stdout || '', err: (r.stderr || '').trim() };
}

function pending() {
  const st = sh('git', ['status', '--porcelain', '--', 'skillFX']);
  const files = [];
  for (const line of st.out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = line.slice(3).replace(/^"|"$/g, '');
    if (p.includes('/_prev/')) continue;                       // 로컬 백업은 안 올린다
    // 결과물 · 조리법 · 재료(bakes) 셋을 올린다. 재료가 빠지면 다른 PC 에서
    // 같은 조리법을 돌려도 다른 그림이 나온다 — 조리법이 재료를 가리키기 때문이다.
    if (/skillFX\/[^/]+\/[^/]+-fx\.gif$/.test(p)
      || /skillFX\/[^/]+\/recipe\.[a-z]+\.json$/.test(p)
      || /skillFX\/[^/]+\/bakes\/[^/]+\.gif$/.test(p)) files.push(p);
  }
  return [...new Set(files)];
}

async function publish(pinGame = true) {
  const files = pending();

  // 올릴 파일이 없어도, 게임이 아직 옛 커밋을 가리키고 있으면 못박기는 해야 한다.
  // (자산은 올렸는데 게임 코드 갱신만 빠진 상태가 실제로 생긴다)
  if (!files.length) {
    if (!pinGame) return { ok: false, error: '올릴 것이 없습니다. 먼저 저장하세요.' };
    const sha = sh('git', ['rev-parse', 'HEAD']).out.trim();
    const game = pinToSha(sha);
    if (game.skipped) return { ok: false, error: '올릴 것이 없고, 게임도 이미 최신입니다.' };
    return { ok: game.ok, error: game.error, sha, game, gifs: [],
      log: ['올릴 파일은 없음', game.ok ? '게임 코드만 갱신·배포 시작' : '게임 코드 갱신 실패'],
      message: '자산은 이미 올라가 있어 게임 주소만 못박았습니다.' };
  }

  const gifs = files.filter(f => f.endsWith('.gif'));
  const names = [...new Set(gifs.map(f => f.split('/')[1]))];
  const log = [];

  const add = sh('git', ['add', '--', ...files]);
  if (add.code !== 0) return { ok: false, error: '담기 실패: ' + (add.err || add.out) };
  log.push('담음 ' + files.length + '개');

  const msg = 'FX 편집기에서 다듬은 연출 ' + gifs.length + '개 — ' + names.join(', ');
  const ci = sh('git', ['commit', '-m', msg, '--', ...files]);
  if (ci.code !== 0) return { ok: false, error: '커밋 실패: ' + (ci.err || ci.out), log };
  log.push('커밋함');

  const push = sh('git', ['push', 'origin', 'main']);
  if (push.code !== 0) return { ok: false, error: '푸시 실패: ' + (push.err || push.out), log };
  log.push('푸시함');

  const sha = sh('git', ['rev-parse', 'HEAD']).out.trim();
  log.push('커밋 ' + sha.slice(0, 8));

  // purge 는 파일 캐시만 비운다. `@main` 이 **어느 커밋을 가리키는지**는 그대로라
  // 비운 자리에 또 옛 내용이 채워진다(실측: purge 두 번, 쿼리 붙이기 모두 소용 없음).
  // 그래서 게임 쪽 주소를 방금 커밋 SHA 로 못박는다 — 주소가 매번 달라지니 낡을 수가 없다.
  let game = null;
  if (pinGame) {
    game = pinToSha(sha);
    log.push(game.ok ? '게임 코드 갱신·배포 시작' : '게임 코드 갱신 실패');
  }

  // 그래도 @main 주소를 직접 여는 경우를 위해 비워는 둔다.
  const purged = [];
  for (const g of gifs) {
    try {
      const r = await fetch(`https://purge.jsdelivr.net/gh/${REPO}@main/${g}`);
      const j = await r.json().catch(() => ({}));
      purged.push({ file: g, status: j.status || r.status });
    } catch (e) { purged.push({ file: g, status: '실패: ' + e.message }); }
  }

  // 못박은 주소가 진짜로 새 파일을 주는지 확인한다. "올렸습니다" 라고만 하고
  // 실제로 안 바뀌는 게 제일 나쁘다.
  let verify = null;
  if (gifs.length) {
    try {
      const url = `https://cdn.jsdelivr.net/gh/${REPO}@${sha}/${gifs[0]}`;
      const r = await fetch(url, { method: 'HEAD' });
      const cdnLen = +(r.headers.get('content-length') || 0);
      const localLen = statSync(join(__dirname, '..', gifs[0])).size;
      verify = { url, cdnLen, localLen, same: cdnLen === localLen };
    } catch (e) { verify = { error: e.message }; }
  }

  return { ok: true, files, gifs, log, purged, sha, game, verify, message: msg };
}

/**
 * 게임이 읽는 주소의 `@main` 을 방금 올린 커밋으로 못박는다.
 * 다른 저장소(skoolclass-pro)를 건드리고 Vercel 배포를 일으키므로,
 * 건드리는 파일은 딱 두 개로 제한한다 — 원장님이 다른 창에서 하던 작업이 딸려가면 안 된다.
 */
function pinToSha(sha) {
  const root = join(__dirname, '..', '..');
  const rel = 'api/_shared/pokemon_gen1.ts';
  const file = join(root, rel);
  if (!existsSync(file)) return { ok: false, error: '게임 코드를 못 찾았습니다: ' + file };

  const before = readFileSync(file, 'utf8');
  const re = /(const CDN_MAIN = 'https:\/\/cdn\.jsdelivr\.net\/gh\/RosemontAcademy\/SkoolClassAssets@)([^']+)(')/;
  const m = re.exec(before);
  if (!m) return { ok: false, error: 'CDN_MAIN 줄을 못 찾았습니다' };
  if (m[2] === sha) return { ok: true, skipped: '이미 그 커밋을 가리킵니다' };
  writeFileSync(file, before.replace(re, `$1${sha}$3`));

  const g = (a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', windowsHide: true });
  const paths = [rel, 'SkoolClassAssets'];
  const add = g(['add', '--', ...paths]);
  if (add.status !== 0) return { ok: false, error: '담기 실패: ' + (add.stderr || '').trim() };
  const ci = g(['commit', '-m', `FX 자산을 ${sha.slice(0, 8)} 로 못박는다 (jsDelivr @main 은 최대 12시간 낡는다)`, '--', ...paths]);
  if (ci.status !== 0) return { ok: false, error: '커밋 실패: ' + (ci.stderr || '').trim() };
  const push = g(['push', 'origin', 'main']);
  if (push.status !== 0) return { ok: false, error: '푸시 실패: ' + (push.stderr || '').trim() };
  return { ok: true, from: m[2], to: sha };
}

// ── 서버 ─────────────────────────────────────────────────────────────────────
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);

    // 브라우저가 알아서 찾는다. 없다고 404 를 내면 콘솔에 빨간 줄이 남아
    // 진짜 오류를 찾을 때 헷갈린다.
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (url.pathname === '/api/items') {
      // 이미 조리법을 저장한 종은 목록에서 표시해 준다 — 62개를 여러 날에 걸쳐
      // 작업하니 어디까지 했는지가 안 보이면 같은 걸 또 만지게 된다.
      return json(res, 200, listItems(FXD).map(it => ({
        ...it, done: existsSync(join(FXD, it.dir, `recipe.${it.kind}.json`)),
      })));
    }

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

    // 게임 화면 미리보기에 쓸 스프라이트·배경. 편집기 안에서 실제 전투처럼 보여주려면
    // 체커 위 1:1 이 아니라 캐릭터 위에 진짜 슬롯 크기로 얹어야 한다.
    if (url.pathname === '/sprite.gif') {
      const dir = url.searchParams.get('dir') || '';
      const back = url.searchParams.get('back') === '1';
      const p = join(__dirname, '..', 'sprites', 'pokemon', 'other', 'showdown', back ? 'back' : '', dir + '.gif');
      if (!existsSync(p)) return json(res, 404, { error: '스프라이트 없음' });
      return send(res, 200, 'image/gif', readFileSync(p));
    }

    if (url.pathname === '/battle-bg') {
      const p = join(__dirname, '..', 'Background', 'TEST BG.png');
      if (!existsSync(p)) return json(res, 404, { error: '배경 없음' });
      return send(res, 200, 'image/png', readFileSync(p));
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

    if (url.pathname === '/api/calib') {
      calibration(url.searchParams.get('force') === '1')
        .then(c => json(res, 200, c)).catch(e => json(res, 500, { error: e.message }));
      return;
    }

    if (url.pathname === '/api/pending') return json(res, 200, pending());

    if (url.pathname === '/api/publish' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        let pin = true;
        try { if (raw) pin = JSON.parse(raw).pinGame !== false; } catch {}
        publish(pin).then(r => json(res, r.ok ? 200 : 400, r)).catch(e => json(res, 500, { error: e.message }));
      });
      return;
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

  /* ── 게임 화면 미리보기 ──
     게임은 FX 를 캐릭터 위에 얹고, 선생님 화면에서는 screen 합성으로 그린다.
     screen 에서는 어두운 픽셀이 사실상 안 보이므로 체커 위에서 판단하면 헛일을 한다.
     .field 의 position:relative 가 빠지면 안에 절대배치한 스프라이트가 페이지 기준으로
     떠서 편집기 위로 튀어나온다. */
  .game{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px;
    display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
  .field{position:relative;border-radius:10px;overflow:hidden;border:1px solid var(--line);
    background:#20242e;flex:0 0 auto}
  .field img{position:absolute;image-rendering:pixelated}
  .field .scene{position:absolute;left:0;top:0;width:100%;overflow:hidden;background:#3a7bd5}
  .field .panelline{position:absolute;left:0;width:100%;height:0;border-top:2px dashed rgba(255,255,255,.28);
    color:rgba(255,255,255,.5);font-size:10px;padding-left:6px;pointer-events:none}
  /* 게임은 backgroundSize:cover · backgroundPosition:bottom 으로 깐다 */
  .field .bg{left:0;top:0;width:100%;height:100%;object-fit:cover;object-position:bottom;image-rendering:auto}
  .field .slotbox{position:absolute;border:1px dashed rgba(255,255,255,.3);border-radius:3px;pointer-events:none}
  .gopts{display:flex;flex-direction:column;gap:7px;width:250px;flex:0 0 auto}
  .gopts .cur{gap:6px}
  .gnote{font-size:11.5px;color:var(--muted);line-height:1.5}

  /* ── 큰 편집기 (프레임을 누르면 아래에 펼쳐진다) ── */
  .ed{background:var(--surface);border:2px solid var(--accent);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:10px}
  /* 전체화면 — 작은 도트를 크게 놓고 손볼 때 */
  .ed.full{position:fixed;inset:12px;z-index:60;overflow:auto;box-shadow:0 24px 70px rgba(0,0,0,.5)}
  .ed h2 button{font-size:12px;padding:4px 9px}
  .ed h2{margin:0;font-size:14px;font-weight:800;display:flex;align-items:center;gap:8px}
  .ed h2 .mono{font-weight:600;font-size:12px;color:var(--muted)}
  .ed .close{margin-left:auto}
  .edmain{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
  .cw{border-radius:12px;padding:8px;background-color:var(--cell);position:relative;
    background-image:linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%),
    linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%);background-size:16px 16px;background-position:0 0,8px 8px;
    overflow:auto;max-width:100%;
    display:flex;align-items:safe center;justify-content:safe center}
  /* 확대하면 캔버스가 칸보다 커진다 — 칸이 스스로 스크롤돼야 도구가 안 밀린다 */
  .ed.full .edmain{flex:1;min-height:0;align-items:stretch}
  .ed.full .cw{flex:1;max-height:calc(100vh - 150px)}
  .ed.full .tools{max-height:calc(100vh - 150px);overflow-y:auto}
  .cwrap{position:relative;width:max-content;height:max-content}
  #cv{image-rendering:pixelated;cursor:crosshair;touch-action:none;border-radius:4px;display:block}
  /* 앞 장은 파랗게 물들여 보여준다 — 안 그러면 "왜 겹쳐 보이지" 가 된다 */
  #onion{position:absolute;left:0;top:0;pointer-events:none;image-rendering:pixelated;
    opacity:.32;border-radius:4px;filter:grayscale(1) sepia(1) hue-rotate(175deg) saturate(4)}
  .onionmark{position:absolute;right:12px;top:12px;font-size:10px;font-weight:800;color:#7aa7ff;
    background:rgba(0,0,0,.55);border-radius:5px;padding:1px 6px;pointer-events:none}
  #grid{position:absolute;left:0;top:0;pointer-events:none;border-radius:4px}
  .tools{display:flex;flex-direction:column;gap:8px;min-width:210px}
  .tgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}
  .tgrid button{padding:7px 4px;font-size:12px}
  .pal{display:flex;flex-wrap:wrap;gap:4px;max-width:230px}
  .sw{width:20px;height:20px;border-radius:5px;border:2px solid var(--line);cursor:pointer;padding:0}
  .sw.on{border-color:var(--accent);transform:scale(1.12)}
  .cur{display:flex;align-items:center;gap:7px;font-size:12px}
  .cur .box{width:26px;height:26px;border-radius:6px;border:1px solid var(--line)}
  button.pub{background:#166534;border-color:#166534;color:#fff}
  button.pub:hover{background:#15803d;border-color:#15803d}
  button.pub[disabled]{opacity:.5}
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
// 슬롯은 게임에서 받아온다(숫자를 여기 박아 두면 배치를 바꿀 때마다 어긋난다).
let CANVAS=[820,700];
let SLOT={boss:{x:516,y:19,s:117},player:{x:355,y:208,s:97},atk:{x:353,y:99,s:200},atkd:{x:357,y:36,s:276}};
let calibSource='불러오는 중';
async function loadCalib(force){
  try{
    const c=await (await fetch('/api/calib'+(force?'?force=1':''))).json();
    const it=c.items||[];
    if(it.length>=5){
      SLOT={boss:{x:it[0].x,y:it[0].y,s:it[0].size},player:{x:it[1].x,y:it[1].y,s:it[1].size},
            atk:{x:it[3].x,y:it[3].y,s:it[3].size},atkd:{x:it[4].x,y:it[4].y,s:it[4].size}};
    }
    if(c.canvas)CANVAS=c.canvas;
    calibSource=c.source+(c.updated_at?' · '+String(c.updated_at).slice(0,16).replace('T',' '):'');
  }catch(e){calibSource='못 불러옴 — 코드 기본값'}
}
// 캔버스 아래쪽은 문제 패널이다: flex 0 0 clamp(300px, 56%, 540px) → 700의 56% = 392px.
// 그래서 배경이 깔리는 장면은 위 308px 뿐이고, backgroundPosition 은 bottom 이다.
// FX 층은 장면 밖 캔버스 층에 그려져서 패널 위로 넘어올 수 있다(그래서 안 잘린다).
const PANEL_H=Math.min(540,Math.max(300,Math.round(CANVAS[1]*0.56)));
const SCENE_H=CANVAS[1]-PANEL_H;
let items=[],cur=null,meta={},seq=[],edits={},fit=3000,zoom=1,playT=null,openEd=null;
let leadShort=true,undoStack=[],blend='screen',showBg=true,showSlots=false,pinGame=true;
const rawURL=(src,i)=>'/frame.png?dir='+encodeURIComponent(cur.dir)+'&kind='+cur.kind+'&src='+src+'&i='+i;
// 손질한 낱장은 서버가 아니라 여기서 만든 그림을 쓴다. 안 그러면 지우거나 칠한 것이
// 썸네일·조립 미리보기·게임 화면에 안 보이고, 저장한 뒤에야 나타난다.
const editedCache={};
const furl=(src,i)=>editedCache[K(src,i)]||rawURL(src,i);
function buildEdited(src,i,done){
  const k=K(src,i), st=edits[k];
  if(!st||!st.length){delete editedCache[k];done&&done();return}
  const img=new Image();
  img.onload=()=>{
    const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
    const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(img,0,0);
    for(const t of st)applyOne(x,t,img.width,img.height);
    editedCache[k]=c.toDataURL('image/png');done&&done();
  };
  img.onerror=()=>{done&&done()};
  img.src=rawURL(src,i);
}
const K=(src,i)=>src+i;
const nEdits=(src,i)=>(edits[K(src,i)]||[]).length;

async function boot(){
  await loadCalib();
  items=await (await fetch('/api/items')).json();
  const L=$('#list');
  items.forEach(it=>{const d=el('div','it');d.dataset.id=it.id;
    d.innerHTML='<span>'+it.dir.replace(/^\\d+-/,'')+'</span><small>'+it.kind+'</small>'+(it.done?'<span class="done">●</span>':'');
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
  undoStack=[];                                  // 다른 종의 순서로 되돌아가면 안 된다
  Object.keys(editedCache).forEach(k=>delete editedCache[k]);
  const ks=Object.keys(edits);
  let left=ks.length;
  if(!left){render();return}
  ks.forEach(k=>{const m=/^(old|new|v\d)(\d+)$/.exec(k);
    if(!m){left--;return}
    buildEdited(m[1],+m[2],()=>{if(--left<=0)render()})});
  if(left<=0)render();
}
function render(){
  const b=$('#bar');b.innerHTML='';
  const t=el('span','lbl');t.textContent=cur.dir+' · '+cur.kind+' · '+cur.canvas;b.appendChild(t);
  cur.sources.forEach(s=>{const x=el('button');x.textContent=s.label+' 전부';
    x.onclick=()=>{push();seq=meta[s.id].fills.map((_,i)=>({src:s.id,i}));render()};b.appendChild(x)});
  const cl=el('button');cl.textContent='비우기';cl.onclick=()=>{push();seq=[];render()};b.appendChild(cl);
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
  const ls=el('button');ls.textContent='첫 장 짧게';ls.setAttribute('aria-pressed',String(leadShort));
  ls.title='0번 장은 이펙트가 없는 맨 스프라이트라 짧게 주는 게 자연스럽습니다';
  ls.onclick=()=>{leadShort=!leadShort;render()};b.appendChild(ls);
  const ud=el('button');ud.textContent='되돌리기';ud.disabled=!undoStack.length;
  ud.onclick=()=>{const p=undoStack.pop();if(p){seq=JSON.parse(p);render()}};b.appendChild(ud);
  const sv=el('button','primary');sv.textContent='저장';sv.disabled=!seq.length;sv.onclick=save;b.appendChild(sv);
  const pin=el('button');pin.id='pinbtn';pin.textContent='게임까지 반영';
  pin.setAttribute('aria-pressed',String(pinGame));
  pin.title='켜면 게임 코드의 자산 주소를 이번 커밋으로 못박고 배포까지 합니다(1~2분). 끄면 자산만 올립니다.';
  pin.onclick=()=>{pinGame=!pinGame;pin.setAttribute('aria-pressed',String(pinGame))};b.appendChild(pin);
  const pb=el('button','pub');pb.id='pubbtn';pb.textContent='올리기';
  pb.title='저장한 것을 커밋·푸시하고, 게임 코드까지 갱신합니다';
  pb.onclick=publish;b.appendChild(pb);

  const W=$('#work');W.innerHTML='';
  cur.sources.forEach(s=>W.appendChild(strip(s)));
  W.appendChild(seqRow());
  const D=delays();const loop=D.reduce((a,b)=>a+b,0);
  const info=el('div','msg');
  info.innerHTML=seq.length
    ? seq.length+'장 · '+(leadShort&&seq.length>1?'첫 장 <b>'+D[0]+'ms</b> + 나머지 <b>'+D[1]+'ms</b>':'장당 <b>'+D[0]+'ms</b>')
      +' · 한 바퀴 <b>'+loop+'ms</b> → 창 '+(fit/1000)+'초 안에서 <b>'+(fit/loop).toFixed(2)+'바퀴</b>'
    :'낱장을 눌러 크게 보고, ＋로 담으세요.';
  W.appendChild(info);
  W.appendChild(gameView());
  if(openEd) W.appendChild(editor());
  play();
}
function delays(){
  if(!seq.length)return [0];
  const r10=v=>Math.max(20,Math.round(v/10)*10);
  if(leadShort&&seq.length>1){const lead=r10(Math.min(160,fit*0.06));
    return [lead,...Array(seq.length-1).fill(r10((fit-lead)/(seq.length-1)))]}
  return Array(seq.length).fill(r10(fit/seq.length));
}
function push(){undoStack.push(JSON.stringify(seq));if(undoStack.length>40)undoStack.shift()}
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
    const img=el('img');img.src=furl(s.id,i);b.appendChild(img);
    const m=el('div','m');m.textContent=i+' · '+f+'%'+(blank?' 빔':'');b.appendChild(m);
    b.onclick=()=>{openEd={src:s.id,i};render();setTimeout(()=>document.querySelector('.ed').scrollIntoView({behavior:'smooth',block:'nearest'}),30)};
    const a=el('button','add');a.textContent='＋';a.title='만든 것에 담기';
    a.onclick=e=>{e.stopPropagation();push();seq.push({src:s.id,i});render()};b.appendChild(a);
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
    const b=el('div','slot'+(s.src==='old'?' old':'')+(nEdits(s.src,s.i)?' edited':'')
      +(openEd&&openEd.src===s.src&&openEd.i===s.i?' sel':''));
    b.draggable=true;b.dataset.n=n;b.title='눌러서 이 낱장 편집';
    const img=el('img');img.src=furl(s.src,s.i);b.appendChild(img);
    const m=el('div','m');m.textContent=(s.src==='old'?'지금':'새')+s.i;b.appendChild(m);
    // 담아 놓고 보다가 손보고 싶어지는 게 자연스러운 순서다. 재료 줄로 되돌아가
    // 같은 낱장을 다시 찾게 만들면 안 된다.
    b.onclick=()=>{openEd={src:s.src,i:s.i};render();
      setTimeout(()=>{const e=document.querySelector('.ed');if(e)e.scrollIntoView({behavior:'smooth',block:'nearest'})},30)};
    const ops=el('div','ops');
    [['✎','edit'],['◀',-1],['▶',1],['×',0]].forEach(([t,d])=>{
      const x=el('button',d===0?'x':'');x.textContent=t;
      x.onclick=e=>{e.stopPropagation();
        if(d==='edit'){b.onclick();return}
        push();
        if(d===0)seq.splice(n,1);
        else{const j=n+d;if(j<0||j>=seq.length)return;[seq[n],seq[j]]=[seq[j],seq[n]]}
        render()};
      ops.appendChild(x)});
    b.appendChild(ops);
    b.addEventListener('dragstart',e=>{drag={kind:'move',n};b.classList.add('dragging');e.dataTransfer.effectAllowed='move'});
    b.addEventListener('dragend',()=>{b.classList.remove('dragging');clearMark();drag=null});
    sp.appendChild(b);
  });
  sp.addEventListener('dragover',e=>{if(!drag)return;e.preventDefault();markAt(sp,e.clientX)});
  sp.addEventListener('drop',e=>{if(!drag)return;e.preventDefault();push();
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
function gameView(){
  const wrap=el('div','game');
  const SC=0.62;
  const f=el('div','field');
  const isAtk0=cur.kind==='attack';
  const fxSlot=isAtk0?SLOT.atk:SLOT.atkd;
  // 문제 패널은 텅 빈 칸이라 자리만 잡아먹는다. 장면 높이만 쓰되, FX 가 그 아래로
  // 넘치는 경우(attacked 는 y35+318=353 으로 장면 308 을 넘는다)만 그만큼 더 둔다.
  const fieldH=Math.max(SCENE_H,fxSlot.y+fxSlot.s)+6;
  f.style.width=CANVAS[0]*SC+'px';f.style.height=fieldH*SC+'px';
  const scene=el('div','scene');
  scene.style.height=SCENE_H*SC+'px';
  if(showBg){const bg=el('img');bg.className='bg';bg.src='/battle-bg';scene.appendChild(bg)}
  f.appendChild(scene);
  if(fieldH>SCENE_H+6){const line=el('div','panelline');line.style.top=SCENE_H*SC+'px';
    line.textContent='여기부터 문제 패널';f.appendChild(line)}
  const put=(img,slot)=>{img.style.left=slot.x*SC+'px';img.style.top=slot.y*SC+'px';
    img.style.width=slot.s*SC+'px';img.style.height=slot.s*SC+'px';img.style.objectFit='contain';f.appendChild(img)};
  const isAtk=isAtk0;
  if(isAtk){const b=el('img');b.src='/sprite.gif?dir='+encodeURIComponent(cur.dir);put(b,SLOT.boss)}
  else{const p=el('img');p.src='/sprite.gif?dir='+encodeURIComponent(cur.dir)+'&back=1';put(p,SLOT.player)}
  const fx=el('img');fx.id='gamefx';fx.style.mixBlendMode=blend==='screen'?'screen':'normal';
  fx.style.zIndex='5';put(fx,isAtk?SLOT.atk:SLOT.atkd);
  if(showSlots){const sl=isAtk?SLOT.atk:SLOT.atkd;const box=el('div','slotbox');
    box.style.left=sl.x*SC+'px';box.style.top=sl.y*SC+'px';box.style.width=sl.s*SC+'px';box.style.height=sl.s*SC+'px';f.appendChild(box)}
  wrap.appendChild(f);

  const o=el('div','gopts');
  const t=el('div');t.className='lbl';t.textContent='진짜 게임 화면';o.appendChild(t);
  const bl=el('div','cur');bl.style.flexDirection='column';bl.style.alignItems='stretch';
  [['screen','선생님 화면 (screen)'],['normal','학생 화면 (그대로)']].forEach(([v,n])=>{
    const x=el('button');x.textContent=n;x.setAttribute('aria-pressed',String(blend===v));
    x.onclick=()=>{blend=v;render()};bl.appendChild(x)});
  o.appendChild(bl);
  const ck=el('div','cur');ck.style.flexWrap='wrap';
  const bb=el('button');bb.textContent='배경';bb.setAttribute('aria-pressed',String(showBg));
  bb.onclick=()=>{showBg=!showBg;render()};
  const sb=el('button');sb.textContent='슬롯 테두리';sb.setAttribute('aria-pressed',String(showSlots));
  sb.onclick=()=>{showSlots=!showSlots;render()};
  ck.append(bb,sb);o.appendChild(ck);
  const cs=el('div','cur');
  const src=el('span');src.className='gnote';src.style.flex='1';src.textContent='배치: '+calibSource;
  const rf=el('button');rf.textContent='배치 새로고침';rf.title='게임에서 CALIBRATE 로 바꾼 배치를 다시 읽어옵니다';
  rf.onclick=async()=>{await loadCalib(true);render()};
  cs.append(src,rf);o.appendChild(cs);
  const n=el('div','gnote');
  n.innerHTML=(isAtk?'FX 는 <b>학생 자리</b>('+SLOT.atk.s+'px)에 뜨고 학생 스프라이트는 감춰집니다. 보스가 표적입니다.'
    :'FX 는 <b>보스 자리</b>('+SLOT.atkd.s+'px)에 뜨고 보스 스프라이트는 감춰집니다. 학생이 표적입니다.')
    +'<br><br>원본 '+cur.canvas+' 을 그 크기로 늘려 그립니다.'
    +(blend==='screen'?'<br><br><b>screen 합성에서는 어두운 픽셀이 거의 안 보입니다.</b> 체커 위에서 거슬리던 검은 잔재가 여기서는 이미 안 보일 수 있습니다.':'');
  o.appendChild(n);
  wrap.appendChild(o);
  return wrap;
}

function play(){
  clearTimeout(playT);
  const im=$('#seqimg');if(!im||!seq.length)return;
  const gm=$('#gamefx');
  const D=delays();let k=0;
  const step=()=>{const u=furl(seq[k].src,seq[k].i);
    im.src=u;if(gm)gm.src=u;
    const d=D[k];k=(k+1)%seq.length;playT=setTimeout(step,d)};
  step();
}
async function save(){
  const steps=seq.map(s=>({src:s.src,i:s.i,erase:edits[K(s.src,s.i)]||[]}));
  const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({dir:cur.dir,kind:cur.kind,seq:steps,fitMs:fit,leadShort})});
  const j=await r.json();
  const m=el('div','msg '+(j.ok?'ok':'err'));
  m.innerHTML=j.ok?'저장했습니다 — '+j.frames+'장 · 한 바퀴 '+j.loop_ms+'ms<br>옛 파일은 _prev/ 에. 올린 뒤 CDN 비우기: <code>'+j.purge+'</code>':'실패: '+j.error;
  $('#work').appendChild(m);m.scrollIntoView({behavior:'smooth',block:'nearest'});
  if(j.ok){const n=document.querySelector('.it.on');if(n&&!n.querySelector('.done')){const d=el('span','done');d.textContent='●';n.appendChild(d)}}
}

async function publish(){
  const btn=document.getElementById('pubbtn');
  if(btn){btn.disabled=true;btn.textContent='올리는 중…'}
  let j;
  try{ j=await (await fetch('/api/publish',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({pinGame})})).json() }
  catch(e){ j={ok:false,error:'서버에 못 닿았습니다: '+e.message} }
  if(btn){btn.disabled=false;btn.textContent='올리기'}
  const m=el('div','msg '+(j.ok?'ok':'err'));
  if(j.ok){
    const v=j.verify||{};
    const okCdn=v.same===true;
    m.innerHTML='<b>올렸습니다.</b> '+(j.gifs||[]).length+'개<br>'
      +(j.log||[]).join(' → ')
      +(j.game&&j.game.ok
        ? '<br><b>게임 코드를 '+String(j.sha).slice(0,8)+' 로 못박았습니다.</b> Vercel 배포가 끝나면(1~2분) 반영됩니다.'
        : (j.game?'<br>⚠ 게임 코드 갱신 실패: '+j.game.error+' — 자산만 올라갔고, @main 은 최대 12시간 낡습니다.':''))
      +(v.error?'<br>확인 실패: '+v.error
        : (okCdn?'<br>CDN 확인: 새 파일이 나옵니다 ('+v.cdnLen+'B)'
                :'<br>⚠ CDN 이 아직 옛 파일을 줍니다 (CDN '+v.cdnLen+'B / 내 PC '+v.localLen+'B)'))
      +'<br><span style="opacity:.7">'+(j.message||'')+'</span>';
  } else {
    m.innerHTML='<b>못 올렸습니다.</b> '+(j.error||'')+((j.log||[]).length?'<br>'+j.log.join(' → '):'');
  }
  $('#work').appendChild(m);m.scrollIntoView({behavior:'smooth',block:'nearest'});
}

// 단축키 — 되돌리기와 저장은 손이 먼저 간다.
addEventListener('keydown',e=>{
  const typing=/^(INPUT|TEXTAREA)$/.test((e.target||{}).tagName||'');
  if(!(e.ctrlKey||e.metaKey)||typing)return;
  const k=e.key.toLowerCase();
  if(k==='z'){ e.preventDefault();
    if(openEd&&ed){ document.getElementById('eu')?.click(); }   // 편집기 안이면 붓질 되돌리기
    else { const p=undoStack.pop(); if(p){seq=JSON.parse(p);render()} }
  }
  if(k==='s'){ e.preventDefault();
    // 낱장 편집 중이면 '이 낱장에 적용', 아니면 전체 저장. 손이 가는 곳이 다르다.
    if(openEd){ document.getElementById('eapply')?.click(); }
    else if(cur&&seq.length){ save(); }
  }
});

// ── 큰 편집기 ────────────────────────────────────────────────────────────
let tool='pencil',color='#ffffff',brush=2,tol=20,onionOn=false,strokes=[],base=null,pal=[],edZoom=0,edFull=false,mountedKey=null;
function editor(){
  const wrap=el('div','ed'+(edFull?' full':''));
  const h=el('h2');h.innerHTML='낱장 편집 <span class="mono">'+(openEd.src==='old'?'지금':'새')+openEd.i+'</span>';
  const zl=el('span');zl.className='lbl';zl.style.marginLeft='auto';zl.textContent='확대';h.appendChild(zl);
  const zBtns=[];
  [[0,'자동'],[2,'2배'],[4,'4배'],[8,'8배'],[12,'12배'],[16,'16배']].forEach(([v,n])=>{
    const x=el('button');x.textContent=n;x.dataset.z=v;x.setAttribute('aria-pressed',String(edZoom===v));
    x.onclick=()=>{setZoom(v||autoZoom());edZoom=v;
      zBtns.forEach(t=>t.setAttribute('aria-pressed',String(+t.dataset.z===v)))};
    zBtns.push(x);h.appendChild(x)});
  const zl2=el('span');zl2.id='zlab';zl2.className='lbl';zl2.style.minWidth='34px';h.appendChild(zl2);
  const fs=el('button');fs.textContent=edFull?'창으로':'전체화면';fs.setAttribute('aria-pressed',String(edFull));
  fs.onclick=()=>{edFull=!edFull;render()};h.appendChild(fs);
  const cls=el('button','close');cls.textContent='닫기';cls.style.marginLeft='0';
  cls.onclick=()=>{openEd=null;edFull=false;mountedKey=null;render()};h.appendChild(cls);
  wrap.appendChild(h);

  const main=el('div','edmain');
  const cw=el('div','cw');
  const inner=el('div','cwrap');
  const on=el('canvas');on.id='onion';const gr=el('canvas');gr.id='grid';const cv=el('canvas');cv.id='cv';
  inner.append(on,cv,gr);cw.appendChild(inner);
  if(onionOn&&openEd.i>0){const mk=el('div','onionmark');mk.textContent='앞 장 비침';cw.appendChild(mk)}
  main.appendChild(cw);

  const T=el('div','tools');
  const tg=el('div','tgrid');
  // 도구를 바꿀 때마다 render() 를 부르면 편집기가 통째로 다시 만들어지고
  // 캔버스가 새로 붙느라 화면이 깜빡인다. 단추 상태만 갈아끼운다.
  const toolBtns=[];
  [['pencil','연필'],['eraser','지우개'],['picker','스포이드'],['bucket','페인트통'],['swap','색바꾸기'],['move','이동']]
    .forEach(([id,n])=>{const x=el('button');x.textContent=n;x.dataset.tool=id;
      x.setAttribute('aria-pressed',String(tool===id));
      x.onclick=()=>{tool=id;toolBtns.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tool===id)))};
      toolBtns.push(x);tg.appendChild(x)});
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
  ob.title='앞 장을 파랗게 비쳐 보여줍니다 — 움직임을 보며 손댈 때 씁니다';
  ob.onclick=()=>{onionOn=!onionOn;ob.setAttribute('aria-pressed',String(onionOn));
    const on=document.getElementById('onion');if(on)drawOnion(on);
    const mk=document.querySelector('.onionmark');
    if(onionOn&&openEd.i>0&&!mk){const m=el('div','onionmark');m.textContent='앞 장 비침';document.querySelector('.cw').appendChild(m)}
    if(!onionOn&&mk)mk.remove();
  };opts.appendChild(ob);
  const ub=el('button');ub.id='eu';ub.textContent='되돌리기';
  ub.onclick=()=>{
    if(!strokes.length)return;
    // 붓질 한 번은 점 수십 개로 남는다 — 이어진 것을 한 덩어리로 되돌린다.
    // 예전엔 'c'/'p' 만 그렇게 처리하고 이동·페인트통·색바꾸기는 아예 안 지워졌다.
    const drag=t=>t==='c'||t==='p'||t==='shift';
    const last=strokes[strokes.length-1].t;
    if(drag(last)){ while(strokes.length&&strokes[strokes.length-1].t===last)strokes.pop() }
    else strokes.pop();
    redraw();
  };
  const rb=el('button');rb.textContent='처음으로';rb.onclick=()=>{strokes=[];redraw()};
  opts.append(ub,rb);T.appendChild(opts);

  const ap=el('button','primary');ap.id='eapply';ap.textContent='이 낱장에 적용';
  ap.onclick=()=>{
    const k=K(openEd.src,openEd.i), src=openEd.src, i=openEd.i;
    if(strokes.length)edits[k]=strokes.slice();else delete edits[k];
    openEd=null;mountedKey=null;
    buildEdited(src,i,()=>render());   // 손질한 그림을 만든 뒤에 화면을 그린다
  };
  T.appendChild(ap);
  const hint=el('div');hint.className='cap';hint.style.textAlign='left';
  hint.innerHTML='손댄 자국은 좌표로 저장됩니다. 원본 gif 는 안 바뀝니다.<br>'
    +'<b>휠</b> 확대·축소 (커서 지점 기준) · 커지면 칸 안에서 끌어 넘기기<br>'
    +'<b>Ctrl+Z</b> 붓질 되돌리기 · <b>Ctrl+S</b> 이 낱장에 적용';
  T.appendChild(hint);
  main.appendChild(T);wrap.appendChild(main);

  setTimeout(()=>mount(cv,on,gr,pw),0);
  return wrap;
}
function autoZoom(){
  if(!base)return 4;
  const room=edFull?Math.min(innerWidth-380,innerHeight-170):460;
  return Math.max(2,Math.min(16,Math.floor(room/base.w)));
}
/** 배율만 갈아끼운다 — render() 를 부르면 캔버스가 새로 붙어 그리던 게 끊긴다. */
function setZoom(z){
  if(!base)return;
  z=Math.max(1,Math.min(32,Math.round(z)));
  base.z=z;
  ['cv','onion','grid'].forEach(id=>{const c=document.getElementById(id);
    if(c){c.style.width=base.w*z+'px';c.style.height=base.h*z+'px'}});
  const gr=document.getElementById('grid');if(gr)drawGrid(gr,z);
  const lab=document.getElementById('zlab');if(lab)lab.textContent=z+'배';
}
function mount(cv,on,gr,pw){
  const img=new Image();
  img.onload=()=>{
    base={img,z:1,w:img.width,h:img.height};
    const z=edZoom||autoZoom();
    [cv,on,gr].forEach(c=>{c.width=img.width;c.height=img.height});
    setZoom(z);
    // 같은 낱장을 다시 그리는 것뿐이면(전체화면 전환 등) 하던 붓질을 이어간다.
    // 여기서 무조건 저장본을 다시 읽으면 아직 '적용' 안 한 작업이 조용히 사라진다.
    const k=K(openEd.src,openEd.i);
    if(mountedKey!==k){ strokes=(edits[k]||[]).slice(); mountedKey=k; }
    redraw();drawOnion(on);buildPal(pw);
    bindCanvas(cv);
  };
  // 편집기는 **원본**에서 시작한다. 손질한 그림을 불러오면 같은 손질이 두 번 얹힌다.
  img.src=rawURL(openEd.src,openEd.i);
}
/** 고른 색을 화면에 반영한다. render() 를 부르면 그리던 붓질이 날아간다. */
function setColor(hex){
  color=hex;
  const box=document.querySelector('.ed .cur .box');if(box)box.style.background=hex;
  const ci=document.querySelector('.ed .cur input[type=color]');if(ci)ci.value=hex;
  document.querySelectorAll('.ed .pal .sw').forEach(o=>{
    o.classList.toggle('on',(o.style.background||'').replace(/\s/g,'')===hexToRgbCss(hex));
  });
}
const hexToRgbCss=h=>'rgb('+[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)).join(',')+')';
function ctxOf(){return document.getElementById('cv').getContext('2d',{willReadFrequently:true})}
function redraw(){
  const c=ctxOf();c.clearRect(0,0,base.w,base.h);c.drawImage(base.img,0,0);
  for(const s of strokes)applyOne(c,s,base.w,base.h);
}
function applyOne(c,s,W,H){
  const w=W||base.w,h=H||base.h;
  if(s.t==='c'){c.save();c.globalCompositeOperation='destination-out';c.beginPath();c.arc(s.x,s.y,s.r,0,7);c.fill();c.restore()}
  else if(s.t==='r'){c.save();c.globalCompositeOperation='destination-out';c.fillRect(s.x,s.y,s.w,s.h);c.restore()}
  else if(s.t==='p'){c.fillStyle='rgb('+s.color.join(',')+')';c.beginPath();c.arc(s.x,s.y,s.r,0,7);c.fill()}
  else if(s.t==='swap'||s.t==='fill'||s.t==='shift'){pixelOp(c,s,w,h)}
}
function pixelOp(c,s,W,H){
  const w=W||base.w,h=H||base.h;
  const d=c.getImageData(0,0,w,h),px=d.data;
  if(s.t==='swap'){const [fr,fg,fb]=s.from,[tr,tg,tb]=s.to,t=(s.tol??20)**2*3;
    for(let i=0;i<px.length;i+=4){if(px[i+3]<40)continue;const a=px[i]-fr,b=px[i+1]-fg,g=px[i+2]-fb;
      if(a*a+b*b+g*g<=t){px[i]=tr;px[i+1]=tg;px[i+2]=tb}}}
  else if(s.t==='fill'){
    const sx=Math.floor(s.x),sy=Math.floor(s.y);if(sx<0||sy<0||sx>=w||sy>=h){c.putImageData(d,0,0);return}
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
    b.onclick=()=>{setColor(p.hex)};pw.appendChild(b)});
}
const hex2rgb=h=>[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
function bindCanvas(cv){
  let painting=false,last=null;
  // 휠로 확대·축소. 커서가 가리키던 지점이 그대로 있게 스크롤도 같이 옮긴다.
  cv.parentNode.parentNode.addEventListener('wheel',e=>{
    if(!base)return;
    e.preventDefault();
    const box=cv.getBoundingClientRect();
    const ox=(e.clientX-box.left)/base.z, oy=(e.clientY-box.top)/base.z;   // 그림 좌표
    const before=base.z;
    setZoom(e.deltaY<0?before+Math.max(1,Math.round(before*0.25)):before-Math.max(1,Math.round(before*0.2)));
    edZoom=0;
    document.querySelectorAll('.ed h2 [data-z]').forEach(t=>t.setAttribute('aria-pressed','false'));
    const sc=cv.closest('.cw');
    if(sc){ sc.scrollLeft += ox*(base.z-before) ; sc.scrollTop += oy*(base.z-before); }
  },{passive:false});
  const pos=e=>{const r=cv.getBoundingClientRect();return{x:(e.clientX-r.left)/base.z,y:(e.clientY-r.top)/base.z}};
  const rd=v=>Math.round(v*10)/10;
  cv.onpointerdown=e=>{
    cv.setPointerCapture(e.pointerId);const p=pos(e);
    if(tool==='picker'){const c=ctxOf();const d=c.getImageData(Math.floor(p.x),Math.floor(p.y),1,1).data;
      color='#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
      setColor(color);return}
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
