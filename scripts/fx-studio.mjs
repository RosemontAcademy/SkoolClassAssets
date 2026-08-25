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
 *  - 옛 판은 bakes/ 에 번호를 붙여 남긴다(편집기 재료 줄로 뜬다)
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
import { readFrames, encodeGif, applyEdits, fillRatio, paletteOf, listItems, sourcesFor, origPath, nextSaveSlot, savePath, compositeInto } from './lib/fxgif.mjs';

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

  // 한 칸은 바닥 낱장 하나와, 그 위에 얹은 층들(over)로 이뤄진다.
  // over 가 없으면 예전 조리법과 똑같은 뜻이라 옛 파일이 그대로 읽힌다.
  const frameOf = (d, k, srcId, i, what) => {
    const got = framesOf(d, k, srcId);
    if (!got || !got.frames[i]) throw new Error(`${what} 낱장을 못 찾았습니다 (${d} ${k} ${srcId}·${i})`);
    if (!w) { w = got.w; h = got.h; }
    if (got.w !== w || got.h !== h)
      throw new Error(`캔버스 크기가 다릅니다 — ${d} ${k} 는 ${got.w}×${got.h}, 이 종은 ${w}×${h}`);
    return got.frames[i];
  };

  for (const step of seq) {
    const px = new Uint8Array(frameOf(dir, kind, step.src, step.i, '바닥'));
    if (step.erase && step.erase.length) applyEdits(px, w, h, step.erase);

    for (const L of step.over || []) {
      const lay = new Uint8Array(frameOf(L.dir || dir, L.kind || kind, L.src, L.i, '얹은 층'));
      if (L.erase && L.erase.length) applyEdits(lay, w, h, L.erase);
      compositeInto(px, lay, w, h, L.dx || 0, L.dy || 0, L.blend || 'normal',
        L.op === undefined ? 1 : L.op);
    }
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

  // 나가는 판을 남긴다. 예전에는 `_prev/` 로 갔는데 편집기가 읽지 않는 곳이라
  // 「예전에 만든 그거」 를 다시 꺼내 쓸 수가 없었다. bakes/ 에 두면 재료 줄로 뜬다.
  // 똑같은 내용이면 안 쌓는다 — 손 안 대고 저장만 눌러도 파일이 늘면 안 된다.
  if (existsSync(target)) {
    const slot = nextSaveSlot(FXD, dir, kind);
    const same = slot.n > 1 && readFileSync(target).equals(readFileSync(savePath(FXD, dir, kind, slot.n - 1)));
    if (!same) {
      mkdirSync(dirname(slot.path), { recursive: true });
      copyFileSync(target, slot.path);
      // 조리법도 같이 — 그때 어떻게 만들었는지가 없으면 파일만 남는다
      const oldRecipe = join(FXD, dir, `recipe.${kind}.json`);
      if (existsSync(oldRecipe)) copyFileSync(oldRecipe, join(FXD, dir, 'bakes', `recipe-${kind}-save${slot.n}.json`));
    }
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
    // 결과물 · 조리법 · 재료(bakes) 를 올린다. 재료가 빠지면 다른 PC 에서
    // 같은 조리법을 돌려도 다른 그림이 나온다 — 조리법이 재료를 가리키기 때문이다.
    // bakes 안의 옛 조리법도 같이 올린다. 그림만 남고 만든 법이 없으면 반쪽이다.
    if (/skillFX\/[^/]+\/[^/]+-fx\.gif$/.test(p)
      || /skillFX\/[^/]+\/recipe\.[a-z]+\.json$/.test(p)
      || /skillFX\/[^/]+\/bakes\/[^/]+\.(gif|json)$/.test(p)) files.push(p);
  }
  return [...new Set(files)];
}

/** 커밋은 됐는데 아직 못 민 것. 푸시만 실패한 판이 조용히 남는 걸 막는다. */
function unpushed() {
  const r = sh('git', ['rev-list', '--count', '@{u}..HEAD']);
  return r.code === 0 ? (parseInt(r.out.trim(), 10) || 0) : 0;
}

async function publish(pinGame = true) {
  const files = pending();
  const ahead = unpushed();

  // 올릴 파일이 없어도, 게임이 아직 옛 커밋을 가리키고 있으면 못박기는 해야 한다.
  // (자산은 올렸는데 게임 코드 갱신만 빠진 상태가 실제로 생긴다)
  if (!files.length && !ahead) {
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

  // 바뀐 파일이 없고 «못 민 커밋» 만 있으면 담기·커밋은 건너뛰고 밀기만 다시 한다.
  const msg = files.length
    ? 'FX 편집기에서 다듬은 연출 ' + gifs.length + '개 — ' + names.join(', ')
    : '못 민 커밋 ' + ahead + '개를 다시 밀었습니다';
  if (files.length) {
    const add = sh('git', ['add', '--', ...files]);
    if (add.code !== 0) return { ok: false, error: '담기 실패: ' + (add.err || add.out) };
    log.push('담음 ' + files.length + '개');

    const ci = sh('git', ['commit', '-m', msg, '--', ...files]);
    if (ci.code !== 0) return { ok: false, error: '커밋 실패: ' + (ci.err || ci.out), log };
    log.push('커밋함');
  } else {
    log.push('못 민 커밋 ' + ahead + '개를 다시 밉니다');
  }

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

// ── 자동 올리기 ──────────────────────────────────────────────────────────────
// 원장님은 「저장」만 누르신다. 올리는 건 «손을 놓은 뒤» 한 번에 묶어서 한다.
//
// 왜 저장할 때마다 안 올리나: 올리기는 자산 저장소 커밋·푸시 + 게임 코드의 그림 주소를
// 새 커밋으로 못박는 커밋·푸시 + 앱 배포(45~105초 실측)다. 2분마다 저장하시는 손버릇에
// 그걸 붙이면 두 시간에 커밋 80개·배포 40번이 되고, 다듬다 만 판이 계속 아이 화면으로
// 나간다. 저장할 때마다 타이머를 3분으로 되밀면, 작업하는 동안엔 아무것도 안 나가고
// 끝난 뒤 한 번만 나간다.
const PUBLISH_DELAY = 3 * 60 * 1000;
const IDLE_EXIT     = 5 * 60 * 1000;   // 열린 탭이 하나도 없으면 스스로 꺼진다
let pubTimer = null, pubAt = 0, pubState = { state: 'idle', message: '' };
let publishing = false, holdUntilNextSave = false, lastBeat = Date.now();
// 이번에 켠 뒤 «저장을 한 번이라도 했는가». 안 했으면 끌 때 아무것도 안 올린다 —
// 예전부터 안 올린 채 남아 있던 남의 작업을, 원장님이 시키지도 않았는데 프로그램이
// 조용히 밀어 올리면 안 된다. 그건 화면의 「지금 올리기」로만 나간다.
let savedThisRun = false;

function schedulePublish() {
  savedThisRun = true;
  holdUntilNextSave = false;
  if (pubTimer) clearTimeout(pubTimer);
  pubAt = Date.now() + PUBLISH_DELAY;
  pubTimer = setTimeout(() => runPublish('시간이 되어'), PUBLISH_DELAY);
  pubState = { state: 'waiting', message: '' };
}
function cancelPublish() {
  if (pubTimer) clearTimeout(pubTimer);
  pubTimer = null; pubAt = 0; holdUntilNextSave = true;
  pubState = { state: 'held', message: '이번엔 안 보냅니다 — 다음 저장 때 다시 준비합니다' };
}
async function runPublish(why) {
  if (publishing) return pubState;
  if (pubTimer) { clearTimeout(pubTimer); pubTimer = null; }
  pubAt = 0;
  if (!pending().length && !unpushed()) { pubState = { state: 'idle', message: '' }; return pubState; }
  publishing = true;
  pubState = { state: 'running', message: why + ' 올리는 중…' };
  try {
    const r = await publish(true);
    pubState = r.ok
      ? { state: 'done', message: '올렸습니다 · ' + (r.gifs || []).length + '개' + (r.game && r.game.ok ? ' · 게임까지 반영' : ''), at: Date.now() }
      : { state: 'failed', message: '못 올렸습니다 — ' + (r.error || '') };
  } catch (e) {
    pubState = { state: 'failed', message: '못 올렸습니다 — ' + e.message };
  }
  publishing = false;
  return pubState;
}
/** 화면이 보여줄 지금 상태. 몇 개가 밀려 있고 몇 초 뒤에 나가는지. */
function pubInfo() {
  return {
    n: pending().length + unpushed(),
    state: pubState.state,
    message: pubState.message || '',
    secondsLeft: pubAt ? Math.max(0, Math.round((pubAt - Date.now()) / 1000)) : 0,
    publishing,
  };
}
/** 끄기 전에 밀린 것을 먼저 올린다 — 안 그러면 저장만 되고 아무도 모르게 남는다. */
async function shutdown(why) {
  console.log('');
  console.log('  ' + why);
  if (savedThisRun && (pending().length || unpushed())) {
    console.log('  아직 안 올린 것이 있어 먼저 올립니다…');
    const r = await runPublish('끄기 전에');
    console.log('  ' + (r.message || ''));
  }
  process.exit(0);
}
setInterval(() => {
  if (publishing || Date.now() - lastBeat < IDLE_EXIT) return;
  shutdown('한동안 아무도 안 써서 편집기를 끕니다.');
}, 30 * 1000).unref();

// ── 서버 ─────────────────────────────────────────────────────────────────────
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // 개발용으로 띄운 SkoolClass(http://localhost:5173)에서 이 서버를 부를 수 있게 연다.
    //
    // 배포된 SkoolClass(https)에서는 **이걸 달아도 안 열린다.** 크롬은 공개 사이트가
    // 집 안 주소를 부르는 걸 권한으로 막아 "Permission was denied for this request"
    // 로 끝난다(2026-08-23 실측). 그래서 설정 화면의 「FX 편집기」 단추는 찔러 보지
    // 않고 그냥 탭을 연다 — 주소 이동은 막히지 않는다.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    // 살아 있느냐만 묻는 자리. 목록을 통째로 읽는 /api/items 로 확인하면
    // 설정 화면을 열 때마다 skillFX 폴더 62개를 훑게 된다.
    if (url.pathname === '/api/ping') { lastBeat = Date.now(); return json(res, 200, { ok: true, port: server.__port }); }

    // 화면이 열려 있는 동안만 켜져 있게 하는 신호. 탭을 닫으면 신호가 끊기고,
    // 5분 뒤 편집기가 밀린 것을 올린 다음 스스로 꺼진다.
    if (url.pathname === '/api/beat') { lastBeat = Date.now(); return json(res, 200, pubInfo()); }
    if (url.pathname === '/api/pubstate') return json(res, 200, pubInfo());
    if (url.pathname === '/api/publish-now' && req.method === 'POST') {
      runPublish('바로').then(st => json(res, 200, st)).catch(e => json(res, 500, { error: e.message }));
      return;
    }
    if (url.pathname === '/api/hold' && req.method === 'POST') { cancelPublish(); return json(res, 200, pubInfo()); }
    if (url.pathname === '/api/quit' && req.method === 'POST') {
      json(res, 200, { ok: true });
      setTimeout(() => shutdown('창을 닫아 편집기를 끕니다.'), 50);
      return;
    }

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
        try { const out = save(JSON.parse(raw)); schedulePublish(); json(res, 200, out); }
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
  // cmd 를 거치면 주소의 & 뒤가 잘린다. rundll32 는 명령줄을 다시 파싱하지 않는다.
  if (OPEN) spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
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

  /* ── 층 ── */
  .slot .lay{position:absolute;top:3px;left:3px;font-size:9px;font-weight:800;letter-spacing:.03em;
    padding:1px 5px;border-radius:5px;background:var(--accent);color:#0A0B0F}
  .slot.drop{border-color:var(--drop);box-shadow:0 0 0 3px color-mix(in srgb,var(--drop) 45%,transparent)}
  .layers{border:2px solid var(--accent);border-radius:12px;padding:10px;margin:8px 0;background:var(--cell)}
  .layers .lhead{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px}
  .layers .lhead .cap{margin:0;text-align:left}
  .layers .lhead button{margin-left:auto}
  .lrows{display:flex;flex-direction:column;gap:6px}
  .lrow{display:flex;align-items:center;gap:8px;padding:5px;border-radius:8px;
    border:1px solid var(--line);background:var(--surface)}
  .lrow.base{border-style:dashed;opacity:.85}
  .lrow img{width:44px;height:44px;object-fit:contain;image-rendering:pixelated;border-radius:5px;
    background-image:linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%),
    linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%);
    background-size:10px 10px;background-position:0 0,5px 5px}
  .lname{flex:1;min-width:90px;font-size:12px;font-family:ui-monospace,Consolas,monospace}
  .lrow select{font-size:11px;padding:2px 4px;border-radius:6px}
  .lrow input[type=range]{width:82px}
  .nudge{display:flex;align-items:center;gap:2px}
  .nudge button{padding:0 5px;font-size:11px;line-height:1.6;border-radius:5px}
  .nudge .cap{margin:0;min-width:44px;text-align:left;font-family:ui-monospace,Consolas,monospace}
  .lrow .x{color:var(--drop);padding:0 6px;border-radius:5px}
  .row.pick{align-items:center;gap:8px;flex-wrap:wrap}
  .row.pick .cap{margin:0;flex-basis:100%;text-align:left}
  .row.foreign{opacity:.95}
  .row.foreign .fr{border-style:dotted}
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
  /* 그을 자리에 뜨는 붓 크기 윤곽. 검은 그림 위에서도 보이게 두 겹으로 두른다. */
  .brushcur{position:absolute;transform:translate(-50%,-50%);border:1px solid #fff;
    box-shadow:0 0 0 1px rgba(0,0,0,.7);border-radius:50%;pointer-events:none;display:none;z-index:5}
  /* 창 모드로 돌아가도 도구가 그림 아래로 접히지 않게. 그림 칸이 자기 안에서 스크롤한다. */
  .ed:not(.full) .edmain{flex-wrap:nowrap}
  .ed:not(.full) .cw{flex:1;min-width:0;max-height:70vh}
  .tools{display:flex;flex-direction:column;gap:8px;min-width:210px;flex:0 0 auto}
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
let leadShort=true,undoStack=[],redoStack=[],blend='screen',showBg=true,showSlots=false,pinGame=true;
// 복사해 둔 칸. 층까지 통째로 담는다 — 공들여 얹은 층을 다시 얹게 만들면 안 된다.
// 손질(붓질)은 낱장에 딸린 것이라 복제해도 그대로 따라온다(열쇠가 src+장번호라서).
let clip=null;
// 옛 재료 줄(원본·굽기·저장본)을 접어 둔다. 리자몽처럼 여러 번 손본 종은 줄이 다섯도
// 되어서, 정작 지금 쓰는 것과 만든 것이 화면 아래로 밀린다(2026-08-25 원장님).
let showOldSources=false;
const rawURL=(src,i)=>'/frame.png?dir='+encodeURIComponent(cur.dir)+'&kind='+cur.kind+'&src='+src+'&i='+i;
// 손질한 낱장은 서버가 아니라 여기서 만든 그림을 쓴다. 안 그러면 지우거나 칠한 것이
// 썸네일·조립 미리보기·게임 화면에 안 보이고, 저장한 뒤에야 나타난다.
const editedCache={};
const furl=(src,i)=>editedCache[K(src,i)]||rawURL(src,i);

// 손질은 «그 칸» 에 붙는다. 같은 낱장을 두 칸이 써도 따로 고칠 수 있어야 하기 때문이다
// (2026-08-25 원장님: 복제한 칸을 고치니 원본 칸까지 같이 바뀌었다).
// 칸에 제 손질이 없으면 재료 낱장에 해 둔 손질을 그대로 쓴다(고치기 시작하면 그때 갈라진다).
let uidSeq=0;
const newUid=()=>++uidSeq;
const slotOwn=s=>'slot:'+s.uid;
const slotKey=s=>(s&&s.uid&&edits[slotOwn(s)])?slotOwn(s):K(s.src,s.i);
const slotEdits=s=>edits[slotKey(s)]||[];
/** 칸마다 번호를 하나씩 쥐여 준다. 복제한 칸은 번호가 없어서 여기서 새로 받는다. */
const stampUids=()=>{seq.forEach(x=>{if(!x.uid)x.uid=newUid()})};

// ── 층 ──────────────────────────────────────────────────────────────────────
// 한 칸은 바닥 낱장 하나와 그 위에 얹은 층들(over)로 이뤄진다.
// over 가 없으면 예전과 똑같이 낱장 하나짜리다 — 옛 조리법이 그대로 읽힌다.
const BLENDS=[['normal','보통'],['screen','밝게'],['add','더하기']];
const CANVAS_OP={normal:'source-over',screen:'screen',add:'lighter'};

// 다른 종에서 가져온 층은 손질을 안 붙인다. 손질 열쇠가 종을 안 담고 있어서
// 'b1#2' 가 종끼리 부딪친다. 얹기만 하면 되는 자리라 이게 안전하다.
const isForeign=L=>!!((L.dir&&L.dir!==cur.dir)||(L.kind&&L.kind!==cur.kind));
const layURL=L=>isForeign(L)
  ? '/frame.png?dir='+encodeURIComponent(L.dir)+'&kind='+L.kind+'&src='+L.src+'&i='+L.i
  : furl(L.src,L.i);
const layName=L=>(isForeign(L)?(L.dir.replace(/^\\d+-/,'')+'·'):'')+shortSrc(L.src)+'·'+L.i;

// 만들어 둔 합성본을 다시 쓰기 위한 이름표. 층 하나라도 바뀌면 달라져야 한다.
//
// 손질을 «개수» 로만 세면 안 된다. 획 하나를 지우고 다른 자리에 하나를 그으면
// 개수가 같아서 이름표가 그대로고, 화면은 예전 합성본을 계속 보여 준다.
// 실제 손질 내용을 짧게 접어 넣는다.
function editSigKey(k){
  const st=edits[k];
  if(!st||!st.length)return '';
  let h=0;const s=JSON.stringify(st);
  for(let n=0;n<s.length;n++){h=(h*31+s.charCodeAt(n))|0}
  return st.length+':'+h;
}
function editSig(src,i){
  const st=edits[K(src,i)];
  if(!st||!st.length)return '';
  let h=0;const s=JSON.stringify(st);
  for(let k=0;k<s.length;k++){h=(h*31+s.charCodeAt(k))|0}
  return st.length+':'+h;
}
const slotSig=s=>JSON.stringify([s.src,s.i,editSigKey(slotKey(s)),
  (s.over||[]).map(L=>[L.dir||'',L.kind||'',L.src,L.i,L.dx|0,L.dy|0,L.blend||'normal',
    L.op===undefined?1:L.op,isForeign(L)?'':editSig(L.src,L.i)])]);
const compCache={};
const nLayers=s=>1+((s.over&&s.over.length)||0);
const slotImg=s=>editedCache[slotKey(s)]||rawURL(s.src,s.i);
const slotURL=s=>(s.over&&s.over.length)?(compCache[slotSig(s)]||slotImg(s)):slotImg(s);

function loadImgs(urls,done){
  const out=[];let left=urls.length;
  if(!left){done(out);return}
  urls.forEach((u,k)=>{const g=new Image();
    g.onload=()=>{out[k]=g;if(!--left)done(out)};
    g.onerror=()=>{out[k]=null;if(!--left)done(out)};
    g.src=u});
}
function buildComposite(s,done){
  const key=slotSig(s);
  if(compCache[key]){done();return}
  loadImgs([furl(s.src,s.i),...s.over.map(layURL)],imgs=>{
    const base=imgs[0];
    if(!base){done();return}
    const c=document.createElement('canvas');c.width=base.width;c.height=base.height;
    const x=c.getContext('2d');x.drawImage(base,0,0);
    s.over.forEach((L,k)=>{
      const g=imgs[k+1];if(!g)return;
      x.globalCompositeOperation=CANVAS_OP[L.blend||'normal']||'source-over';
      x.globalAlpha=L.op===undefined?1:L.op;
      x.drawImage(g,L.dx|0,L.dy|0);
    });
    x.globalCompositeOperation='source-over';x.globalAlpha=1;
    compCache[key]=c.toDataURL('image/png');done();
  });
}
/** 아직 안 만든 합성본이 있으면 만들고 나서 부른다. 없으면 바로 부른다. */
function ensureComposites(done){
  const need=seq.filter(s=>s.over&&s.over.length&&!compCache[slotSig(s)]);
  if(!need.length){done();return}
  let left=need.length;
  need.forEach(s=>buildComposite(s,()=>{if(!--left)done()}));
}
function buildEdited(k,src,i,done){
  const st=edits[k];
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
// 재료 이름과 장 번호를 그냥 붙이면 'b1'+15 와 'b11'+5 가 같은 열쇠가 된다.
// 구분자를 하나 끼운다. 조리법 파일은 src 와 i 를 따로 담으므로 저장본은 안 깨진다.
// 재료 이름을 짧게. 'old'/'new' 두 갈래로 손수 나누던 걸 대신한다 —
// 굽기·저장본이 생긴 뒤로는 그 방식이 전부 «새» 라고 불렀다.
const shortSrc=id=>{
  if(id==='old')return '지금';
  if(id==='live')return '지금';
  // 이 화면은 통짜 문자열 안에 들어 있다. 역슬래시를 하나만 쓰면 브라우저에
  // 닿기 전에 먹혀서 /^b(d+)$/ 가 되고, 조용히 아무것도 안 걸린다.
  let m=/^b(\\d+)$/.exec(id); if(m)return '굽기'+m[1];
  m=/^s(\\d+)$/.exec(id);     if(m)return '저장'+m[1];
  if(id==='new')return '새2';
  m=/^v(\\d+)$/.exec(id);     if(m)return '새'+m[1];
  return id;
};
const K=(src,i)=>src+'#'+i;
// 열쇠를 도로 가르는 자리. 정규식을 쓰면 이 화면이 통짜 문자열이라 역슬래시가
// 먹혀 /^(.+)#(d+)$/ 가 되고, 아무것도 안 걸리면서 조용히 지나간다 — 실제로
// 그래서 조리법을 열어도 손질한 그림이 안 만들어졌다. 글자로 가르면 그럴 일이 없다.
function splitKey(k){
  const at=k.lastIndexOf('#');
  if(at<1)return null;
  const i=Number(k.slice(at+1));
  if(!Number.isInteger(i))return null;
  return [k.slice(0,at),i];
}
const nEdits=(src,i)=>(edits[K(src,i)]||[]).length;
/** 손질해 둔 것들의 그림을 한꺼번에 다시 만든다. 열쇠가 두 갈래라 각각 갈라 본다. */
function rebuildEdited(done){
  const jobs=[];
  Object.keys(edits).forEach(k=>{
    if(k.indexOf('slot:')===0){
      const uid=Number(k.slice(5));
      const st=seq.find(x=>x.uid===uid);
      if(st)jobs.push([k,st.src,st.i]);
    }else{
      const m=splitKey(k);
      if(m)jobs.push([k,m[0],m[1]]);
    }
  });
  let left=jobs.length;
  if(!left){done();return}
  jobs.forEach(j=>buildEdited(j[0],j[1],j[2],()=>{if(--left<=0)done()}));
}

async function boot(){
  await loadCalib();
  items=await (await fetch('/api/items')).json();
  const L=$('#list');
  items.forEach(it=>{const d=el('div','it');d.dataset.id=it.id;
    d.innerHTML='<span>'+it.dir.replace(/^\\d+-/,'')+'</span><small>'+it.kind+'</small>'+(it.done?'<span class="done">●</span>':'');
    d.onclick=()=>load(it);L.appendChild(d)});

  // SkoolClass 설정의 「FX 편집기」 단추가 ?dir=25-pikachu&kind=attack 로 부른다.
  // 62개 목록에서 눈으로 찾게 하면 단추를 만든 의미가 없다.
  const q=new URLSearchParams(location.search);
  // 항목은 «한 칸짜리» item 으로 받는다. dir 과 kind 를 따로 주면 주소에 & 가 들어가는데,
  // 윈도우에서 브라우저를 여는 길에 cmd 가 그걸 명령 구분자로 읽어 뒤를 잘라 먹었다
  // (실측: ?dir=53-persian&kind=attacked → ?dir=53-persian). 그래서 앞모습 단추를 눌러도
  // 늘 뒷모습이 열렸다(2026-08-25 원장님). dir/kind 는 옛 주소 호환으로 남겨 둔다.
  if(q.get('item')||q.get('dir')){
    const want=q.get('item') || (q.get('dir')+' '+(q.get('kind')||'attack'));
    const hit=items.find(it=>it.id===want);
    if(hit){
      load(hit);
      const node=[...L.children].find(n=>n.dataset.id===want);
      if(node)node.scrollIntoView({block:'center'});
    }else{
      // 조용히 첫 항목을 열면 원장님은 엉뚱한 종을 고친 줄도 모른다.
      alert('그 항목이 없습니다: '+want+'\\n아직 굽지 않았거나 폴더 이름이 다릅니다.');
    }
  }
}
async function load(it){
  cur=it;seq=[];edits={};openEd=null;selSlot=null;extras=[];
  Object.keys(compCache).forEach(k=>delete compCache[k]);
  document.querySelectorAll('.it').forEach(n=>n.classList.toggle('on',n.dataset.id===it.id));
  meta={};
  for(const s of it.sources) meta[s.id]=await (await fetch('/api/frames?dir='+encodeURIComponent(it.dir)+'&kind='+it.kind+'&src='+s.id)).json();
  const r=await (await fetch('/api/recipe?dir='+encodeURIComponent(it.dir)+'&kind='+it.kind)).json();
  // 조리법 파일은 칸마다 제 손질을 담고 있다. 읽을 때도 칸에 붙여야 갈라진 채로 살아난다.
  if(r&&r.steps){
    seq=r.steps.map(s=>({src:s.src,i:s.i,uid:newUid(),over:(s.over||[]).map(L=>Object.assign({},L))}));
    r.steps.forEach((s,n)=>{if(s.erase&&s.erase.length)edits['slot:'+seq[n].uid]=s.erase});
  }
  else seq=meta.old.fills.map((_,i)=>({src:'old',i,uid:newUid()}));
  undoStack=[];redoStack=[];                     // 다른 종의 순서로 되돌아가면 안 된다
  Object.keys(editedCache).forEach(k=>delete editedCache[k]);
  rebuildEdited(()=>render());
}
function render(){
  stampUids();
  // 층을 얹은 칸은 합성본이 있어야 그릴 수 있다. 없으면 만들고 다시 들어온다 —
  // 만들어 두면 두 번째에는 이 자리를 그냥 지나간다.
  if(seq.some(s=>s.over&&s.over.length&&!compCache[slotSig(s)])){
    ensureComposites(()=>render());return;
  }
  const b=$('#bar');b.innerHTML='';
  const t=el('span','lbl');t.textContent=cur.dir+' · '+cur.kind+' · '+cur.canvas;b.appendChild(t);
  // 재료가 다섯이면 「…전부」 단추도 다섯이 되어 도구줄이 무슨 줄인지 알 수 없어진다
  // (2026-08-25 원장님: "너무 뭐가 많아 뭐가 뭔지 하나도 모르겠어"). 고르는 칸 하나로 모은다.
  b.appendChild(lab('재료'));
  const pickAll=el('select');
  cur.sources.forEach(s=>{const o=el('option');o.value=s.id;o.textContent=s.label+' ('+s.frames+'장)';pickAll.appendChild(o)});
  // 기본은 «지금 쓰는 것» — 손이 제일 자주 가는 자리다.
  const liveId=(cur.sources.find(s=>s.id==='live')||cur.sources.find(s=>s.id==='old')||cur.sources[0]).id;
  pickAll.value=liveId;
  b.appendChild(pickAll);
  const takeAll=el('button');takeAll.textContent='다 담기';
  takeAll.title='고른 재료의 낱장을 처음부터 끝까지 「만든 것」 에 담습니다';
  takeAll.onclick=()=>{const id=pickAll.value;if(!meta[id])return;
    push();seq=meta[id].fills.map((_,i)=>({src:id,i,uid:newUid()}));render()};
  b.appendChild(takeAll);
  const cl=el('button');cl.textContent='비우기';cl.onclick=()=>{push();seq=[];render()};b.appendChild(cl);
  b.appendChild(gap());
  // 자주 안 바꾸는 값들은 고르는 칸으로 접는다 — 단추로 늘어놓으면 도구줄이 스무 개가 되어
  // 정작 손이 가는 「저장」 이 어디 있는지 안 보인다(2026-08-25 원장님).
  const pick=(label,title,opts,cur0,fn)=>{
    b.appendChild(lab(label));
    const sl=el('select');sl.title=title;
    opts.forEach(([n,v])=>{const o=el('option');o.value=String(v);o.textContent=n;sl.appendChild(o)});
    sl.value=String(cur0);
    sl.onchange=()=>fn(sl.value);
    b.appendChild(sl);
  };
  pick('배경','낱장 뒤에 깔 바탕 — 밝은 이펙트는 어두움에서 잘 보입니다',
    [['체커',''],['어두움','dark'],['밝음','light'],['회색','grey'],['없음','none']],
    (document.body.dataset.bg||''),
    v=>{if(v)document.body.dataset.bg=v;else delete document.body.dataset.bg;render()});
  pick('보기 크기','낱장을 화면에 몇 배로 크게 보여줄지',
    [['1배',1],['1.5배',1.5],['2배',2]], zoom,
    v=>{zoom=Number(v);document.documentElement.style.setProperty('--z',zoom);render()});
  b.appendChild(gap());
  pick('한 바퀴','이펙트 한 바퀴에 쓸 시간 — 장수에 맞춰 장당 시간이 정해집니다',
    [['1.5초',1500],['2초',2000],['3초',3000]], fit,
    v=>{fit=Number(v);render()});
  const ls=el('button');ls.textContent='첫 장 짧게';ls.setAttribute('aria-pressed',String(leadShort));
  ls.title='0번 장은 이펙트가 없는 맨 스프라이트라 짧게 주는 게 자연스럽습니다';
  ls.onclick=()=>{leadShort=!leadShort;render()};b.appendChild(ls);
  b.appendChild(gap());
  const ud=el('button');ud.textContent='↶';ud.disabled=!undoStack.length;
  ud.title='되돌리기 (Ctrl+Z) — 붓질까지 포함해 마지막 한 가지를 되돌립니다';
  ud.onclick=undo;b.appendChild(ud);
  const rd2=el('button');rd2.textContent='↷';rd2.disabled=!redoStack.length;
  rd2.title='다시하기 (Ctrl+Shift+Z) — 되돌린 것을 도로 합니다';
  rd2.onclick=redo;b.appendChild(rd2);
  // 단추는 「저장」 하나다. 올리는 건 손을 놓으면 알아서 한 번에 나간다 —
  // 아래 상태줄(#pubbar)이 언제 나가는지 말해 주고, 거기서 앞당기거나 미룰 수 있다.
  const sv=el('button','primary');sv.textContent='저장';sv.disabled=!seq.length;sv.onclick=save;b.appendChild(sv);
  const qb=el('button');qb.textContent='끝내기';
  qb.title='안 올린 게 있으면 올리고 편집기를 끕니다';
  qb.onclick=async()=>{
    if(!confirm('편집기를 끕니다. 안 올린 게 있으면 올리고 끕니다.'))return;
    try{await fetch('/api/quit',{method:'POST'})}catch(e){}
    document.body.innerHTML='<div style="padding:40px;font:600 15px system-ui">편집기를 껐습니다. 이 탭은 닫으셔도 됩니다.</div>';
  };b.appendChild(qb);

  stripTimers.forEach(clearInterval);stripTimers=[];
  const W=$('#work');W.innerHTML='';
  // 원본과 «지금 쓰는 것» 은 늘 보인다. 굽기·저장본 기록은 접어 둔다 —
  // 필요할 때만 펼치면 된다. 안 그러면 줄이 다섯이 되어 만든 것이 화면 밖으로 밀린다.
  const isOld=s=>/^(b|s)\\d+$/.test(s.id);
  const shown=cur.sources.filter(s=>showOldSources||!isOld(s));
  const hidden=cur.sources.length-shown.length;
  shown.forEach(s=>W.appendChild(strip(s)));
  if(hidden>0||showOldSources){
    const t=el('button');t.style.margin='2px 0 8px';
    t.textContent=showOldSources?'옛 판 접기':('옛 판 '+hidden+'줄 펼치기');
    t.title='굽기·저장본 기록입니다. 지금 쓰는 것과 원본은 항상 보입니다.';
    t.onclick=()=>{showOldSources=!showOldSources;render()};
    W.appendChild(t);
  }
  extras.forEach(x=>W.appendChild(extraStrip(x)));
  W.appendChild(foreignPicker());
  W.appendChild(seqRow());
  if(selSlot!==null&&seq[selSlot]) W.appendChild(layersPanel(selSlot));
  const D=delays();const loop=D.reduce((a,b)=>a+b,0);
  const info=el('div','msg');
  info.innerHTML=seq.length
    ? seq.length+'장 · '+(leadShort&&seq.length>1?'첫 장 <b>'+D[0]+'ms</b> + 나머지 <b>'+D[1]+'ms</b>':'장당 <b>'+D[0]+'ms</b>')
      +' · 한 바퀴 <b>'+loop+'ms</b> → 창 '+(fit/1000)+'초 안에서 <b>'+(fit/loop).toFixed(2)+'바퀴</b>'
    :'낱장을 눌러 크게 보고, ＋로 담으세요.';
  W.appendChild(info);
  W.appendChild(pubBar());
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
// ── 되돌리기 ────────────────────────────────────────────────────────────────
// 역사는 **하나**다. 캔바가 그렇듯 붓질이든 순서 바꾸기든 층 얹기든 같은 줄에
// 쌓이고 Ctrl+Z 한 번이 마지막 한 가지를 되돌린다.
// 예전에는 두 겹이었다 — 툴바 되돌리기는 칸·층만, 편집기 안의 되돌리기는 붓질만.
// 그래서 «되돌렸는데 안 돌아간다» 가 생겼다. 어느 되돌리기인지 손이 알 수가 없다.
//
// 되돌릴 것에 손질(edits)과 편집 중인 붓질(strokes)까지 담는다. 붓질을 빼면
// 지우개로 그은 것이 되돌리기 대상 밖에 남는다.
const snapshot=()=>JSON.stringify({seq,edits,openEd,strokes});
function push(){
  undoStack.push(snapshot());
  if(undoStack.length>60)undoStack.shift();
  redoStack=[];                     // 새로 뭔가 했으면 앞으로 가던 길은 사라진다
}
function applySnap(js){
  const o=JSON.parse(js);
  seq=o.seq||[];edits=o.edits||{};openEd=o.openEd||null;
  Object.keys(editedCache).forEach(k=>delete editedCache[k]);
  Object.keys(compCache).forEach(k=>delete compCache[k]);
  // 편집기를 열어 둔 채로 되돌렸으면, 그때 긋고 있던 붓질까지 그대로 되살린다.
  // mountedKey 를 맞춰 둬야 화면이 붙으면서 저장본으로 덮어쓰지 않는다.
  strokes=(o.strokes||[]).slice();
  mountedKey=openEd?openEd.key:null;
  rebuildEdited(()=>render());
}
function undo(){if(!undoStack.length)return;redoStack.push(snapshot());applySnap(undoStack.pop())}
function redo(){if(!redoStack.length)return;undoStack.push(snapshot());applySnap(redoStack.pop())}
const gap=()=>{const s=el('span');s.style.flex='1';return s};
const lab=t=>{const s=el('span','lbl');s.textContent=t;return s};

function strip(s){
  const row=el('div','row');
  const box=el('div');const st=el('div','stage');const im=el('img');st.appendChild(im);box.appendChild(st);
  const c=el('div','cap');c.textContent=s.label+' '+s.frames+'장';box.appendChild(c);row.appendChild(box);
  let k=0;stripTimers.push(setInterval(()=>{if(!meta[s.id])return;k=(k+1)%s.frames;im.src=furl(s.id,k)},250));
  const sp=el('div','strip');
  for(let i=0;i<s.frames;i++){
    const f=meta[s.id].fills[i],blank=i>0&&f<meta[s.id].fills[0]*0.25;
    const b=el('div','fr'+(blank?' blank':'')+(nEdits(s.id,i)?' edited':'')+(openEd&&openEd.key===K(s.id,i)?' sel':''));
    b.draggable=true;
    const img=el('img');img.src=furl(s.id,i);b.appendChild(img);
    const m=el('div','m');m.textContent=i+' · '+f+'%'+(blank?' 빔':'');b.appendChild(m);
    b.onclick=()=>{const c=commitStrokes();openEd={src:s.id,i,key:K(s.id,i)};mountedKey=null;
      const go=()=>{render();setTimeout(()=>{const e=document.querySelector('.ed');if(e)e.scrollIntoView({behavior:'smooth',block:'nearest'})},30)};
      if(c)buildEdited(c.key,c.src,c.i,go);else go()};
    const a=el('button','add');a.textContent='＋';a.title='만든 것에 담기';
    a.onclick=e=>{e.stopPropagation();push();seq.push({src:s.id,i});render()};b.appendChild(a);
    b.addEventListener('dragstart',e=>{drag={kind:'add',src:s.id,i};b.classList.add('dragging');e.dataTransfer.effectAllowed='copy'});
    b.addEventListener('dragend',()=>{b.classList.remove('dragging');clearMark();drag=null});
    sp.appendChild(b);
  }
  row.appendChild(sp);return row;
}
/** 칸 하나를 통째로 베낀다. 층 목록까지 새 배열로 뜬다 —
    얕게 베끼면 한쪽 층을 옮겼을 때 다른 칸도 같이 움직인다. */
function copySlot(s){
  return { src:s.src, i:s.i, over:(s.over||[]).map(L=>Object.assign({},L)) };
}
function seqRow(){
  const row=el('div','row seq');
  const box=el('div');const st=el('div','stage');const im=el('img');im.id='seqimg';st.appendChild(im);box.appendChild(st);
  const c=el('div','cap');c.textContent='만든 것 '+seq.length+'장';box.appendChild(c);row.appendChild(box);
  const sp=el('div','strip');sp.id='seqstrip';
  seq.forEach((s,n)=>{
    const b=el('div','slot'+(s.src==='old'?' old':'')+(slotEdits(s).length?' edited':'')
      +(openEd&&openEd.key===slotOwn(s)?' sel':''));
    b.draggable=true;b.dataset.n=n;b.title='눌러서 이 낱장 편집 · 낱장을 여기로 끌어다 놓으면 위에 얹습니다';
    const img=el('img');img.src=slotURL(s);b.appendChild(img);
    const m=el('div','m');m.textContent=shortSrc(s.src)+'·'+s.i;b.appendChild(m);
    if(s.over&&s.over.length){
      const lg=el('div','lay');lg.textContent='층 '+nLayers(s);
      lg.title=[shortSrc(s.src)+'·'+s.i+' (바닥)',...s.over.map(layName)].join(' → ');
      b.appendChild(lg);
    }
    // 낱장을 칸 «위로» 끌어다 놓으면 새 칸이 아니라 그 칸의 층이 된다.
    b.addEventListener('dragover',e=>{
      if(!drag||drag.kind==='move')return;
      e.preventDefault();e.stopPropagation();clearMark();b.classList.add('drop')});
    b.addEventListener('dragleave',()=>b.classList.remove('drop'));
    b.addEventListener('drop',e=>{
      if(!drag||drag.kind==='move')return;
      e.preventDefault();e.stopPropagation();b.classList.remove('drop');
      push();
      s.over=s.over||[];
      s.over.push({dir:drag.dir||undefined,kind:drag.dirKind||undefined,src:drag.src,i:drag.i,
                   dx:0,dy:0,blend:'normal',op:1});
      selSlot=n;drag=null;render()});
    // 담아 놓고 보다가 손보고 싶어지는 게 자연스러운 순서다. 재료 줄로 되돌아가
    // 같은 낱장을 다시 찾게 만들면 안 된다.
    b.onclick=()=>{const c=commitStrokes();openEd={src:s.src,i:s.i,key:slotOwn(s)};mountedKey=null;
      const go=()=>{render();setTimeout(()=>{const e=document.querySelector('.ed');if(e)e.scrollIntoView({behavior:'smooth',block:'nearest'})},30)};
      if(c)buildEdited(c.key,c.src,c.i,go);else go()};
    const ops=el('div','ops');
    [['✎','edit'],['層','lay'],['⧉','dup'],['◀',-1],['▶',1],['×',0]].forEach(([t,d])=>{
      const x=el('button',d===0?'x':'');x.textContent=t;
      if(d==='lay')x.title='이 칸의 층 다루기';
      if(d==='dup')x.title='이 칸을 바로 뒤에 하나 더 (Ctrl+C · Ctrl+V 로도 됩니다)';
      x.onclick=e=>{e.stopPropagation();
        if(d==='edit'){b.onclick();return}
        if(d==='lay'){selSlot=(selSlot===n?null:n);render();return}
        if(d==='dup'){push();seq.splice(n+1,0,copySlot(seq[n]));selSlot=null;render();return}
        push();
        if(d===0)seq.splice(n,1);
        else{const j=n+d;if(j<0||j>=seq.length)return;[seq[n],seq[j]]=[seq[j],seq[n]]}
        if(selSlot!==null&&selSlot>=seq.length)selSlot=null;
        render()};
      ops.appendChild(x)});
    b.appendChild(ops);
    b.addEventListener('dragstart',e=>{drag={kind:'move',n};b.classList.add('dragging');e.dataTransfer.effectAllowed='move'});
    b.addEventListener('dragend',()=>{b.classList.remove('dragging');clearMark();drag=null});
    sp.appendChild(b);
  });
  sp.addEventListener('dragover',e=>{if(!drag)return;e.preventDefault();markAt(sp,e.clientX)});
  sp.addEventListener('drop',e=>{if(!drag)return;e.preventDefault();
    // 다른 종 낱장은 바닥이 될 수 없다 — 캔버스 기준이 흔들린다. 칸 «위» 로 놓아야 한다.
    if(drag.kind==='layer'){clearMark();drag=null;
      const m=el('div','msg err');m.textContent='다른 종 낱장은 칸 사이가 아니라 칸 «위» 로 끌어다 놓아 층으로 얹어 주세요.';
      $('#work').appendChild(m);setTimeout(()=>m.remove(),4000);return}
    push();
    const at=markIndex(sp);
    if(drag.kind==='add')seq.splice(at,0,{src:drag.src,i:drag.i});
    else{const [m]=seq.splice(drag.n,1);seq.splice(at>drag.n?at-1:at,0,m)}
    clearMark();drag=null;render()});
  row.appendChild(sp);return row;
}
// ── 다른 종 재료 ────────────────────────────────────────────────────────────
// 「스프라이트 여러 개를 섞는다」 는 종을 넘나든다는 뜻이기도 하다. 다른 종의
// 낱장을 재료 줄로 불러와 두면, 얹는 방법은 같은 종 재료와 똑같아진다.
// 손질(지우개·연필)은 안 붙인다 — 손질 열쇠가 종을 안 담아서 부딪친다.
let extras=[];
function foreignPicker(){
  const row=el('div','row pick');
  const t=el('span','lbl');t.textContent='다른 종 불러오기';row.appendChild(t);
  const sel=el('select');
  const none=el('option');none.value='';none.textContent='— 고르세요 —';sel.appendChild(none);
  items.filter(it=>it.id!==cur.id&&it.w===cur.w&&it.h===cur.h).forEach(it=>{
    const o=el('option');o.value=it.id;
    o.textContent=it.dir.replace(/^\\d+-/,'')+' · '+(it.kind==='attack'?'공격':'맞는 쪽');
    sel.appendChild(o)});
  row.appendChild(sel);
  const add=el('button');add.textContent='재료 줄에 더하기';
  add.onclick=async()=>{
    const it=items.find(x=>x.id===sel.value);if(!it)return;
    add.disabled=true;add.textContent='읽는 중…';
    for(const s of it.sources){
      const key=it.dir+'|'+it.kind+'|'+s.id;
      if(extras.some(x=>x.key===key))continue;
      const m=await (await fetch('/api/frames?dir='+encodeURIComponent(it.dir)+'&kind='+it.kind+'&src='+s.id)).json();
      extras.push({key,dir:it.dir,kind:it.kind,src:s.id,label:it.dir.replace(/^\\d+-/,'')+' '+
        (it.kind==='attack'?'공격':'맞는 쪽')+' · '+s.label,fills:m.fills});
    }
    add.disabled=false;add.textContent='재료 줄에 더하기';render()};
  row.appendChild(add);
  if(extras.length){
    const cl=el('button');cl.textContent='불러온 것 치우기';
    cl.onclick=()=>{extras=[];render()};row.appendChild(cl);
  }
  const cap=el('div','cap');
  cap.textContent='캔버스 크기가 같은 종만 나옵니다 — 크기가 다르면 못 겹칩니다.';
  row.appendChild(cap);
  return row;
}
function extraStrip(x){
  const row=el('div','row foreign');
  const box=el('div');const c=el('div','cap');c.textContent=x.label;box.appendChild(c);row.appendChild(box);
  const sp=el('div','strip');
  x.fills.forEach((f,i)=>{
    const b=el('div','fr');
    const img=el('img');img.src='/frame.png?dir='+encodeURIComponent(x.dir)+'&kind='+x.kind+'&src='+x.src+'&i='+i;
    b.appendChild(img);
    const m=el('div','m');m.textContent=i+' · '+f+'%';b.appendChild(m);
    b.draggable=true;b.title='칸 위로 끌어다 놓으면 층으로 얹힙니다';
    b.addEventListener('dragstart',e=>{drag={kind:'layer',dir:x.dir,dirKind:x.kind,src:x.src,i};
      b.classList.add('dragging');e.dataTransfer.effectAllowed='copy'});
    b.addEventListener('dragend',()=>{b.classList.remove('dragging');clearMark();drag=null});
    sp.appendChild(b);
  });
  row.appendChild(sp);return row;
}

/**
 * 한 칸의 층 목록. 아래가 바닥, 위로 갈수록 나중에 얹힌다 —
 * 목록도 그 순서 그대로 위가 위다.
 */
function layersPanel(n){
  const s=seq[n];
  const box=el('div','layers');
  const h=el('div','lhead');
  h.innerHTML='<b>'+(n+1)+'번째 칸</b> 의 층 '+nLayers(s)+'개 <span class="cap">— 위에 있는 것이 위에 그려집니다</span>';
  const cl=el('button');cl.textContent='닫기';cl.onclick=()=>{selSlot=null;render()};h.appendChild(cl);
  box.appendChild(h);

  const rows=el('div','lrows');
  // 위에 얹은 것부터 보여 준다. 화면 순서와 그려지는 순서를 뒤집으면 헷갈린다.
  (s.over||[]).slice().reverse().forEach((L,rev)=>{
    const k=s.over.length-1-rev;
    const r=el('div','lrow');
    const im=el('img');im.src=layURL(L);r.appendChild(im);
    const nm=el('div','lname');nm.textContent=layName(L);r.appendChild(nm);

    const bl=el('select');bl.title='합성 방식';
    BLENDS.forEach(([v,t])=>{const o=el('option');o.value=v;o.textContent=t;
      if((L.blend||'normal')===v)o.selected=true;bl.appendChild(o)});
    bl.onchange=()=>{push();L.blend=bl.value;render()};r.appendChild(bl);

    const op=el('input');op.type='range';op.min='0';op.max='100';op.step='5';
    op.value=String(Math.round((L.op===undefined?1:L.op)*100));
    op.title='투명도';
    op.onchange=()=>{push();L.op=(+op.value)/100;render()};r.appendChild(op);

    const nudge=el('div','nudge');
    [['←',-1,0],['→',1,0],['↑',0,-1],['↓',0,1]].forEach(([t,ax,ay])=>{
      const x=el('button');x.textContent=t;x.title='자리 옮기기 (Shift 누르면 8칸)';
      x.onclick=e=>{push();const m=e.shiftKey?8:1;
        L.dx=(L.dx|0)+ax*m;L.dy=(L.dy|0)+ay*m;render()};
      nudge.appendChild(x)});
    const pos=el('span','cap');pos.textContent=(L.dx|0)+','+(L.dy|0);nudge.appendChild(pos);
    r.appendChild(nudge);

    const mv=el('div','nudge');
    [['▲',1],['▼',-1]].forEach(([t,d])=>{
      const x=el('button');x.textContent=t;x.title=d>0?'위로':'아래로';
      x.onclick=()=>{const j=k+d;
        if(j<0){ // 바닥보다 더 아래로 — 바닥과 자리를 바꾼다
          // 막을 거면 **건드리기 전에** 막아야 한다. 예전에는 바닥을 먼저 바꿔 놓고
          // 알림창을 띄워서, «못 내립니다» 를 읽는 사이 바닥이 이미 망가져 있었다.
          if(isForeign(L)){alert('다른 종에서 가져온 층은 바닥으로 못 내립니다.\\n캔버스 기준이 흔들립니다.');return}
          push();
          const b={src:s.src,i:s.i,dx:0,dy:0,blend:'normal',op:1};
          s.src=L.src;s.i=L.i;
          s.over[k]=b;render();return}
        if(j>=s.over.length)return;
        push();[s.over[k],s.over[j]]=[s.over[j],s.over[k]];render()};
      mv.appendChild(x)});
    r.appendChild(mv);

    const rm=el('button','x');rm.textContent='×';rm.title='이 층 빼기';
    rm.onclick=()=>{push();s.over.splice(k,1);if(!s.over.length)delete s.over;render()};
    r.appendChild(rm);
    rows.appendChild(r);
  });

  const base=el('div','lrow base');
  const bim=el('img');bim.src=furl(s.src,s.i);base.appendChild(bim);
  const bnm=el('div','lname');bnm.textContent=shortSrc(s.src)+'·'+s.i;base.appendChild(bnm);
  const bt=el('span','cap');bt.textContent='바닥';base.appendChild(bt);
  rows.appendChild(base);
  box.appendChild(rows);

  const tip=el('div','cap');
  tip.textContent='재료 줄의 낱장을 이 칸 위로 끌어다 놓으면 층으로 얹힙니다. 다른 종 재료는 위 「다른 종 불러오기」 로 가져오세요.';
  box.appendChild(tip);
  return box;
}

let drag=null,mark=null,selSlot=null;
// 재료 줄의 미리보기 타이머. 다시 그릴 때 옛 것을 안 끄면 계속 쌓인다.
let stripTimers=[];
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
  const step=()=>{const u=slotURL(seq[k]);
    im.src=u;if(gm)gm.src=u;
    const d=D[k];k=(k+1)%seq.length;playT=setTimeout(step,d)};
  step();
}
async function save(){
  commitStrokes();          // 그리다 만 붓질도 저장에 담는다 — 「적용」을 잊어도 잃지 않게
  stampUids();
  // 무슨 일이 일어났는지 «누른 자리에서» 보여야 한다. 알림을 화면 맨 아래에만 붙이면
  // 스크롤 밖이라 못 본다(2026-08-25 원장님: "저장 누르면 뭐가 됐는지 알 수가 없다").
  const sv=[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='저장');
  const svOld=sv?sv.textContent:'';
  if(sv){sv.disabled=true;sv.textContent='저장 중…'}
  toast('저장하는 중…');
  const steps=seq.map(s=>({src:s.src,i:s.i,erase:slotEdits(s),
    over:(s.over||[]).map(L=>({dir:L.dir,kind:L.kind,src:L.src,i:L.i,dx:L.dx|0,dy:L.dy|0,
      blend:L.blend||'normal',op:L.op===undefined?1:L.op,
      erase:isForeign(L)?[]:(edits[K(L.src,L.i)]||[])}))}));
  const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({dir:cur.dir,kind:cur.kind,seq:steps,fitMs:fit,leadShort})});
  const j=await r.json();
  const m=el('div','msg '+(j.ok?'ok':'err'));
  m.innerHTML=j.ok?'저장했습니다 — '+j.frames+'장 · 한 바퀴 '+j.loop_ms+'ms<br>옛 판은 재료 줄에 「저장본」 으로 남습니다. 아이들 화면까지는 아래 줄이 알아서 보냅니다.':'실패: '+j.error;
  beat();
  if(sv){sv.disabled=false;sv.textContent=svOld}
  toast(j.ok?('저장했습니다 — '+j.frames+'장 · 한 바퀴 '+j.loop_ms+'ms'):('저장 실패 — '+(j.error||'')),j.ok?'ok':'err');
  $('#work').appendChild(m);m.scrollIntoView({behavior:'smooth',block:'nearest'});
  if(j.ok){const n=document.querySelector('.it.on');if(n&&!n.querySelector('.done')){const d=el('span','done');d.textContent='●';n.appendChild(d)}}
}

/**
 * 올리기 상태줄. 「저장」 말고는 손댈 게 없어야 하지만, 지금 어떤 상태인지는
 * 늘 보여야 한다 — 예전에는 저장만 하고 안 올린 걸 화면으로 알 수가 없었다
 * (리자몽이 실제로 그렇게 하루를 넘겼다).
 */
/** 한쪽 구석에 잠깐 뜨는 쪽지. 화면을 다시 그리지 않고 알려 줘야 할 때 쓴다. */
function toast(text,tone){
  const old=document.getElementById('toast');if(old)old.remove();
  const t=el('div');t.id='toast';t.textContent=text;
  const line=tone==='err'?'var(--drop)':(tone==='ok'?'var(--accent)':'var(--line)');
  t.style.cssText='position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:200;'
    +'background:var(--surface);border:2px solid '+line+';color:var(--ink);'
    +'padding:10px 18px;border-radius:12px;font-size:14px;font-weight:700;box-shadow:0 10px 30px rgba(0,0,0,.4)';
  document.body.appendChild(t);
  setTimeout(()=>{t.remove()},tone==='err'?6000:2600);
}
function pubBar(){
  setTimeout(beat,0);
  const d=el('div','msg');d.id='pubbar';d.style.display='flex';d.style.alignItems='center';d.style.gap='10px';
  const t=el('span');t.id='pubtext';t.textContent='…';d.appendChild(t);
  const sp=el('span');sp.style.flex='1';d.appendChild(sp);
  const now=el('button');now.textContent='지금 올리기';now.onclick=async()=>{
    now.disabled=true;const t=document.getElementById('pubtext');if(t)t.textContent='올리는 중… (1~2분)';
    try{await fetch('/api/publish-now',{method:'POST'})}catch(e){}
    now.disabled=false;beat();};
  const hold=el('button');hold.textContent='이번엔 안 보내기';hold.onclick=async()=>{
    try{await fetch('/api/hold',{method:'POST'})}catch(e){}beat();};
  now.id='pubnow';hold.id='pubhold';
  d.append(now,hold);
  return d;
}
/** 서버에 지금 상태를 묻는다. 이 부름이 «화면이 열려 있다» 는 신호도 된다 —
    탭을 닫으면 신호가 끊기고 편집기가 스스로 꺼진다. */
async function beat(){
  let j;
  try{ j=await (await fetch('/api/beat')).json() }catch(e){ return }
  const t=document.getElementById('pubtext');if(!t)return;
  const bar=document.getElementById('pubbar');
  // 올릴 게 없으면 단추를 숨긴다. 늘 떠 있으면 무엇을 눌러야 하는지 알 수 없다.
  const now=document.getElementById('pubnow'), hold=document.getElementById('pubhold');
  const busy=j.publishing||j.n>0;
  if(now)now.style.display=busy?'':'none';
  if(hold)hold.style.display=(j.n>0&&!j.publishing&&j.state!=='held')?'':'none';
  bar.classList.remove('ok','err');
  if(j.publishing){ t.textContent='올리는 중… (1~2분)'; }
  else if(j.state==='failed'){ bar.classList.add('err'); t.innerHTML='<b>'+j.message+'</b> — 「지금 올리기」로 다시 해보세요'; }
  else if(j.n===0){ t.textContent=j.state==='done'?(j.message||'다 올렸습니다'):'올릴 것이 없습니다'; if(j.state==='done')bar.classList.add('ok'); }
  else if(j.state==='held'){ t.textContent='안 올린 것 '+j.n+'개 · 이번엔 안 보냅니다 (다음 저장 때 다시 준비)'; }
  else if(j.secondsLeft>0){ const m=Math.floor(j.secondsLeft/60),sec=j.secondsLeft%60;
    t.textContent='안 올린 것 '+j.n+'개 · '+(m?m+'분 ':'')+sec+'초 뒤 자동으로 올라갑니다'; }
  else { t.textContent='안 올린 것 '+j.n+'개 · 저장하면 3분 뒤 자동으로 올라갑니다'; }
}
setInterval(beat,3000);

/** 「지금 올리기」 — 서버가 쥐고 있는 그 타이머를 그냥 당겨 실행한다. */
async function publishNow(){
  try{ await fetch('/api/publish-now',{method:'POST'}) }catch(e){}
  beat();
}

// 단축키 — 되돌리기와 저장은 손이 먼저 간다.
addEventListener('keydown',e=>{
  const typing=/^(INPUT|TEXTAREA)$/.test((e.target||{}).tagName||'');
  if(!(e.ctrlKey||e.metaKey)||typing)return;
  const k=e.key.toLowerCase();
  // 어디에 있든 같은 역사를 되돌린다. 편집기 안이라고 다른 되돌리기가 도는 게
  // 캔바를 쓰다 온 손에는 «안 돌아간다» 로 느껴진다.
  if(k==='z'){ e.preventDefault(); e.shiftKey?redo():undo(); }
  if(k==='y'){ e.preventDefault(); redo(); }
  if(k==='c'){
    // 글자를 고르고 있으면 그건 진짜 복사다 — 뺏지 않는다.
    if(String(getSelection()||'').length) return;
    if(openEd&&sel){ e.preventDefault(); selClip=Object.assign({},sel); toast('고른 곳을 복사했습니다 — Ctrl+V 로 붙입니다'); return; }
    if(selSlot!==null&&seq[selSlot]){ e.preventDefault(); clip=copySlot(seq[selSlot]); toast('칸을 복사했습니다 — Ctrl+V 로 붙입니다'); }
    else if(openEd){ e.preventDefault(); clip={src:openEd.src,i:openEd.i,over:[]}; toast('이 낱장을 복사했습니다 — Ctrl+V 로 붙입니다'); }
    return;
  }
  if(k==='v'&&openEd&&selClip){
    e.preventDefault();push();
    const off=Math.max(2,Math.round(Math.min(selClip.w,selClip.h)*0.15));
    strokes.push({t:'blit',sx:selClip.x,sy:selClip.y,sw:selClip.w,sh:selClip.h,
      dx:selClip.x+off,dy:selClip.y+off,dw:selClip.w,dh:selClip.h,rot:0,fx:0,fy:0,cut:0});
    sel={x:selClip.x+off,y:selClip.y+off,w:selClip.w,h:selClip.h};
    redraw();drawSel();updateSelLab();toast('붙였습니다 — 끌어서 자리를 잡으세요');
    return;
  }
  if(k==='v'){
    if(!clip) return;
    e.preventDefault(); push();
    const at = selSlot!==null ? selSlot+1 : seq.length;
    seq.splice(at,0,copySlot(clip));
    selSlot=at; render();
    toast('붙였습니다');
    return;
  }
  if(k==='s'){ e.preventDefault();
    // 낱장 편집 중이면 '이 낱장에 적용', 아니면 전체 저장. 손이 가는 곳이 다르다.
    if(openEd){ document.getElementById('eapply')?.click(); }
    else if(cur&&seq.length){ save(); }
  }
});

// 도구 단축키 — Aseprite 와 같은 글쇠다. 손이 이미 그리로 간다.
const TOOLKEY={b:'pencil',e:'eraser',i:'picker',g:'bucket',v:'move',n:'swap'};
const typingNow=e=>/^(INPUT|TEXTAREA)$/.test((e.target||{}).tagName||'');
addEventListener('keydown',e=>{
  if(!openEd||e.ctrlKey||e.metaKey||e.altKey||typingNow(e))return;
  if(e.code==='Space'){ e.preventDefault();
    if(!spaceDown){spaceDown=true;const c=document.getElementById('cv');if(c)c.style.cursor='grab'} return; }
  const k=e.key.toLowerCase();
  if(TOOLKEY[k]){e.preventDefault();setTool(TOOLKEY[k]);return}
  if(k==='['){e.preventDefault();setBrush(brush-1)}
  if(k===']'){e.preventDefault();setBrush(brush+1)}
});
addEventListener('keyup',e=>{
  if(e.code!=='Space')return;
  spaceDown=false;const c=document.getElementById('cv');if(c&&c.style.cursor!=='grabbing')c.style.cursor='crosshair';
});

// ── 큰 편집기 ────────────────────────────────────────────────────────────
// 편집은 전용 작업대에서 한다(Aseprite·Canva 와 같다). 예전 기본이던 «창 모드» 는
// 그림 칸과 도구 칸이 한 줄에 안 들어가면 도구가 그림 «아래» 로 접혀서, 8배만 넘겨도
// 도구가 화면 밖(실측 y=1648, 창 높이 905)으로 사라졌다. 「창으로」 는 남겨 둔다.
let tool='pencil',color='#ffffff',brush=2,tol=20,onionOn=false,strokes=[],base=null,pal=[],edZoom=0,edFull=true,mountedKey=null,spaceDown=false;
// 「선택」 으로 고른 사각형(그림 좌표). 고른 게 없으면 null.
let sel=null;
// 복사해 둔 조각의 자리. 붙이면 그 자리에서 조금 옮겨 놓는다.
let selClip=null;
/** 고른 사각형을 화면에 점선으로 그린다. 캔버스에 그리면 손질로 구워지므로 겹쳐 둔 칸으로 그린다. */
function updateSelLab(){
  const l=document.getElementById('sellab');
  if(l)l.textContent=sel?('고른 곳 '+sel.w+'×'+sel.h):'고른 곳 없음';
  document.querySelectorAll('#selrow button').forEach(b=>{b.disabled=!sel});
}
function drawSel(){
  const box=document.querySelector('.selbox');
  if(!sel||!base){if(box)box.remove();return}
  const b=box||el('div','selbox');
  b.style.cssText='position:absolute;pointer-events:none;z-index:6;'
    +'outline:1px dashed #fff;box-shadow:0 0 0 1px rgba(0,0,0,.7);'
    +'left:'+(sel.x*base.z)+'px;top:'+(sel.y*base.z)+'px;'
    +'width:'+(sel.w*base.z)+'px;height:'+(sel.h*base.z)+'px';
  if(!box){const cv=document.getElementById('cv');if(cv)cv.parentNode.appendChild(b)}
}
/** 고른 조각에 손질 하나를 얹고 다시 그린다. */
function selApply(o){
  if(!sel)return;
  push();
  strokes.push(Object.assign({t:'blit',sx:sel.x,sy:sel.y,sw:sel.w,sh:sel.h,
    dx:sel.x,dy:sel.y,dw:sel.w,dh:sel.h,rot:0,fx:0,fy:0,cut:1},o));
  redraw();
}
/**
 * 그리던 붓질을 «편집기를 벗어나는 순간» 그 자리에서 적용한다.
 *
 * 예전에는 「이 낱장에 적용」을 눌러야만 남았다. 안 누르고 닫거나, 다른 낱장을
 * 누르거나, 그냥 저장하면 방금 그린 것이 **아무 말 없이 사라졌다** — 그런데
 * 저장 단추는 «저장했습니다» 라고 말해서 됐다고 믿게 된다(2026-08-25 원장님).
 * 캔바가 그렇듯 그린 건 그냥 남는 게 맞다. 「적용」 단추는 그대로 두되,
 * 안 눌러도 잃지 않는다. 되돌리기 역사에도 쌓으므로 Ctrl+Z 로 되돌릴 수 있다.
 */
function commitStrokes(){
  if(!openEd)return null;
  const k=openEd.key;
  if(mountedKey!==k)return null;              // 캔버스가 아직 안 붙었으면 붓질도 없다
  const now=edits[k]||[];
  if(JSON.stringify(now)===JSON.stringify(strokes))return null;
  push();
  if(strokes.length)edits[k]=strokes.slice();else delete edits[k];
  return {key:k,src:openEd.src,i:openEd.i};
}
function editor(){
  const wrap=el('div','ed'+(edFull?' full':''));
  const h=el('h2');h.innerHTML='낱장 편집 <span class="mono">'+shortSrc(openEd.src)+'·'+openEd.i+'</span>';
  const zl=el('span');zl.className='lbl';zl.style.marginLeft='auto';zl.textContent='확대';h.appendChild(zl);
  const zBtns=[];
  [[0,'맞추기'],[2,'2배'],[4,'4배'],[8,'8배'],[12,'12배'],[16,'16배']].forEach(([v,n])=>{
    const x=el('button');x.textContent=n;x.dataset.z=v;x.setAttribute('aria-pressed',String(edZoom===v));
    // 맞추기는 그림을 칸 한가운데 놓고, 배율 단추는 «보던 자리» 를 붙잡는다.
    x.onclick=()=>{v?setZoomKeep(v):fitZoom();edZoom=v;
      zBtns.forEach(t=>t.setAttribute('aria-pressed',String(+t.dataset.z===v)))};
    zBtns.push(x);h.appendChild(x)});
  const zl2=el('span');zl2.id='zlab';zl2.className='lbl';zl2.style.minWidth='34px';h.appendChild(zl2);
  const fs=el('button');fs.textContent=edFull?'창으로':'전체화면';fs.setAttribute('aria-pressed',String(edFull));
  fs.onclick=()=>{edFull=!edFull;render()};h.appendChild(fs);
  const cls=el('button','close');cls.textContent='닫기';cls.style.marginLeft='0';
  cls.onclick=()=>{const c=commitStrokes();openEd=null;mountedKey=null;
    if(c)buildEdited(c.key,c.src,c.i,()=>render());else render()};h.appendChild(cls);
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
  [['pencil','연필'],['eraser','지우개'],['picker','스포이드'],['bucket','페인트통'],['swap','색바꾸기'],['move','이동'],['sel','선택']]
    .forEach(([id,n])=>{const x=el('button');x.textContent=n;x.dataset.tool=id;
      x.setAttribute('aria-pressed',String(tool===id));
      x.onclick=()=>setTool(id);
      toolBtns.push(x);tg.appendChild(x)});
  T.appendChild(tg);

  // 고른 조각을 다루는 단추들. 고른 게 없으면 흐리게 둔다.
  const selRow=el('div','cur');selRow.id='selrow';selRow.style.flexWrap='wrap';
  const sLab=el('span');sLab.className='mono';sLab.id='sellab';sLab.textContent='고른 곳 없음';
  selRow.appendChild(sLab);
  const selBtn=(t,title,fn)=>{const x=el('button');x.textContent=t;x.title=title;
    x.onclick=()=>{if(!sel)return;fn();drawSel();updateSelLab()};selRow.appendChild(x);return x};
  selBtn('⟳','시계 방향으로 90도 돌리기',()=>{
    // 가운데를 붙잡고 돈다 — 가로세로가 뒤바뀌므로 자리도 그만큼 옮긴다
    const cx=sel.x+sel.w/2, cy=sel.y+sel.h/2;
    const nw=sel.h, nh=sel.w;
    const nx=Math.round(cx-nw/2), ny=Math.round(cy-nh/2);
    selApply({dx:nx,dy:ny,dw:nw,dh:nh,rot:90});
    sel={x:nx,y:ny,w:nw,h:nh};
  });
  selBtn('↔','좌우 뒤집기',()=>selApply({fx:1}));
  selBtn('↕','위아래 뒤집기',()=>selApply({fy:1}));
  selBtn('＋','10% 크게 (가운데 기준)',()=>{
    const nw=Math.max(1,Math.round(sel.w*1.1)), nh=Math.max(1,Math.round(sel.h*1.1));
    const nx=Math.round(sel.x+sel.w/2-nw/2), ny=Math.round(sel.y+sel.h/2-nh/2);
    selApply({dx:nx,dy:ny,dw:nw,dh:nh});
    sel={x:nx,y:ny,w:nw,h:nh};
  });
  selBtn('－','10% 작게 (가운데 기준)',()=>{
    const nw=Math.max(1,Math.round(sel.w*0.9)), nh=Math.max(1,Math.round(sel.h*0.9));
    const nx=Math.round(sel.x+sel.w/2-nw/2), ny=Math.round(sel.y+sel.h/2-nh/2);
    selApply({dx:nx,dy:ny,dw:nw,dh:nh});
    sel={x:nx,y:ny,w:nw,h:nh};
  });
  selBtn('지우기','고른 곳을 비웁니다',()=>{
    push();strokes.push({t:'r',x:sel.x,y:sel.y,w:sel.w,h:sel.h});redraw();
  });
  selBtn('해제','고르기를 풉니다',()=>{sel=null});
  T.appendChild(selRow);
  const selHint=el('div');selHint.className='cap';selHint.style.textAlign='left';
  selHint.innerHTML='<b>선택</b> 도구로 사각형을 그으세요 · 그 안을 <b>끌면 옮기고</b>, '
    +'<b>Alt+끌면 복제</b> · <b>Ctrl+C</b> 복사 <b>Ctrl+V</b> 붙이기';
  T.appendChild(selHint);

  const cur=el('div','cur');const box=el('div','box');box.style.background=color;
  const ci=el('input');ci.type='color';ci.value=color;ci.oninput=e=>{color=e.target.value;box.style.background=color};
  cur.append(box,ci);const bl=el('span');bl.className='mono';bl.textContent='굵기';cur.appendChild(bl);
  const bi=el('input');bi.id='brushrange';bi.type='range';bi.min=1;bi.max=24;bi.value=brush;bi.style.width='90px';
  bi.oninput=e=>{brush=+e.target.value;bs.textContent=brush};
  const bs=el('span');bs.id='brushnum';bs.className='mono';bs.textContent=brush;
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
    // 편집기 안에서 눌러도 같은 역사를 되돌린다. 여기만 따로 돌면
    // 툴바에서 되돌린 것과 어긋나서 어느 쪽이 진짜인지 알 수 없어진다.
    undo();
  };
  const rb=el('button');rb.textContent='처음으로';rb.onclick=()=>{push();strokes=[];redraw()};
  opts.append(ub,rb);T.appendChild(opts);

  const ap=el('button','primary');ap.id='eapply';ap.textContent='적용하고 닫기';
  ap.onclick=()=>{
    const k=openEd.key, src=openEd.src, i=openEd.i;
    push();                              // 적용도 되돌릴 수 있어야 한다
    if(strokes.length)edits[k]=strokes.slice();else delete edits[k];
    openEd=null;mountedKey=null;
    buildEdited(k,src,i,()=>render());   // 손질한 그림을 만든 뒤에 화면을 그린다
  };
  T.appendChild(ap);
  const hint=el('div');hint.className='cap';hint.style.textAlign='left';
  hint.innerHTML='손댄 자국은 좌표로 저장됩니다. 원본 gif 는 안 바뀝니다.<br>'
    +'<b>휠</b> 확대·축소(커서 지점 기준) · <b>스페이스+끌기</b> 또는 <b>가운데 버튼</b> 으로 화면 밀기<br>'
    +'<b>B</b> 연필 <b>E</b> 지우개 <b>I</b> 스포이드 <b>G</b> 페인트통 <b>V</b> 이동 · <b>[ ]</b> 붓 굵기<br>'
    +'<b>Ctrl+Z</b> 되돌리기 · 그린 것은 닫아도 저장됩니다';
  T.appendChild(hint);
  main.appendChild(T);wrap.appendChild(main);

  setTimeout(()=>{mount(cv,on,gr,pw);drawSel();updateSelLab()},0);
  return wrap;
}
/** 도구 바꾸기 — 단추와 단축키가 같은 자리를 쓴다. render() 를 부르면 캔버스가
    새로 붙어 그리던 게 끊기므로 단추 상태만 갈아끼운다. */
function setTool(id){
  tool=id;
  document.querySelectorAll('.tgrid button[data-tool]').forEach(b=>
    b.setAttribute('aria-pressed',String(b.dataset.tool===id)));
}
/** 붓 굵기 — 대괄호 글쇠와 슬라이더가 같은 자리를 쓴다. */
function setBrush(v){
  brush=Math.max(1,Math.min(24,v));
  const bi=document.getElementById('brushrange');if(bi)bi.value=brush;
  const bs=document.getElementById('brushnum');if(bs)bs.textContent=brush;
}
function autoZoom(){
  if(!base)return 4;
  // 어림값이 아니라 지금 그 칸의 실제 크기로 잰다. 가로만 보면 세로로 넘친다.
  const sc=document.querySelector('.ed .cw');
  const rw=sc&&sc.clientWidth?sc.clientWidth-18:(edFull?innerWidth-400:460);
  const rh=sc&&sc.clientHeight?sc.clientHeight-18:(edFull?innerHeight-190:460);
  return Math.max(1,Math.min(32,Math.floor(Math.min(rw/base.w,rh/base.h))));
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
/**
 * 확대·축소하면서 «보던 자리» 를 붙잡는다.
 * 안 그러면 16배로 키우는 순간 그림 왼쪽 위 귀퉁이가 잡히는데, 이펙트 그림은
 * 캐릭터가 아래쪽에 있어서 빈 체커만 보인다(실측). 그럼 다시 스크롤막대를 잡고
 * 찾아 내려가야 한다.
 */
function setZoomKeep(z){
  const sc=document.querySelector('.ed .cw');
  if(!sc||!base){setZoom(z);return}
  const before=base.z;
  const cx=(sc.scrollLeft+sc.clientWidth/2)/before, cy=(sc.scrollTop+sc.clientHeight/2)/before;
  setZoom(z);
  sc.scrollLeft=cx*base.z-sc.clientWidth/2;
  sc.scrollTop=cy*base.z-sc.clientHeight/2;
}
/** 칸에 딱 맞게 줄이고 한가운데 놓는다 (Aseprite 의 «화면에 맞추기»). */
function fitZoom(){
  setZoom(autoZoom());
  const sc=document.querySelector('.ed .cw');
  if(sc&&base){sc.scrollLeft=(base.w*base.z-sc.clientWidth)/2;sc.scrollTop=(base.h*base.z-sc.clientHeight)/2}
}
function mount(cv,on,gr,pw){
  const img=new Image();
  img.onload=()=>{
    base={img,z:1,w:img.width,h:img.height};
    const z=edZoom||autoZoom();
    [cv,on,gr].forEach(c=>{c.width=img.width;c.height=img.height});
    setZoom(z);
    // 왼쪽 위 귀퉁이는 대개 비어 있다 — 처음부터 그림 한가운데를 보여준다.
    const sc0=cv.closest('.cw');
    if(sc0){sc0.scrollLeft=(img.width*base.z-sc0.clientWidth)/2;sc0.scrollTop=(img.height*base.z-sc0.clientHeight)/2}
    // 같은 낱장을 다시 그리는 것뿐이면(전체화면 전환 등) 하던 붓질을 이어간다.
    // 여기서 무조건 저장본을 다시 읽으면 아직 '적용' 안 한 작업이 조용히 사라진다.
    // 칸에 제 손질이 없으면 재료 낱장 손질에서 «베껴» 시작한다 — 여기서부터 갈라진다.
    const k=openEd.key;
    if(mountedKey!==k){ strokes=(edits[k]||edits[K(openEd.src,openEd.i)]||[]).slice(); mountedKey=k; sel=null; }
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
  else if(s.t==='swap'||s.t==='fill'||s.t==='shift'||s.t==='blit'){pixelOp(c,s,w,h)}
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
  else if(s.t==='blit'){
    // 고른 사각형을 떠서 돌리고·크기를 바꿔 다른 자리에 놓는다.
    //   sx,sy,sw,sh  떠 올 자리        dx,dy,dw,dh  놓을 자리(크기까지)
    //   rot 0/90/180/270 (시계 방향)   fx,fy 좌우·위아래 뒤집기   cut 1이면 떠 온 자리는 비운다
    // 픽셀아트라 «가장 가까운 점» 으로만 늘린다(부드럽게 섞으면 도트가 뭉갠다).
    // 투명한 점은 안 그린다 — 붙인 조각이 바탕을 지우면 안 되기 때문이다.
    const sx=Math.round(s.sx),sy=Math.round(s.sy);
    const sw=Math.max(1,Math.round(s.sw)),sh=Math.max(1,Math.round(s.sh));
    const dw=Math.max(1,Math.round(s.dw??sw)),dh=Math.max(1,Math.round(s.dh??sh));
    const dx=Math.round(s.dx),dy=Math.round(s.dy);
    const rot=((Math.round((s.rot||0)/90)*90)%360+360)%360;
    const cut=new Uint8Array(sw*sh*4);
    for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){
      const gx=sx+x,gy=sy+y; if(gx<0||gy<0||gx>=w||gy>=h)continue;
      const a=(gy*w+gx)*4,b=(y*sw+x)*4;
      cut[b]=px[a];cut[b+1]=px[a+1];cut[b+2]=px[a+2];cut[b+3]=px[a+3];
    }
    if(s.cut){for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){
      const gx=sx+x,gy=sy+y; if(gx<0||gy<0||gx>=w||gy>=h)continue;
      px[(gy*w+gx)*4+3]=0}}
    const rw=(rot===90||rot===270)?sh:sw, rh=(rot===90||rot===270)?sw:sh;
    for(let oy=0;oy<dh;oy++)for(let ox=0;ox<dw;ox++){
      const rx=Math.min(rw-1,Math.floor(ox*rw/dw)), ry=Math.min(rh-1,Math.floor(oy*rh/dh));
      let u,v;
      if(rot===0){u=rx;v=ry}
      else if(rot===90){u=ry;v=rh-1-rx}
      else if(rot===180){u=rw-1-rx;v=rh-1-ry}
      else{u=rw-1-ry;v=rx}
      if(s.fx)u=sw-1-u;
      if(s.fy)v=sh-1-v;
      if(u<0||v<0||u>=sw||v>=sh)continue;
      const b=(v*sw+u)*4; if(cut[b+3]===0)continue;
      const gx=dx+ox,gy=dy+oy; if(gx<0||gy<0||gx>=w||gy>=h)continue;
      const a=(gy*w+gx)*4;
      px[a]=cut[b];px[a+1]=cut[b+1];px[a+2]=cut[b+2];px[a+3]=cut[b+3];
    }
  }
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
  // ── 화면 밀기 ────────────────────────────────────────────────────────────
  // 휠은 확대에 뺏겨 있고 캔버스 위에서 끌면 그림이 그려진다. 그래서 예전에는 확대한
  // 그림을 옮길 방법이 얇은 스크롤막대뿐이었다. 스페이스 누른 채 끌기(또는 가운데
  // 버튼)는 Aseprite·Canva 가 같이 쓰는 손이다.
  const scBox=cv.closest('.cw');
  let pan=null;
  const stopPan=()=>{ if(!pan)return; pan=null; cv.style.cursor=spaceDown?'grab':'crosshair'; };
  addEventListener('pointermove',e=>{ if(!pan||!scBox)return;
    scBox.scrollLeft=pan.l-(e.clientX-pan.x); scBox.scrollTop=pan.t-(e.clientY-pan.y); });
  addEventListener('pointerup',stopPan);
  addEventListener('pointercancel',stopPan);

  // 「선택」 도구 — 사각형을 긋고, 그 안을 끌면 조각이 따라온다.
  let selDrag=null;
  const inSel=p=>sel&&p.x>=sel.x&&p.y>=sel.y&&p.x<sel.x+sel.w&&p.y<sel.y+sel.h;

  cv.onpointerdown=e=>{
    if((spaceDown||e.button===1)&&scBox){          // 밀기가 그리기보다 먼저다
      e.preventDefault();cv.setPointerCapture(e.pointerId);cv.style.cursor='grabbing';
      pan={x:e.clientX,y:e.clientY,l:scBox.scrollLeft,t:scBox.scrollTop};return;
    }
    if(e.button!==0)return;                        // 오른쪽·가운데 버튼으로는 안 그린다
    cv.setPointerCapture(e.pointerId);const p=pos(e);
    if(tool==='sel'){
      if(inSel(p)){ selDrag={mode:e.altKey?'copy':'move',from:Object.assign({},sel),ox:p.x,oy:p.y,dx:0,dy:0}; }
      else { selDrag={mode:'new',ax:Math.floor(p.x),ay:Math.floor(p.y)}; sel={x:Math.floor(p.x),y:Math.floor(p.y),w:1,h:1}; drawSel(); updateSelLab(); }
      painting=true;return;
    }
    if(tool==='picker'){const c=ctxOf();const d=c.getImageData(Math.floor(p.x),Math.floor(p.y),1,1).data;
      color='#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
      setColor(color);return}   // 색만 집는 것은 그림을 안 바꾸니 역사에 안 남긴다
    // 여기서부터는 그림이 바뀐다. **긋기 전에** 지금 모습을 역사에 남긴다 —
    // 끌어 그은 한 번이 점 수십 개여도 되돌리기 한 번에 통째로 돌아가야 한다.
    push();
    if(tool==='bucket'){strokes.push({t:'fill',x:rd(p.x),y:rd(p.y),color:hex2rgb(color),tol});redraw();return}
    if(tool==='swap'){const c=ctxOf();const d=c.getImageData(Math.floor(p.x),Math.floor(p.y),1,1).data;
      strokes.push({t:'swap',from:[d[0],d[1],d[2]],to:hex2rgb(color),tol});redraw();return}
    if(tool==='move'){last=p;painting=true;return}
    painting=true;stroke(p);
  };
  // 굵기를 숫자로만 두면 그어 봐야 안다. 그을 자리에 동그라미를 띄운다.
  const bcur=document.createElement('div');bcur.className='brushcur';
  cv.parentNode.appendChild(bcur);
  const moveBrushCur=e=>{
    if(!base||(tool!=='pencil'&&tool!=='eraser')){bcur.style.display='none';return}
    if(tool==='sel'){bcur.style.display='none';return}
    const p=pos(e),d=Math.max(2,brush*base.z);
    bcur.style.display='block';bcur.style.width=d+'px';bcur.style.height=d+'px';
    bcur.style.left=(p.x*base.z)+'px';bcur.style.top=(p.y*base.z)+'px';
  };
  cv.addEventListener('pointermove',moveBrushCur);
  cv.addEventListener('pointerleave',()=>{bcur.style.display='none'});

  cv.onpointermove=e=>{if(!painting)return;const p=pos(e);
    if(tool==='sel'&&selDrag){
      if(selDrag.mode==='new'){
        const x0=Math.min(selDrag.ax,Math.floor(p.x)), y0=Math.min(selDrag.ay,Math.floor(p.y));
        const x1=Math.max(selDrag.ax,Math.floor(p.x)), y1=Math.max(selDrag.ay,Math.floor(p.y));
        sel={x:x0,y:y0,w:Math.max(1,x1-x0+1),h:Math.max(1,y1-y0+1)};
      }else{
        selDrag.dx=Math.round(p.x-selDrag.ox); selDrag.dy=Math.round(p.y-selDrag.oy);
        sel={x:selDrag.from.x+selDrag.dx,y:selDrag.from.y+selDrag.dy,w:selDrag.from.w,h:selDrag.from.h};
      }
      drawSel();updateSelLab();return;
    }
    if(tool==='move'){const dx=Math.round(p.x-last.x),dy=Math.round(p.y-last.y);
      if(dx||dy){strokes.push({t:'shift',dx,dy});last=p;redraw()}return}
    stroke(p)};
  cv.onpointerup=()=>{
    if(tool==='sel'&&selDrag){
      // 옮기거나 복제한 건 손 뗄 때 한 번만 손질로 남긴다(끄는 내내 쌓이면 되돌리기가 지저분해진다)
      if(selDrag.mode!=='new'&&(selDrag.dx||selDrag.dy)){
        const f=selDrag.from;
        push();
        strokes.push({t:'blit',sx:f.x,sy:f.y,sw:f.w,sh:f.h,
          dx:f.x+selDrag.dx,dy:f.y+selDrag.dy,dw:f.w,dh:f.h,
          rot:0,fx:0,fy:0,cut:selDrag.mode==='move'?1:0});
        redraw();
      }
      selDrag=null;painting=false;drawSel();updateSelLab();return;
    }
    painting=false;last=null};
  function stroke(p){
    const rd=v=>Math.round(v*10)/10;
    if(tool==='eraser')strokes.push({t:'c',x:rd(p.x),y:rd(p.y),r:brush/2});
    else strokes.push({t:'p',x:rd(p.x),y:rd(p.y),r:brush/2,color:hex2rgb(color)});
    redraw();
  }
}
boot();
</script></body></html>`;
