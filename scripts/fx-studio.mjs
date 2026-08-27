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
import { readFrames, encodeGif, applyEdits, fillRatio, paletteOf, listItems, sourcesFor, origPath, nextSaveSlot, savePath, compositeInto, composeSeq } from './lib/fxgif.mjs';

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

  // 층을 합치는 셈은 lib/fxgif.mjs 로 옮겼다 — 이 파일은 부르는 순간 서버가 떠서
  // 검사에서 못 쓴다. 굽는 셈은 검사가 잴 수 있는 자리에 있어야 한다.
  const { w, h, picked } = composeSeq({ dir, kind, seq }, framesOf);

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

    // 「굽기 확인」 — 파일은 하나도 안 건드리고, 저장했을 때 «나올 알갱이» 만 돌려준다.
    // 화면과 gif 가 갈리는 병은 저장한 뒤에야 드러나서, 드러날 땐 이미 아이들 화면에 가 있다.
    // 저장 전에 재 볼 수 있어야 한다.
    if (url.pathname === '/api/dryrun' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw);
          const { w, h, picked } = composeSeq(body, framesOf);
          json(res, 200, { ok: true, w, h,
            frames: picked.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength).toString('base64')) });
        } catch (e) { json(res, 400, { error: e.message }); }
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
<title>연출 편집기</title>
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
  .sp{padding:9px 12px 7px;border-bottom:1px solid color-mix(in srgb,var(--line) 45%,transparent)}
  .spn{font-size:12px;font-weight:800;letter-spacing:.02em;margin-bottom:5px}
  .spk{display:flex;flex-wrap:wrap;gap:4px}
  .spk .it{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:7px;
    border:1px solid var(--line);font-size:11px;font-weight:700;cursor:pointer;background:var(--ground)}
  .spk .it:hover{border-color:var(--accent)}
  .spk .it.on{background:color-mix(in srgb,var(--accent) 18%,transparent);border-color:var(--accent);font-weight:800}
  .spk .it .done{color:var(--accent);font-size:9px}
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
  .stage{width:calc(96px * var(--z,1));height:calc(96px * var(--z,1));flex:0 0 auto;border-radius:9px;border:1px solid var(--line);overflow:hidden;
    background-color:var(--cell);background-image:linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%),
    linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%);background-size:16px 16px;background-position:0 0,8px 8px}
  .stage img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated;display:block}
  .thumb img{image-rendering:pixelated;display:block;border:0}
  .fr > img{width:calc(66px * var(--z,1));height:calc(66px * var(--z,1));object-fit:contain;image-rendering:pixelated;display:block;border-radius:5px;
    background-image:linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%),
    linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%);background-size:12px 12px;background-position:0 0,6px 6px}
  .thumb{width:calc(66px * var(--z,1));height:calc(66px * var(--z,1));overflow:hidden;border-radius:5px;flex:0 0 auto;
    background-color:var(--cell);background-image:linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%),
    linear-gradient(45deg,var(--cell2) 25%,transparent 25%,transparent 75%,var(--cell2) 75%);background-size:12px 12px;background-position:0 0,6px 6px}
  .thumb.sm{width:44px;height:44px;background-size:10px 10px;background-position:0 0,5px 5px}
  .cap{font-size:11px;color:var(--muted);text-align:center;margin-top:3px}
  .strip{display:flex;gap:6px;overflow-x:auto;flex:1;padding-bottom:4px;min-height:60px}
  .fr,.slot{position:relative;flex:0 0 auto;padding:3px;border-radius:9px;border:2px solid var(--line);background:var(--cell);cursor:pointer}
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
  .lrow .thumb{flex:0 0 auto}
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
  body[data-bg=dark] .stage,body[data-bg=dark] .thumb,body[data-bg=dark] .fr>img,body[data-bg=dark] .cwrap{background-image:none;background-color:#0A0B0F}
  body[data-bg=light] .stage,body[data-bg=light] .thumb,body[data-bg=light] .fr>img,body[data-bg=light] .cwrap{background-image:none;background-color:#fff}
  body[data-bg=grey] .stage,body[data-bg=grey] .thumb,body[data-bg=grey] .fr>img,body[data-bg=grey] .cwrap{background-image:none;background-color:#8A8F9A}
  body[data-bg=none] .stage,body[data-bg=none] .thumb,body[data-bg=none] .fr>img,body[data-bg=none] .cwrap{background-image:none;background-color:transparent}

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

  /* ── 큰 편집기 — 아세프라이트 자리: 위 도구줄 · 왼 팔레트 · 가운데 칸 · 오른 도구 · 아래 장 ── */
  .ed{background:var(--surface);border:2px solid var(--accent);border-radius:14px;padding:0;display:flex;flex-direction:column;gap:0;overflow:hidden}
  .ed.full{position:fixed;inset:0;z-index:60;overflow:hidden;border-radius:0;border:0;box-shadow:none}
  .ed h2 button{font-size:12px;padding:3px 7px}
  .ed h2{margin:0;font-size:13px;font-weight:800;display:flex;align-items:center;gap:5px;flex:0 0 auto;flex-wrap:wrap;
    padding:4px 8px;border-bottom:1px solid var(--line);background:var(--surface)}
  .ed h2 .mono{font-weight:600;font-size:12px;color:var(--muted)}
  .ed .close{margin-left:auto}
  .edmain{display:flex;gap:0;align-items:stretch;flex:1;min-height:0}
  .palrail{width:188px;min-width:188px;overflow:hidden;padding:0;display:flex;flex-direction:column;
    background:var(--surface);border-right:1px solid var(--line);flex:0 0 auto}
  .edchars{flex:1;min-height:0;overflow-y:auto;border-bottom:1px solid var(--line)}
  .edchars .sp{padding:6px 8px 5px}
  .edcols{flex:1;min-height:0;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:5px}
  .palrail .cur{flex-wrap:wrap;gap:4px}
  .palrail input[type=range]{width:70px}
  .hsvpick{display:flex;flex-direction:column;gap:3px}
  .hsvpick canvas{width:100%;max-width:172px;height:56px;cursor:crosshair;border:1px solid #333;display:block}
  .hsvpick .huesl{width:100%}
  .fgbox{width:28px;height:28px;border:2px solid #222;flex:0 0 auto;cursor:pointer}
  .cw{flex:1;min-width:0;min-height:0;border-radius:0;padding:0;position:relative;background:#6e6274;
    overflow:auto;max-width:none;display:flex;align-items:safe center;justify-content:safe center}
  .ed.full .cw{max-height:none}
  .cwrap{position:relative;width:max-content;height:max-content;background-color:#c0c0c0;
    background-image:linear-gradient(45deg,#808080 25%,transparent 25%,transparent 75%,#808080 75%),
    linear-gradient(45deg,#808080 25%,transparent 25%,transparent 75%,#808080 75%);background-size:16px 16px;background-position:0 0,8px 8px}
  /* 캔버스에서 끌 때 옆 글자가 딸려 잡히면 Ctrl+C 가 «글자 복사» 로 새 버린다 — 아예 막는다 */
  .ed,#cv{user-select:none;-webkit-user-select:none}
  #cv{image-rendering:pixelated;cursor:crosshair;touch-action:none;border-radius:4px;display:block}
  /* 앞 장은 파랗게 물들여 보여준다 — 안 그러면 "왜 겹쳐 보이지" 가 된다 */
  /* 앞 장은 파랗게, 뒷 장은 붉게 — 물들이는 일은 이제 그리는 쪽이 한다(CSS 로는 한 색뿐) */
  #onion{position:absolute;left:0;top:0;pointer-events:none;image-rendering:pixelated;border-radius:4px}
  .onionmark{position:absolute;right:12px;top:12px;font-size:10px;font-weight:800;color:#7aa7ff;
    background:rgba(0,0,0,.55);border-radius:5px;padding:1px 6px;pointer-events:none}
  #grid{position:absolute;left:0;top:0;pointer-events:none;border-radius:4px}
  #selov{position:absolute;left:0;top:0;pointer-events:none;z-index:6}
  /* 그을 자리에 뜨는 붓 크기 윤곽. 검은 그림 위에서도 보이게 두 겹으로 두른다. */
  .brushcur{position:absolute;transform:translate(-50%,-50%);border:1px solid #fff;
    box-shadow:0 0 0 1px rgba(0,0,0,.7);border-radius:50%;pointer-events:none;display:none;z-index:5}
  /* 고른 곳의 모서리 손잡이. 눌리는 판정은 캔버스가 직접 하므로 여기선 안 받는다. */
  .selbox .h{position:absolute;width:9px;height:9px;margin:-5px 0 0 -5px;background:#fff;
    border:1px solid #111;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.45)}
  /* 아직 안 내려놓은 조각은 노란 테로 «떠 있음» 을 알린다 */
  .selbox.flt .h{background:#ffd34d}
  .fltmark{position:absolute;left:12px;top:12px;font-size:10px;font-weight:800;color:#3a2c00;
    background:#ffd34d;border-radius:5px;padding:2px 7px;pointer-events:none;z-index:7}
  .ed:not(.full){min-height:70vh}
  .ed:not(.full) .cw{max-height:none}
  /* 타임라인 — 「만든 것」 줄 아래로 층마다 한 줄. 칸 너비를 그 줄과 맞춰 세로로 읽힌다. */
  .tl{display:flex;flex-direction:column;gap:2px;margin-top:6px;width:100%;overflow-x:auto}
  .tlrow{display:flex;gap:6px;align-items:center}
  /* 줄 이름은 칸 «위» 에 얹는다 — 앞에 두면 칸이 위 줄과 어긋나 세로로 안 읽힌다 */
  .tlname{align-self:flex-start;display:flex;align-items:center;gap:6px;font-size:11px;
    font-weight:700;margin-top:4px;white-space:nowrap;padding:1px 7px;border-radius:5px;
    background:color-mix(in srgb,var(--accent) 14%,transparent)}
  .tlname button{padding:1px 6px;font-size:10px;border-radius:5px}
  .tlnm{cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px}
  /* 눌러 고치는 칸은 이름만큼 넉넉해야 한다 — 좁으면 지우고 다시 쓰게 된다 */
  .tlnmin{font-size:11px;font-weight:700;padding:1px 6px;border-radius:5px;min-width:140px;
    border:1px solid var(--accent);background:var(--cell);color:var(--ink)}
  .tlnud{display:flex;align-items:center;gap:2px}
  /* 지금 도는 장 — 줄과 타임라인에 같이 표시한다 */
  .slot.now{box-shadow:0 0 0 3px #ffd34d}
  .tlcel.now{box-shadow:0 0 0 2px #ffd34d}
  .tlcel{flex:0 0 auto;width:calc(66px * var(--z,1) + 10px);height:22px;border:1px solid var(--line);border-radius:5px;
    background:var(--cell);cursor:pointer;display:flex;align-items:center;justify-content:center;
    font-size:11px;font-weight:700;color:color-mix(in srgb,var(--ink) 55%,transparent)}
  .tlcel.on{background:color-mix(in srgb,var(--accent) 22%,var(--cell));border-color:var(--accent);
    color:var(--ink)}
  .tlcel.off{opacity:.4}
  .tlcel:hover{border-color:var(--accent)}
  .tools{display:flex;flex-direction:column;gap:3px;width:52px;min-width:52px;max-width:52px;flex:0 0 auto;
    overflow-y:auto;padding:3px 2px;background:var(--surface);border-left:1px solid var(--line)}
  .tools .cap{white-space:normal;word-break:keep-all;line-height:1.45;font-size:11px}
  .tools button{white-space:nowrap}
  .tgrid{display:grid;grid-template-columns:1fr 1fr;gap:1px}
  .tgrid button,.tools .ico,.edplay button{width:22px;height:22px;padding:0;font-size:11px;line-height:1;border-radius:0;
    display:inline-flex;align-items:center;justify-content:center}
  .tgrid button svg,.tools .ico svg{display:block;pointer-events:none}
  .tools .cur{flex-wrap:wrap;gap:1px}
  .tools .cur button.ico{width:22px;height:22px;padding:0;min-width:22px}
  .pal{display:flex;flex-wrap:wrap;gap:0;max-width:120px}
  .edtl{display:flex;align-items:stretch;gap:8px;flex:0 0 auto;padding:6px 8px;
    background:var(--surface);border-top:1px solid var(--line)}
  .edprev{width:84px;height:84px;flex:0 0 auto;border:1px solid var(--line);border-radius:6px;overflow:hidden;
    background-color:#c0c0c0;background-image:linear-gradient(45deg,#808080 25%,transparent 25%,transparent 75%,#808080 75%),
    linear-gradient(45deg,#808080 25%,transparent 25%,transparent 75%,#808080 75%);background-size:12px 12px;background-position:0 0,6px 6px}
  .edprev img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated;display:block}
  .edplay{display:flex;flex-direction:column;justify-content:center;gap:2px;flex:0 0 auto}
  .edcels{display:flex;flex-wrap:wrap;gap:4px;align-content:flex-start;flex:1;min-width:0;overflow-y:auto;max-height:120px}
  .edcel{width:56px;padding:2px;border:2px solid var(--line);border-radius:6px;background:var(--cell);cursor:pointer;flex:0 0 auto}
  .edcel img{width:52px;height:52px;object-fit:contain;image-rendering:pixelated;display:block;border-radius:3px}
  .edcel .m{font-size:9px;text-align:center;color:var(--muted);line-height:1.2}
  .edcel.on{border-color:var(--accent)}
  .edcel.now{box-shadow:0 0 0 2px #ffd34d}
  .sw{width:12px;height:12px;border-radius:0;border:1px solid #666;cursor:pointer;padding:0}
  .ed.full{background:#bdbdbd}
  .ed.full h2,.ed.full .palrail,.ed.full .tools,.ed.full .edtl{background:#c8c8c8;color:#111;border-color:#8a8a8a}
  .ed.full h2 button,.ed.full .tools button,.ed.full .edplay button,.ed.full .palrail button{
    background:#c8c8c8;border:1px solid #eee;border-right-color:#555;border-bottom-color:#555;border-radius:0;color:#111}
  .ed.full .tools button[aria-pressed=true],.ed.full h2 button[aria-pressed=true]{background:#a8c4ff;border-color:#333;color:#111}
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
<aside><h1>연출</h1><div id="list"></div></aside>
<main>
  <div class="bar" id="bar"><span class="lbl">왼쪽에서 종을 고르세요</span></div>
  <div id="work"></div>
</main>
<script>
const $=s=>document.querySelector(s), el=(t,c)=>{const e=document.createElement(t);if(c)e.className=c;return e};
const KIND_KO={attack:'공격',attacked:'맞는 쪽',hit:'맞음'};
const kindKo=k=>KIND_KO[k]||k;
function boxOfData(d,w,h,a){
  a=a||40;let x0=w,y0=h,x1=-1,y1=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    if(d[(y*w+x)*4+3]>a){if(x<x0)x0=x;if(y<y0)y0=y;if(x>x1)x1=x;if(y>y1)y1=y}
  }
  if(x1<0)return {x:0,y:0,w:w,h:h};
  return {x:x0,y:y0,w:x1-x0+1,h:y1-y0+1};
}
const thumbBox={};
function fitThumb(img){
  const go=()=>{
    const w=img.naturalWidth,h=img.naturalHeight;if(!w)return;
    const key=img.currentSrc||img.src;
    let box=thumbBox[key];
    if(!box){
      const c=document.createElement('canvas');c.width=w;c.height=h;
      const g=c.getContext('2d',{willReadFrequently:true});
      try{g.drawImage(img,0,0);box=thumbBox[key]=boxOfData(g.getImageData(0,0,w,h).data,w,h)}
      catch(e){box={x:0,y:0,w:w,h:h}}
    }
    const wrap=img.parentNode;if(!wrap)return;
    const tw=wrap.clientWidth||66,th=wrap.clientHeight||66;
    const pad=Math.max(2,Math.round(Math.max(box.w,box.h)*0.12));
    const x=Math.max(0,box.x-pad),y=Math.max(0,box.y-pad);
    const bw=Math.min(w-x,box.w+pad*2),bh=Math.min(h-y,box.h+pad*2);
    const s=Math.min(tw/bw,th/bh);
    img.style.width=(w*s)+'px';img.style.height=(h*s)+'px';
    img.style.maxWidth='none';img.style.objectFit='none';
    img.style.marginLeft=((tw-bw*s)/2-x*s)+'px';
    img.style.marginTop=((th-bh*s)/2-y*s)+'px';
  };
  img.onload=go;
  if(img.complete&&img.naturalWidth)go();
}
function pix(src,sm){
  const box=el('div','thumb'+(sm?' sm':''));const img=el('img');img.src=src;box.appendChild(img);fitThumb(img);return box;
}
// 슬롯은 게임에서 받아온다(숫자를 여기 박아 두면 배치를 바꿀 때마다 어긋난다).
let CANVAS=[820,700];
let SLOT={boss:{x:516,y:19,s:117},player:{x:355,y:208,s:97},atk:{x:353,y:99,s:200},atkd:{x:357,y:36,s:276},
           hitBoss:{x:516,y:52,s:94},hitPlayer:{x:353,y:214,s:98}};
let calibSource='불러오는 중';
async function loadCalib(force){
  try{
    const c=await (await fetch('/api/calib'+(force?'?force=1':''))).json();
    const it=c.items||[];
    if(it.length>=5){
      SLOT={boss:{x:it[0].x,y:it[0].y,s:it[0].size},player:{x:it[1].x,y:it[1].y,s:it[1].size},
            atk:{x:it[3].x,y:it[3].y,s:it[3].size},atkd:{x:it[4].x,y:it[4].y,s:it[4].size},
            hitBoss:it[5]?{x:it[5].x,y:it[5].y,s:it[5].size}:{x:516,y:52,s:94},
            hitPlayer:it[6]?{x:it[6].x,y:it[6].y,s:it[6].size}:{x:353,y:214,s:98}};
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
let hitOnBoss=true,showEdHelp=false;
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
// 「그린 층」 — 바닥이 없는 층이다. 아무것도 없는 그림 한 점을 바닥으로 두고
// 그 위에 손질만 얹는다. 굽는 쪽도 src:'blank' 를 투명한 낱장으로 받는다.
const BLANK_PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const isBlank=L=>!!(L&&L.src==='blank');
// 그린 층의 손질이 담기는 자리. 층마다 제 이름표를 갖는다 — 안 그러면 층끼리 섞인다.
const layKey=L=>'lay:'+L.lid;
const layURL=L=>isBlank(L)
  ? (editedCache[layKey(L)]||BLANK_PNG)
  : isForeign(L)
  ? '/frame.png?dir='+encodeURIComponent(L.dir)+'&kind='+L.kind+'&src='+L.src+'&i='+L.i
  : furl(L.src,L.i);
const layName=L=>(L&&L.name)?L.name
  :isBlank(L)
  ? ('그린 층'+(L.lid?(' '+String(L.lid).slice(-2)):''))
  : ((isForeign(L)?(L.dir.replace(/^\\d+-/,'')+'·'):'')+shortSrc(L.src)+'·'+L.i);

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
    L.op===undefined?1:L.op,L.off?1:0,
    isBlank(L)?('lay'+L.lid+':'+editSigKey(layKey(L))):isForeign(L)?'':editSig(L.src,L.i)])]);
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
  // 바닥은 «이 칸의» 손질까지 얹힌 그림이어야 한다. 재료 낱장 그림(furl)만 쓰면
  // 이 칸에만 한 손질이 층 밑에서 사라져, 화면과 굽는 것이 갈린다.
  loadImgs([slotImg(s),...s.over.map(layURL)],imgs=>{
    const base=imgs[0];
    if(!base){done();return}
    const c=document.createElement('canvas');c.width=base.width;c.height=base.height;
    const x=c.getContext('2d');x.drawImage(base,0,0);
    s.over.forEach((L,k)=>{
      const g=imgs[k+1];if(!g||L.off)return;   // 눈을 끈 층은 화면에서도 빠져야 굽는 것과 같다
      x.globalCompositeOperation=CANVAS_OP[L.blend||'normal']||'source-over';
      x.globalAlpha=L.op===undefined?1:L.op;
      x.drawImage(g,L.dx|0,L.dy|0);
    });
    x.globalCompositeOperation='source-over';x.globalAlpha=1;
    compCache[key]=c.toDataURL('image/png');done();
  });
}
/** 아직 안 만든 합성본이 있으면 만들고 나서 부른다. 없으면 바로 부른다. */
/**
 * 그린 층의 미리보기 그림을 챙긴다.
 *
 * 편집기를 거쳐 나온 층은 「적용」할 때 구워지지만, 칸을 «베끼거나 떼어 낼 때»,
 * 또는 되돌리기로 손질이 되살아날 때는 편집기를 안 거친다. 그러면 손질은 있는데
 * 미리보기 그림이 없어서 화면에는 빈 층으로 보이고, 굽는 쪽은 제대로 굽는다 —
 * 화면과 gif 가 갈린다(실측: 층을 베낀 뒤 「굽기 확인」이 3장 갈림으로 잡았다).
 */
function ensureLayers(done){
  const need=[];
  seq.forEach(s=>(s.over||[]).forEach(L=>{
    if(!isBlank(L))return;
    const k=layKey(L);
    if((edits[k]||[]).length&&!editedCache[k])need.push(L);
  }));
  if(!need.length){done();return}
  let left=need.length;
  need.forEach(L=>buildEdited(layKey(L),null,0,()=>{if(!--left)done()},{w:cur.w,h:cur.h}));
}
/**
 * 칸 미리보기 그림을 챙긴다.
 *
 * 「모든 장에 한 번에」 는 편집기를 안 거치고 다른 칸의 손질 줄에 바로 얹는다. 그러면
 * 손질은 있는데 그 칸의 미리보기가 없어서 화면에는 «안 바뀐 것» 처럼 보인다 — 그런데
 * 저장하면 전부 바뀐다(실측: 「굽기 확인」이 갈림 6장으로 잡았다).
 * 화면이 낡은 쪽이므로 여기서 다시 굽는다.
 */
function ensureEdited(done){
  const need=seq.filter(s=>{const k=slotKey(s);return (edits[k]||[]).length&&!editedCache[k]});
  if(!need.length){done();return}
  let left=need.length;
  need.forEach(s=>buildEdited(slotKey(s),s.src,s.i,()=>{if(!--left)done()}));
}
function ensureComposites(done){
  ensureEdited(()=>ensureLayers(()=>{
    const need=seq.filter(s=>s.over&&s.over.length&&!compCache[slotSig(s)]);
    if(!need.length){done();return}
    let left=need.length;
    need.forEach(s=>buildComposite(s,()=>{if(!--left)done()}));
  }));
}
function buildEdited(k,src,i,done,blankWH){
  const st=edits[k];
  if(!st||!st.length){delete editedCache[k];done&&done();return}
  // 그린 층은 바닥이 없다 — 빈 칸에서 시작해 손질만 얹는다. 크기는 그 칸에서 받아 온다.
  if(blankWH){
    const c=document.createElement('canvas');c.width=blankWH.w;c.height=blankWH.h;
    const x=c.getContext('2d',{willReadFrequently:true});
    for(const t of st)applyOne(x,t,blankWH.w,blankWH.h);
    editedCache[k]=c.toDataURL('image/png');done&&done();return;
  }
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

function fillCharList(box,fromEd){
  box.innerHTML='';
  let last='';
  items.forEach(it=>{
    if(it.dir!==last){
      last=it.dir;
      const g=el('div','sp');
      const nm=el('div','spn');nm.textContent=it.dir.replace(/^\\d+-/,'');g.appendChild(nm);
      const ks=el('div','spk');ks.dataset.dir=it.dir;g.appendChild(ks);
      box.appendChild(g);
    }
    const ks=box.querySelector('.spk[data-dir="'+it.dir+'"]');
    const d=el('button','it');d.dataset.id=it.id;d.type='button';
    d.textContent=it.kind;
    if(it.done){const dot=el('span','done');dot.textContent='●';d.appendChild(dot)}
    if(cur&&cur.id===it.id)d.classList.add('on');
    d.onclick=()=>{
      if(cur&&cur.id===it.id)return;
      if(!fromEd){load(it);return}
      const c=commitStrokes();
      const go=()=>load(it);
      if(c)buildEdited(c.key,c.src,c.i,go,c.blank?{w:c.w,h:c.h}:null);else go();
    };
    ks.appendChild(d);
  });
}
async function boot(){
  await loadCalib();
  items=await (await fetch('/api/items')).json();
  fillCharList($('#list'),false);

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
      const node=[...L.querySelectorAll('.it')].find(n=>n.dataset.id===want);
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
    r.steps.forEach((s,n)=>{
      if(s.erase&&s.erase.length)edits['slot:'+seq[n].uid]=s.erase;
      // 그린 층의 손질도 제자리에 도로 붙인다. 안 붙이면 층은 살아나는데 «빈 채로»
      // 살아나고, 그 상태로 한 번만 더 저장하면 그린 것이 조용히 사라진다.
      (s.over||[]).forEach((L,k)=>{
        const T=seq[n].over[k];
        if(T&&isBlank(T)&&L.erase&&L.erase.length)edits[layKey(T)]=L.erase;
      });
    });
  }
  else seq=meta.old.fills.map((_,i)=>({src:'old',i,uid:newUid()}));
  undoStack=[];redoStack=[];                     // 다른 종의 순서로 되돌아가면 안 된다
  Object.keys(editedCache).forEach(k=>delete editedCache[k]);
  rebuildEdited(()=>render());
}
let reFixing=false;   // 미리보기를 다시 굽는 중 — 여기서 맴돌지 않게
function render(){
  stampUids();
  // 층을 얹은 칸은 합성본이 있어야 그릴 수 있다. 없으면 만들고 다시 들어온다 —
  // 만들어 두면 두 번째에는 이 자리를 그냥 지나간다.
  // 미리보기가 낡았으면 먼저 다시 굽고 들어온다. 한 번만 되돌아온다 —
  // 못 구운 게 있어도 화면은 그려야 하지, 여기서 맴돌면 안 된다.
  const staleEd=seq.some(s=>{const k=slotKey(s);return (edits[k]||[]).length&&!editedCache[k]});
  const staleComp=seq.some(s=>s.over&&s.over.length&&!compCache[slotSig(s)]);
  if((staleEd||staleComp)&&!reFixing){
    reFixing=true;
    ensureComposites(()=>{reFixing=false;render()});return;
  }
  const b=$('#bar');b.innerHTML='';
  const t=el('span','lbl');t.textContent=cur.dir+' · '+kindKo(cur.kind)+' · '+cur.canvas;b.appendChild(t);
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
  // 저장 «전에» 화면과 굽는 것이 같은지 재 본다. 파일은 안 건드린다.
  const dry=el('button');dry.id='drybtn';dry.textContent='굽기 확인';dry.disabled=!seq.length;
  dry.title='저장했을 때 나올 그림을 지금 화면과 한 점씩 맞대 봅니다 (파일은 안 건드립니다)';
  dry.onclick=dryrun;b.appendChild(dry);
  const dlab=el('span','cap');dlab.id='drylab';b.appendChild(dlab);
  // 재생하며 보기 — 멈춰 세우고 한 장씩 넘기면 «어느 장에서 튀는지» 를 짚을 수 있다.
  b.appendChild(gap());
  const pb=el('button');pb.id='playbtn';pb.textContent=playing?'⏸ 멈춤':'▶ 재생';
  pb.title='재생을 멈추거나 다시 돌립니다. 멈춘 채로 층을 켜고 끄며 볼 수 있습니다.';
  pb.onclick=()=>{playing=!playing;pb.textContent=playing?'⏸ 멈춤':'▶ 재생';
    if(playing)play();else clearTimeout(playT)};
  b.appendChild(pb);
  const pv=el('button');pv.id='playprev';pv.textContent='◀';pv.title='앞 장으로 (멈춥니다)';
  pv.onclick=()=>playStep(-1);b.appendChild(pv);
  const nx=el('button');nx.id='playnext';nx.textContent='▶';nx.title='다음 장으로 (멈춥니다)';
  nx.onclick=()=>playStep(1);b.appendChild(nx);
  const plab=el('span','cap');plab.id='playlab';b.appendChild(plab);
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
  const isOld=s=>/^(b|s)\\d+$/.test(s.id)||s.id==='new'||/^v\\d+$/.test(s.id);
  const shown=cur.sources.filter(s=>showOldSources||!isOld(s));
  const hidden=cur.sources.length-shown.length;
  W.appendChild(seqRow());
  if(selSlot!==null&&seq[selSlot]) W.appendChild(layersPanel(selSlot));
  const D=delays();const loop=D.reduce((a,b)=>a+b,0);
  const info=el('div','msg');
  info.innerHTML=seq.length
    ? seq.length+'장 · '+(leadShort&&seq.length>1?'첫 장 <b>'+D[0]+'ms</b> + 나머지 <b>'+D[1]+'ms</b>':'장당 <b>'+D[0]+'ms</b>')
      +' · 한 바퀴 <b>'+loop+'ms</b> → 창 '+(fit/1000)+'초 안에서 <b>'+(fit/loop).toFixed(2)+'바퀴</b>'
    :'낱장을 눌러 크게 보고, ＋로 담으세요.';
  W.appendChild(info);
  shown.forEach(s=>W.appendChild(strip(s)));
  if(hidden>0||showOldSources){
    const t=el('button');t.style.margin='2px 0 8px';
    t.textContent=showOldSources?'옛 판 접기':('옛 판 '+hidden+'줄 펼치기');
    t.title='굽기·저장본·다시 구운 기록입니다. 지금 쓰는 것과 원본은 항상 보입니다.';
    t.onclick=()=>{showOldSources=!showOldSources;render()};
    W.appendChild(t);
  }
  extras.forEach(x=>W.appendChild(extraStrip(x)));
  W.appendChild(foreignPicker());
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
  flt=null;fltBase=null;             // 되돌리면 떠 있던 조각은 없던 것이 된다
  adj=null;
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
      if(c)buildEdited(c.key,c.src,c.i,go,c.blank?{w:c.w,h:c.h}:null);else go()};
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
/**
 * 칸을 하나 더 만든다. 손질까지 «베껴» 새 번호에 붙인다 —
 * 복제인데 손질이 안 따라오면 화면에서 본 것과 다른 게 생긴다(2026-08-25 실측).
 * 베낀 뒤에는 서로 남남이라 한쪽만 고쳐도 다른 쪽은 그대로다.
 */
function dupSlot(s){
  const c=copySlot(s);
  c.uid=newUid();
  const e=slotEdits(s);
  if(e.length)edits['slot:'+c.uid]=e.map(x=>JSON.parse(JSON.stringify(x)));
  return c;
}
function openSeq(n){
  const s=seq[n];if(!s)return;
  playAt=n;
  const c=commitStrokes();openEd={src:s.src,i:s.i,key:slotOwn(s)};mountedKey=null;
  const go=()=>render();
  if(c)buildEdited(c.key,c.src,c.i,go,c.blank?{w:c.w,h:c.h}:null);else go();
}
function seqRow(){
  const row=el('div','row seq');
  const box=el('div');const st=el('div','stage');const im=el('img');im.id='seqimg';st.appendChild(im);box.appendChild(st);
  const c=el('div','cap');c.textContent='만든 것 '+seq.length+'장';box.appendChild(c);row.appendChild(box);
  fitThumb(im);
  const sp=el('div','strip');sp.id='seqstrip';
  seq.forEach((s,n)=>{
    const b=el('div','slot'+(s.src==='old'?' old':'')+(slotEdits(s).length?' edited':'')
      +(openEd&&openEd.key===slotOwn(s)?' sel':''));
    b.draggable=true;b.dataset.n=n;b.title='눌러서 이 낱장 편집 · 낱장을 여기로 끌어다 놓으면 위에 얹습니다';
    b.appendChild(pix(slotURL(s)));
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
    b.onclick=()=>openSeq(n);
    const ops=el('div','ops');
    [['✎','edit'],['層','lay'],['⧉','dup'],['◀',-1],['▶',1],['×',0]].forEach(([t,d])=>{
      const x=el('button',d===0?'x':'');x.textContent=t;
      if(d==='lay')x.title='이 칸의 층 다루기';
      if(d==='dup')x.title='이 칸을 바로 뒤에 하나 더 (Ctrl+C · Ctrl+V 로도 됩니다)';
      x.onclick=e=>{e.stopPropagation();
        if(d==='edit'){b.onclick();return}
        if(d==='lay'){selSlot=(selSlot===n?null:n);render();return}
        if(d==='dup'){push();seq.splice(n+1,0,dupSlot(seq[n]));selSlot=null;render();return}
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
  // 줄과 타임라인은 «세로로» 이어야 칸이 위아래로 맞는다
  const col=el('div');col.style.cssText='flex:1;min-width:0;display:flex;flex-direction:column';
  col.appendChild(sp);
  const tl=timeline();
  if(tl){
    col.appendChild(tl);
    // 줄이 길어 옆으로 밀릴 때 위아래가 따로 놀면 세로로 못 읽는다 — 함께 민다.
    let lock=false;
    const tie=(a,b)=>a.addEventListener('scroll',()=>{
      if(lock)return;lock=true;b.scrollLeft=a.scrollLeft;lock=false});
    tie(sp,tl);tie(tl,sp);
    // 칸 너비는 «재서» 맞춘다. 칸 아래 단추 줄이 폭을 늘려서 그림 크기로 셈하면 어긋난다.
    requestAnimationFrame(()=>{
      const slots=[...sp.children].filter(c=>c.classList.contains('slot'));
      tl.querySelectorAll('.tlrow').forEach(r=>{
        [...r.children].forEach((c,i)=>{if(slots[i])c.style.width=slots[i].offsetWidth+'px'});
      });
    });
  }
  row.appendChild(col);
  return row;
}

// ── 타임라인 ────────────────────────────────────────────────────────────────
// 「만든 것」 가로 줄은 그대로 두고, 층이 생기면 그 «아래로» 한 줄씩 펼친다.
// 층이 없으면 예전 화면과 똑같다 — 손에 익은 것이 안 바뀐다.
//
//   만든 것   [0][1][2][3][4][5][6]
//   그린 층A  [■][■][ ][■][ ][ ][ ]      ■ 있는 칸 · 빈 것은 눌러서 만든다
//
// 줄(track)은 «같은 층이 여러 장에 걸쳐 있는 것» 이고, 칸(cel)은 그 장의 그림이다.
// 그린 층은 칸마다 제 그림(lid)을 갖고, 재료 낱장을 얹은 층은 그 낱장 자체로 묶인다.
const trackOf=L=>L.track||(isBlank(L)?('b:'+L.lid)
  :('m:'+(L.dir||'')+'|'+(L.kind||'')+'|'+L.src+'|'+L.i));
/** 지금 줄 목록. 아래 칸부터 훑어 처음 나온 순서대로 세운다. */
function tracks(){
  const seen=new Map();
  seq.forEach((s,n)=>{(s.over||[]).forEach(L=>{
    const t=trackOf(L);
    if(!seen.has(t))seen.set(t,{t,name:layName(L),blank:isBlank(L),custom:!!L.name});
  })});
  return [...seen.values()];
}
/** 줄 이름 붙이기 — 그 줄의 칸마다 같은 이름을 적어 둔다(어느 칸을 봐도 이름이 나오게). */
function setTrackName(t,name){
  push();
  seq.forEach(s=>{const L=celAt(s,t);
    if(!L)return;
    if(name)L.name=name;else delete L.name;
  });
}
const celAt=(s,t)=>(s.over||[]).find(L=>trackOf(L)===t)||null;
// 복사해 둔 칸(줄과 그림 번호). 「함께 쓰기」와 「사본」이 이걸 쓴다.
let celClip=null;
/** 그 그림을 몇 장이 함께 쓰는지. 둘 이상이면 «이어 쓴 칸» 이다. */
const linkCount=lid=>seq.reduce((n,s)=>n+((s.over||[]).some(L=>L.lid===lid)?1:0),0);
function timeline(){
  const ts=tracks();
  if(!ts.length)return null;                 // 층이 없으면 예전 그대로다
  const box=el('div','tl');
  ts.slice().reverse().forEach(tr=>{         // 위에 그려지는 층이 위에 오게
    // 줄 이름을 칸 «앞» 에 두면 칸이 위 줄과 어긋나 세로로 안 읽힌다. 위에 얹는다.
    const head=el('div','tlname');
    const anyOn=seq.some(s=>{const L=celAt(s,tr.t);return L&&!L.off});
    if(!anyOn)head.style.opacity='.45';

    const eye=el('button');eye.textContent=anyOn?'보임':'꺼짐';
    eye.title='이 줄 전체를 켜고 끕니다';
    eye.setAttribute('aria-pressed',String(anyOn));
    eye.onclick=()=>{push();seq.forEach(s=>{const L=celAt(s,tr.t);
      if(L){if(anyOn)L.off=1;else delete L.off}});render()};
    head.appendChild(eye);

    // 이름 — 층이 서넛 넘어가면 «그린 층 15» 로는 뭐가 뭔지 모른다. 눌러서 고친다.
    const nm=el('span','tlnm');nm.textContent=tr.name;
    nm.title='눌러서 이름을 고칩니다';
    nm.onclick=()=>{
      const inp=el('input');inp.className='tlnmin';inp.value=(tr.blank&&tr.custom)?tr.name:'';
      inp.placeholder=tr.name;
      const done=save=>{
        if(inp.dataset.done)return;inp.dataset.done='1';
        if(save)setTrackName(tr.t,inp.value.trim());
        render();
      };
      inp.onkeydown=e=>{
        if(e.key==='Enter'){e.preventDefault();done(true)}
        if(e.key==='Escape'){e.preventDefault();done(false)}
      };
      inp.onblur=()=>done(true);
      nm.replaceWith(inp);inp.focus();
    };
    head.appendChild(nm);

    // 줄 통째로 밀기 — 층 하나를 몇 점 옮기고 싶을 때 칸을 일일이 열지 않게.
    const at=celAt(seq.find(s=>celAt(s,tr.t))||seq[0],tr.t);
    const nud=el('span','tlnud');
    [['←',-1,0],['→',1,0],['↑',0,-1],['↓',0,1]].forEach(([t,ax,ay])=>{
      const x=el('button');x.textContent=t;x.title='이 줄 전체를 밀기 (Shift 누르면 8점)';
      x.onclick=e=>{const m=e.shiftKey?8:1;push();
        seq.forEach(s=>{const L=celAt(s,tr.t);if(L){L.dx=(L.dx|0)+ax*m;L.dy=(L.dy|0)+ay*m}});
        render()};
      nud.appendChild(x);
    });
    const pos=el('span','cap');pos.textContent=(at?(at.dx|0):0)+','+(at?(at.dy|0):0);
    nud.appendChild(pos);
    head.appendChild(nud);

    box.appendChild(head);
    const r=el('div','tlrow');
    seq.forEach((s,n)=>{
      const L=celAt(s,tr.t);
      const c=el('div','tlcel'+(L?' on':'')+(L&&L.off?' off':''));
      c.title=L?(tr.blank?'눌러서 이 칸의 층을 고칩니다':'이 칸에 얹혀 있습니다')
              :(tr.blank?'눌러서 이 장에도 이 층을 만듭니다':'이 장에는 없습니다');
      const linked=L&&tr.blank&&linkCount(L.lid)>1;
      if(L&&tr.blank){
        const n2=(edits[layKey(L)]||[]).length;
        c.textContent=(linked?'≡':'')+(n2?String(n2):'·');
        if(linked)c.title='이 그림을 '+linkCount(L.lid)+'장이 함께 씁니다 — 고치면 다 바뀝니다';
      }else if(L)c.textContent='■';
      c.onclick=e=>{
        if(L){
          if(e.altKey){celClip={track:tr.t,lid:L.lid};toast('이 칸을 복사했습니다 — 빈 칸에 Alt+누르면 사본, Shift+누르면 함께 쓰기');return}
          if(tr.blank){const k=(s.over||[]).indexOf(L);openLayer(n,k)}
          else{selSlot=n;render()}
          return;
        }
        if(!tr.blank){selSlot=n;render();return}
        push();
        s.over=s.over||[];
        // Shift = 이어 쓰기(같은 그림을 함께 씀) · Alt = 사본(따로 논다) · 그냥 = 새로 그리기
        let lid=newUid();
        if(celClip&&celClip.track===tr.t){
          if(e.shiftKey)lid=celClip.lid;                       // 함께 쓴다
          else if(e.altKey){                                   // 사본 — 고쳐도 남이 안 바뀐다
            edits['lay:'+lid]=(edits['lay:'+celClip.lid]||[]).map(cloneStroke);
          }
        }
        s.over.push({src:'blank',i:0,lid,track:tr.t,dx:0,dy:0,blend:'normal',op:1});
        render();
        if(!(celClip&&celClip.track===tr.t&&(e.shiftKey||e.altKey)))openLayer(n,s.over.length-1);
      };
      r.appendChild(c);
    });
    box.appendChild(r);
  });
  return box;
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
     o.textContent=it.dir.replace(/^\\d+-/,'')+' · '+kindKo(it.kind);
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
        kindKo(it.kind)+' · '+s.label,fills:m.fills});
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
    if(L.off)r.style.opacity='.45';
    r.appendChild(pix(layURL(L),true));
    const nm=el('div','lname');nm.textContent=layName(L);
    if(isBlank(L)){
      // 그린 층은 «고치는» 것이 본업이다 — 이름을 누르면 바로 그 층을 연다.
      nm.style.cursor='pointer';nm.title='이 층을 열어 고칩니다';
      nm.onclick=()=>openLayer(n,k);
      const n2=(edits[layKey(L)]||[]).length;
      const cnt=el('span','cap');cnt.textContent=n2?(' 손질 '+n2):' 비어 있음';nm.appendChild(cnt);
    }
    r.appendChild(nm);
    const eye=el('button');eye.textContent=L.off?'꺼짐':'보임';
    eye.title='끄면 굽기에서 뺍니다 — 지우지 않고 잠깐 빼 볼 때 씁니다';
    eye.setAttribute('aria-pressed',String(!L.off));
    eye.onclick=()=>{push();if(L.off)delete L.off;else L.off=1;render()};
    r.appendChild(eye);

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

  // 「그린 층」 — 바닥이 없는 빈 층 하나를 얹고 거기에 직접 그린다.
  // 본체를 안 건드리고 불티·빛 같은 걸 따로 올렸다 내렸다 할 수 있는 자리다.
  const addRow=el('div','cur');
  const addBlank=el('button');addBlank.id='addblank';addBlank.textContent='＋ 그린 층';
  addBlank.title='아무것도 없는 층을 하나 얹습니다. 이름을 누르면 그 층만 따로 그릴 수 있습니다.';
  addBlank.onclick=()=>{
    push();
    s.over=s.over||[];
    s.over.push({src:'blank',i:0,lid:newUid(),dx:0,dy:0,blend:'normal',op:1});
    render();
    // 얹자마자 열어 준다 — 얹기만 하고 «그다음 뭘 눌러야 하지» 로 끝나면 안 된다.
    openLayer(n,s.over.length-1);
  };
  addRow.appendChild(addBlank);
  box.appendChild(addRow);

  const tip=el('div','cap');
  tip.textContent='재료 줄의 낱장을 이 칸 위로 끌어다 놓으면 층으로 얹힙니다. 다른 종 재료는 위 「다른 종 불러오기」 로 가져오세요.';
  box.appendChild(tip);
  return box;
}
/**
 * 그 칸의 그 층을 편집기로 연다.
 *
 * 바닥 낱장을 열 때와 달리 «바닥 그림이 없다». 크기만 그 칸에서 빌리고 빈 칸에서 시작한다.
 * 손질은 층마다 제 이름표(lay:<lid>)에 담기므로 층끼리 안 섞인다.
 */
/**
 * 이어 쓰던 칸을 «이 장만» 제 그림으로 떼어 낸다.
 * 지금 것을 그대로 베껴서 떼므로 보이는 그림은 안 바뀐다 — 이제부터 남남일 뿐이다.
 */
function unlinkCel(){
  if(!openEd||!openEd.blank)return;
  const s=seq[openEd.slot];if(!s)return;
  const L=(s.over||[]).find(x=>x.lid===openEd.lid);if(!L)return;
  commitStrokes();                                   // 고치던 것부터 제자리에 담고
  push();
  const nid=newUid();
  edits['lay:'+nid]=(edits[layKey(L)]||[]).map(cloneStroke);
  L.lid=nid;
  openEd.key='lay:'+nid;openEd.lid=nid;mountedKey=null;
  render();
  toast('이 장만 따로 떼었습니다 — 이제 고쳐도 다른 장은 안 바뀝니다','ok');
}
function openLayer(n,k){
  const s=seq[n],L=s.over&&s.over[k];
  if(!L||!isBlank(L))return;
  const c=commitStrokes();
  openEd={src:s.src,i:s.i,key:layKey(L),blank:1,lid:L.lid,slot:n};
  mountedKey=null;
  if(c)buildEdited(c.key,c.src,c.i,()=>render(),c.blank?{w:c.w,h:c.h}:null);
  else render();
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
  const isHit=cur.kind==='hit';
  const isAtk=cur.kind==='attack';
  const fxSlot=isHit?(hitOnBoss?SLOT.hitBoss:SLOT.hitPlayer):(isAtk?SLOT.atk:SLOT.atkd);
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
  if(isHit){
    const b=el('img');b.src='/sprite.gif?dir='+encodeURIComponent(cur.dir);put(b,SLOT.boss);
    const p=el('img');p.src='/sprite.gif?dir='+encodeURIComponent(cur.dir)+'&back=1';put(p,SLOT.player);
  }else if(isAtk){const b=el('img');b.src='/sprite.gif?dir='+encodeURIComponent(cur.dir);put(b,SLOT.boss)}
  else{const p=el('img');p.src='/sprite.gif?dir='+encodeURIComponent(cur.dir)+'&back=1';put(p,SLOT.player)}
  const fx=el('img');fx.id='gamefx';fx.style.mixBlendMode=blend==='screen'?'screen':'normal';
  fx.style.zIndex='5';put(fx,fxSlot);
  if(showSlots){const sl=fxSlot;const box=el('div','slotbox');
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
  ck.append(bb,sb);
  if(isHit){
    [['보스에',true],['학생에',false]].forEach(([n,v])=>{
      const x=el('button');x.textContent=n;x.setAttribute('aria-pressed',String(hitOnBoss===v));
      x.onclick=()=>{hitOnBoss=v;render()};ck.appendChild(x)});
  }
  o.appendChild(ck);
  const cs=el('div','cur');
  const src=el('span');src.className='gnote';src.style.flex='1';src.textContent='배치: '+calibSource;
  const rf=el('button');rf.textContent='배치 새로고침';rf.title='게임에서 CALIBRATE 로 바꾼 배치를 다시 읽어옵니다';
  rf.onclick=async()=>{await loadCalib(true);render()};
  cs.append(src,rf);o.appendChild(cs);
  const n=el('div','gnote');
  n.innerHTML=(isHit
    ?('Hit FX 는 '+(hitOnBoss?'<b>보스</b>('+SLOT.hitBoss.s+'px)':'<b>학생</b>('+SLOT.hitPlayer.s+'px)')+' 자리에 맞습니다. 정답이면 보스, 오답이면 학생입니다.')
    :isAtk?'FX 는 <b>학생 자리</b>('+SLOT.atk.s+'px)에 뜨고 학생 스프라이트는 감춰집니다. 보스가 표적입니다.'
    :'FX 는 <b>보스 자리</b>('+SLOT.atkd.s+'px)에 뜨고 보스 스프라이트는 감춰집니다. 학생이 표적입니다.')
    +'<br><br>원본 '+cur.canvas+' 을 그 크기로 늘려 그립니다.'
    +(blend==='screen'?'<br><br><b>screen 합성에서는 어두운 픽셀이 거의 안 보입니다.</b> 체커 위에서 거슬리던 검은 잔재가 여기서는 이미 안 보일 수 있습니다.':'');
  o.appendChild(n);
  wrap.appendChild(o);
  return wrap;
}

/**
 * 재생하며 보기.
 *
 * 예전에는 그냥 돌기만 해서 «지금 몇 번째 장인지» 를 알 수 없었다. 층을 켜고 끄며
 * 볼 때는 그게 꼭 있어야 한다 — 어느 장에서 튀는지가 보여야 그 장을 고칠 수 있다.
 * 그래서 도는 동안 그 장을 줄과 타임라인에 표시하고, 멈춰 세워 한 장씩 넘길 수도 있게 했다.
 * 다시 그리지 않고 «표시만» 갈아끼운다 — 다시 그리면 재생이 처음으로 튄다.
 */
let playAt=0,playing=true;
  function markPlayhead(k){
  const sp=document.getElementById('seqstrip');
  if(sp)[...sp.children].filter(c=>c.classList.contains('slot'))
    .forEach((c,i)=>c.classList.toggle('now',i===k));
  document.querySelectorAll('.tlrow').forEach(r=>{
    [...r.children].forEach((c,i)=>c.classList.toggle('now',i===k));
  });
  document.querySelectorAll('.edcel').forEach((c,i)=>c.classList.toggle('now',i===k));
  const lab=document.getElementById('playlab');
  if(lab)lab.textContent=(k+1)+' / '+seq.length+'장';
  const pb=document.getElementById('edplaybtn');
  if(pb)pb.textContent=playing?'⏸':'▶';
}
/** 멈춘 채로 한 장씩 넘기기. */
function playStep(d){
  if(!seq.length)return;
  playing=false;clearTimeout(playT);
  playAt=(playAt+d+seq.length)%seq.length;
  showFrame(playAt);
  const b=document.getElementById('playbtn');if(b)b.textContent='▶ 재생';
}
function showFrame(k){
  const im=$('#seqimg'),gm=$('#gamefx'),ep=$('#edprev');
  const u=slotURL(seq[k]);
  if(im){im.src=u;fitThumb(im)}if(gm)gm.src=u;if(ep)ep.src=u;
  markPlayhead(k);
}
function play(){
  clearTimeout(playT);
  const im=$('#seqimg'),ep=$('#edprev');if((!im&&!ep)||!seq.length)return;
  if(playAt>=seq.length)playAt=0;
  if(!playing){showFrame(playAt);return}
  const D=delays();let k=playAt;
  const step=()=>{
    playAt=k;showFrame(k);
    const d=D[k];k=(k+1)%seq.length;playT=setTimeout(step,d)};
  step();
}
/** 지금 화면을 «조리법» 으로 적는다. 저장과 굽기 확인이 같은 것을 보내야 뜻이 있다. */
function recipeSteps(){
  return seq.map(s=>({src:s.src,i:s.i,erase:slotEdits(s),
    over:(s.over||[]).map(L=>({dir:L.dir,kind:L.kind,src:L.src,i:L.i,dx:L.dx|0,dy:L.dy|0,
      blend:L.blend||'normal',op:L.op===undefined?1:L.op,off:L.off?1:0,
      // 그린 층은 «누구인지» 도 적어야 한다. lid 를 빼면 다시 열었을 때 층들이
      // 한 열쇠로 뭉쳐 서로 덮어쓰고, track 을 빼면 한 줄로 합쳐진다.
      lid:L.lid,track:L.track,name:L.name,
      // 그린 층은 «누구인지» 도 적어야 한다. lid 를 빼면 다시 열었을 때 층들이
      // 한 열쇠로 뭉쳐 서로 덮어쓰고, track 을 빼면 한 줄로 합쳐진다.
      erase:isBlank(L)?(edits[layKey(L)]||[])
        :isForeign(L)?[]:(edits[K(L.src,L.i)]||[])}))}));
}
/**
 * 「굽기 확인」 — 저장했을 때 나올 알갱이를 서버에서 받아, 지금 화면과 한 점씩 맞대 본다.
 *
 * 화면과 gif 가 갈리는 병은 저장한 «뒤에» 드러난다. 드러날 땐 이미 아이들 화면에 가 있다.
 * 파일은 하나도 안 건드리므로 아무 때나 눌러도 된다.
 */
async function dryrun(){
  if(!cur||!seq.length){toast('먼저 낱장을 담으세요','err');return}
  commitStrokes();
  const btn=document.getElementById('drybtn');
  if(btn){btn.disabled=true;btn.textContent='재는 중…'}
  try{
    const r=await fetch('/api/dryrun',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({dir:cur.dir,kind:cur.kind,seq:recipeSteps()})});
    const j=await r.json();
    if(!j.ok){toast('굽기 확인 실패 — '+(j.error||''),'err');return}
    await new Promise(done=>ensureComposites(done));
    const urls=seq.map(slotURL);
    const imgs=await new Promise(done=>loadImgs(urls,done));
    const c=document.createElement('canvas');c.width=j.w;c.height=j.h;
    const x=c.getContext('2d',{willReadFrequently:true});
    let bad=0,firstBad=-1,worst=0;
    for(let n=0;n<seq.length;n++){
      const im=imgs[n];if(!im)continue;
      x.clearRect(0,0,j.w,j.h);x.drawImage(im,0,0);
      const shown=x.getImageData(0,0,j.w,j.h).data;
      const baked=fromB64(j.frames[n]);
      let diff=0;
      for(let i=0;i<shown.length;i++)if(shown[i]!==baked[i])diff++;
      if(diff){bad++;if(firstBad<0)firstBad=n;if(diff>worst)worst=diff}
    }
    if(bad)toast('갈립니다 — '+bad+'장이 화면과 다릅니다 (처음은 '+(firstBad+1)+'번째, 최대 '+worst+'자)','err');
    else toast(seq.length+'장 모두 화면과 굽는 것이 같습니다','ok');
    const kb=Math.round(JSON.stringify(recipeSteps()).length/1024);
    const el0=document.getElementById('drylab');
    if(el0)el0.textContent=(bad?('갈림 '+bad+'장'):('같음 '+seq.length+'장'))+' · 조리법 '+kb+'KB';
  }catch(e){ toast('굽기 확인 실패 — '+e.message,'err') }
  finally{ if(btn){btn.disabled=false;btn.textContent='굽기 확인'} }
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
  const steps=recipeSteps();
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
  // 떠 있는 조각이 있으면 Ctrl+Z 는 «그 붙이기부터» 물린다 (아세프라이트와 같다)
  if(k==='z'&&!e.shiftKey&&flt){ e.preventDefault(); cancelFloat(); toast('물렸습니다'); return; }
  if(k==='z'){ e.preventDefault(); e.shiftKey?redo():undo(); }
  if(k==='y'){ e.preventDefault(); redo(); }
  if(k==='a'&&openEd&&base){                    // 전체 선택
    e.preventDefault(); dropFloat();
    sel={x:0,y:0,w:base.w,h:base.h};setTool('sel');drawSel();updateSelLab();return;
  }
  if(k==='d'&&openEd&&sel){ e.preventDefault(); dropFloat(); sel=null;drawSel();updateSelLab(); return; }
  if(k==='x'&&openEd&&sel){                     // 오려내기 — 그림째 담고 그 자리를 비운다
    e.preventDefault();
    if(flt){ // 떠 있는 걸 오리면 조각만 담고 없앤다(뜬 자리는 이미 비어 있다)
      if(copySel()){const f=flt.from,copy=flt.copy;flt=null;fltBase=null;
        if(!copy)pushStrokes([eraseStroke(f)]);
        sel=null;redraw();drawSel();updateSelLab();toast('오려 냈습니다 — Ctrl+V 로 붙입니다')}
      return;
    }
    if(copySel()){ push();pushStrokes([eraseSel()]);
      redraw();drawSel();updateSelLab();toast('오려 냈습니다 — Ctrl+V 로 붙입니다') }
    return;
  }
  if(k==='c'){
    // 글자를 고르고 있으면 그건 진짜 복사다 — 뺏지 않는다.
    if(String(getSelection()||'').length) return;
    if(openEd&&sel){ e.preventDefault();
      toast(copySel()?'고른 곳을 그림째 복사했습니다 — 다른 낱장에도 Ctrl+V 로 붙습니다'
                     :'고른 곳이 비어 있습니다','err'); return; }
    if(selSlot!==null&&seq[selSlot]){ e.preventDefault();
      clip=copySlot(seq[selSlot]); clip._edits=slotEdits(seq[selSlot]).map(x=>JSON.parse(JSON.stringify(x)));
      toast('칸을 복사했습니다 — Ctrl+V 로 붙입니다'); }
    else if(openEd){ e.preventDefault(); clip={src:openEd.src,i:openEd.i,over:[]}; toast('이 낱장을 복사했습니다 — Ctrl+V 로 붙입니다'); }
    return;
  }
  if(k==='v'&&openEd&&clipPx){
    e.preventDefault();
    if(pasteFloat())toast('붙였습니다 — 끌어서 자리를 잡고 Enter 로 내려놓습니다');
    return;
  }
  if(k==='v'){
    if(!clip) return;
    e.preventDefault(); push();
    const at = selSlot!==null ? selSlot+1 : seq.length;
    const c=copySlot(clip); c.uid=newUid();
    if(clip._edits&&clip._edits.length)edits['slot:'+c.uid]=clip._edits.map(x=>JSON.parse(JSON.stringify(x)));
    seq.splice(at,0,c);
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
const TOOLKEY={b:'pencil',e:'eraser',i:'picker',g:'bucket',v:'move',n:'swap',
  m:'sel',q:'lasso',w:'wand',l:'line',u:'rect',o:'oval',d:'shade',t:'brush'};
const typingNow=e=>/^(INPUT|TEXTAREA)$/.test((e.target||{}).tagName||'');
addEventListener('keydown',e=>{
  if(!openEd||e.ctrlKey||e.metaKey||e.altKey||typingNow(e))return;
  if(e.code==='Space'){ e.preventDefault();
    if(!spaceDown){spaceDown=true;applyCursor()} return; }
  // 떠 있는 조각을 내려놓고·물리는 글쇠. 아세프라이트와 같다.
  if(e.key==='Enter'){ if(flt){e.preventDefault();dropFloat();sel=null;drawSel();updateSelLab();toast('내려놓았습니다')} return }
  if(e.key==='Escape'){ e.preventDefault();
    if(!cancelFloat()&&sel){sel=null;drawSel();updateSelLab()} return }
  // 화살표로 한 점씩 민다(Shift 면 여덟 점). 고른 곳이 있으면 «들어 올려서» 민다.
  if(isSelTool()&&sel&&e.key.indexOf('Arrow')===0){
    e.preventDefault();
    const n=e.shiftKey?8:1;
    const dx=(e.key==='ArrowRight'?n:0)-(e.key==='ArrowLeft'?n:0);
    const dy=(e.key==='ArrowDown'?n:0)-(e.key==='ArrowUp'?n:0);
    fltEdit(f=>fltSet({x:f.x+dx,y:f.y+dy}));
    return;
  }
  const k=e.key.toLowerCase();
  if(TOOLKEY[k]){e.preventDefault();setTool(TOOLKEY[k]);return}
  if(k==='['){e.preventDefault();setBrush(brush-1)}
  if(k===']'){e.preventDefault();setBrush(brush+1)}
});
addEventListener('keyup',e=>{
  if(e.code!=='Space')return;
  spaceDown=false;const c=document.getElementById('cv');if(c&&c.style.cursor!=='grabbing')applyCursor();
});

// ── 큰 편집기 ────────────────────────────────────────────────────────────
// 편집은 전용 작업대에서 한다(Aseprite·Canva 와 같다). 예전 기본이던 «창 모드» 는
// 그림 칸과 도구 칸이 한 줄에 안 들어가면 도구가 그림 «아래» 로 접혀서, 8배만 넘겨도
// 도구가 화면 밖(실측 y=1648, 창 높이 905)으로 사라졌다. 「창으로」 는 남겨 둔다.
let tool='pencil',color='#ffffff',brush=2,tol=20,onionOn=false,strokes=[],base=null,pal=[],edZoom=0,edFull=true,mountedKey=null,spaceDown=false;

// ── 도구마다 다른 손 모양 ────────────────────────────────────────────────
// 도구는 글쇠로도 바뀌니(b·e·i·g·v) 지금 무엇을 들었는지 단추 색만으로는 놓치기 쉽다.
// 아세프라이트처럼 «그림 위에서» 손 모양이 바뀌게 둔다. 도구 칸·단추 위는 그대로
// 화살표라야 누르는 느낌이 산다 — 그래서 캔버스에만 씌운다.
// 그림은 파일로 두지 않고 여기서 만든다(작업대는 파일 하나로 띄우는 것이 규칙이다).
// 흰 칸·검은 칸 어디서든 보이도록 흰 몸에 검은 테를 두른다.
// 뒤에 crosshair 를 붙여 둔다 — 그림 못 읽는 데서는 예전 십자가 그대로다.
const svgCur=(body,hx,hy)=>'url("data:image/svg+xml,'+encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
  +'<g fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round">'
  +body+'</g></svg>')+'") '+hx+' '+hy+',crosshair';
const TOOLCUR={
  // 연필·스포이드는 «찍는 끝» 이 왼쪽 아래다. 실제로 찍히는 자리는 손잡이 점(hotspot)이라
  // 그림이 조금 어긋나도 결과는 안 틀리지만, 끝을 맞춰 두면 눈이 편하다.
  pencil: svgCur('<path d="M2.6 21.4l1.1-4L15.3 5.8l2.9 2.9L6.6 20.3z"/>'
    +'<path d="M2.6 21.4l1.1-4 2.9 2.9z" fill="#111"/>'
    +'<path d="M15.3 5.8l2.9 2.9 1.5-1.5a2.05 2.05 0 000-2.9 2.05 2.05 0 00-2.9 0z"/>',2,22),
  eraser: svgCur('<path d="M3.4 20.3l-.8-.8a1.8 1.8 0 010-2.5L13.9 5.7a1.8 1.8 0 012.5 0l3.5 3.5a1.8 1.8 0 010 2.5l-8.4 8.6z"/>'
    +'<path d="M8.6 11.1l6.3 6.3" fill="none"/>',3,21),
  picker: svgCur('<path d="M2.7 21.3l.7-3.2 8.8-8.8 2.5 2.5-8.8 8.8z"/>'
    +'<path d="M13.1 6.4l1.7-1.7a2.4 2.4 0 013.4 0l.6.6a2.4 2.4 0 010 3.4l-1.7 1.7z"/>',2,22),
  bucket: svgCur('<path d="M13.4 2.6l-9.1 9.1a2.4 2.4 0 000 3.4l5.4 5.4a2.4 2.4 0 003.4 0l5.6-5.6a2.4 2.4 0 000-3.4z"/>'
    +'<path d="M17.2 6.4a3.4 3.4 0 00-4.8 0" fill="none"/>'
    +'<path d="M3.4 15.6c-1.1 1.7-1.7 2.8-1.7 3.5a1.7 1.7 0 103.4 0c0-.7-.6-1.8-1.7-3.5z"/>',3,19),
  swap:   svgCur('<path d="M3 5.5h12V2.2L20.5 7 15 11.8V8.5H3z"/>'
    +'<path d="M21 15.5H9v-3.3L3.5 17 9 21.8v-3.3h12z"/>',12,12),
  move:   'move',
  sel:    'crosshair',
  lasso:  svgCur('<path d="M12 3.2c5 0 8.8 2.4 8.8 5.4S17 14 12 14 3.2 11.6 3.2 8.6 7 3.2 12 3.2z" fill="none"/>'
    +'<path d="M8.4 13.1c-1.5 2.3-1.6 4.6-.2 5.7" fill="none"/>'
    +'<circle cx="7.6" cy="20" r="2.1"/>',3,3),
  ellipse:svgCur('<ellipse cx="12" cy="12" rx="9.2" ry="6.6" fill="none"/>'
    +'<path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" fill="none"/>',12,12),
  wand:   svgCur('<path d="M3.2 20.8l10.4-10.4 2.4 2.4L5.6 23.2z"/>'
    +'<path d="M17.4 3.2l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/>'
    +'<path d="M9.4 2.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/>',2,22)
};
// 고르는 도구들 — 넷 다 «고른 곳» 을 만들고, 떠 있는 조각을 다룬다.
const SELTOOLS=['sel','lasso','ellipse','wand'];
const isSelTool=()=>SELTOOLS.indexOf(tool)>=0;
// 도형 도구 — 끄는 동안 미리보기만 뜨고, 손을 떼야 구워진다.
const SHAPETOOLS=['line','rect','oval'];
const isShapeTool=()=>SHAPETOOLS.indexOf(tool)>=0;
// 모서리 손잡이 여덟 개의 손 모양. 잡으면 어느 쪽으로 늘어나는지가 손에 보인다.
const HZCUR={nw:'nwse-resize',se:'nwse-resize',ne:'nesw-resize',sw:'nesw-resize',
  n:'ns-resize',s:'ns-resize',e:'ew-resize',w:'ew-resize'};
/** 지금 도구에 맞는 손 모양을 캔버스에 씌운다. 밀기(스페이스)가 도구보다 먼저다. */
function applyCursor(){
  const c=document.getElementById('cv'); if(!c)return;
  c.style.cursor=spaceDown?'grab':(TOOLCUR[tool]||'crosshair');
}
// 「선택」 으로 고른 곳(그림 좌표). 고른 게 없으면 null.
//   sel = {x,y,w,h, mask}   mask 는 그 네모 «안» 에서 실제로 고른 점만 1인 표.
//   mask 가 null 이면 네모 통째로다 — 네모로 고르는 길은 예전과 똑같이 가볍게 돈다.
let sel=null;
/** 고른 곳을 그림 크기의 표 하나로 편다. 더하기·빼기는 이 표 위에서 한다. */
function fullMask(){
  const m=new Uint8Array(base.w*base.h);
  if(sel)for(let y=0;y<sel.h;y++)for(let x=0;x<sel.w;x++){
    if(sel.mask&&!sel.mask[y*sel.w+x])continue;
    const gx=sel.x+x,gy=sel.y+y;
    if(gx>=0&&gy>=0&&gx<base.w&&gy<base.h)m[gy*base.w+gx]=1;
  }
  return m;
}
/** 그림 크기의 표를 «고른 곳» 으로 되돌린다. 테두리를 재고, 네모 통째면 mask 를 버린다. */
function setSelFromMask(m){
  let x0=base.w,y0=base.h,x1=-1,y1=-1;
  for(let y=0;y<base.h;y++)for(let x=0;x<base.w;x++)if(m[y*base.w+x]){
    if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
  }
  if(x1<0){sel=null;return}
  const w=x1-x0+1,h=y1-y0+1,mask=new Uint8Array(w*h);let all=true;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const v=m[(y+y0)*base.w+(x+x0)]?1:0;mask[y*w+x]=v;if(!v)all=false;
  }
  sel={x:x0,y:y0,w,h,mask:all?null:mask};
}
/** 그 점이 «고른 곳» 안인가. 네모만 보면 올가미로 고른 바깥까지 잡힌다. */
function selHas(px,py){
  if(!sel)return false;
  const x=Math.floor(px)-sel.x,y=Math.floor(py)-sel.y;
  if(x<0||y<0||x>=sel.w||y>=sel.h)return false;
  return sel.mask?!!sel.mask[y*sel.w+x]:true;
}
/** 끌고 있는 모양(네모·타원·올가미)을 표로 그린다. */
function shapeMask(dg,p){
  const m=new Uint8Array(base.w*base.h);
  const put=(x,y)=>{if(x>=0&&y>=0&&x<base.w&&y<base.h)m[y*base.w+x]=1};
  const px=Math.floor(p.x),py=Math.floor(p.y);
  if(tool==='lasso'){
    // 이어 그은 선을 닫아서 그 «안» 을 채운다(홀짝 규칙 — 가로줄마다 몇 번 넘었는지 센다)
    const pt=dg.pts;
    if(pt.length<3){put(px,py);return m}
    let y0=base.h,y1=0;
    for(const q of pt){y0=Math.min(y0,Math.floor(q[1]));y1=Math.max(y1,Math.floor(q[1]))}
    for(let y=Math.max(0,y0);y<=Math.min(base.h-1,y1);y++){
      const cy=y+0.5,xs=[];
      for(let i=0;i<pt.length;i++){
        const a=pt[i],b=pt[(i+1)%pt.length];
        if((a[1]>cy)===(b[1]>cy))continue;
        xs.push(a[0]+(cy-a[1])/(b[1]-a[1])*(b[0]-a[0]));
      }
      xs.sort((u,v)=>u-v);
      for(let i=0;i+1<xs.length;i+=2)
        for(let x=Math.floor(xs[i]);x<=Math.floor(xs[i+1]);x++)put(x,y);
    }
    // 그은 선 자체도 고른 곳에 넣는다 — 가늘게 그으면 안이 비어 버린다
    for(const q of pt)put(Math.floor(q[0]),Math.floor(q[1]));
    return m;
  }
  const x0=Math.min(dg.ax,px),x1=Math.max(dg.ax,px);
  const y0=Math.min(dg.ay,py),y1=Math.max(dg.ay,py);
  if(tool==='ellipse'){
    const cx=(x0+x1+1)/2,cy=(y0+y1+1)/2,rx=(x1-x0+1)/2,ry=(y1-y0+1)/2;
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const dx=(x+0.5-cx)/rx,dy=(y+0.5-cy)/ry;
      if(dx*dx+dy*dy<=1)put(x,y);
    }
  }else{
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)put(x,y);
  }
  return m;
}
/** 더하기(Shift)·빼기(Alt)를 얹어 고른 곳을 갈아끼운다. */
function combineSel(m,op,prev){
  if(op==='add'&&prev)for(let i=0;i<m.length;i++)m[i]=(m[i]||prev[i])?1:0;
  else if(op==='sub'&&prev)for(let i=0;i<m.length;i++)m[i]=(prev[i]&&!m[i])?1:0;
  setSelFromMask(m);
  drawSel();updateSelLab();
}
/** 마술봉 — 누른 점과 «비슷한 색» 으로 이어진 덩어리만 고른다.
    허용 오차는 페인트통과 같은 손잡이(비슷한 색 허용)를 쓴다. */
function wandSelect(p,op,prev){
  const w=base.w,h=base.h;
  const d=ctxOf().getImageData(0,0,w,h).data;
  const sx=Math.floor(p.x),sy=Math.floor(p.y);
  if(sx<0||sy<0||sx>=w||sy>=h)return;
  const si=(sy*w+sx)*4,seed=[d[si],d[si+1],d[si+2],d[si+3]],t=(tol??20)**2*3;
  const near=i=>{
    if(seed[3]<40)return d[i+3]<40;
    if(d[i+3]<40)return false;
    const a=d[i]-seed[0],b=d[i+1]-seed[1],g=d[i+2]-seed[2];
    return a*a+b*b+g*g<=t;
  };
  const m=new Uint8Array(w*h),seen=new Uint8Array(w*h),st=[sy*w+sx];seen[sy*w+sx]=1;
  while(st.length){
    const q=st.pop(); if(!near(q*4))continue;
    m[q]=1;
    const x=q%w,y=(q/w)|0;
    if(x>0&&!seen[q-1]){seen[q-1]=1;st.push(q-1)}
    if(x<w-1&&!seen[q+1]){seen[q+1]=1;st.push(q+1)}
    if(y>0&&!seen[q-w]){seen[q-w]=1;st.push(q-w)}
    if(y<h-1&&!seen[q+w]){seen[q+w]=1;st.push(q+w)}
  }
  combineSel(m,op,prev);
}
// 복사해 둔 «알갱이». 자리만 담으면 다른 낱장에 붙일 때 그 낱장 제 그림이 복제된다
// (2026-08-25 원장님: "다른 프레임에 붙여넣었는데 본체랑 합쳐진다"). 그림째 담는다.
// clipPx = {w,h,x,y,b64}   b64 = 점 하나에 RGBA 넉 자, 그걸 통째로 base64
let clipPx=null;

// ── 떠 있는 조각 ─────────────────────────────────────────────────────────
// 아세프라이트와 같은 손이다. 고른 곳을 «끌거나» 붙이면 알갱이가 그림에서 들려
// 여기 담긴다. 떠 있는 동안은 그림에 굽지 않는다 — 그래서
//   · 본체가 안 따라오고(뜬 자리는 내려놓을 때 한 번만 비운다),
//   · 열 번을 돌리고 키워도 언제나 «원본 알갱이» 에서 다시 뜨니 도트가 안 뭉갠다.
// 내려놓는 때: Enter · 딴 도구 · 딴 낱장 · 저장 · 적용.  Esc 면 물린다.
// 들어 올린 것부터 내려놓기까지가 되돌리기 «한 칸» 이다(아세프라이트도 그렇다).
let flt=null;
// flt = { w,h        들어 올린 원본 크기
//         b64        다른 낱장에서 온 것이면 그 알갱이(같은 낱장에서 떴으면 없다)
//         x,y,dw,dh  놓일 자리와 크기      rot,fx,fy  돌림·뒤집기
//         from       {t:'here',x,y,w,h} | {t:'clip'}
//         copy       1이면 뜬 자리를 안 비운다(Alt+끌기 = 복제)
//         snapAt     들어 올릴 때의 되돌리기 깊이 — 물릴 때 그 칸도 같이 걷는다 }
let fltBase=null;   // 조각 없는 그림. 끌 때마다 밑칠을 처음부터 다시 하지 않으려고 담아 둔다.

// ── 도형 그리기와 좌우 대칭 ──────────────────────────────────────────────
// 직선·네모·타원은 «표 하나로 칠하기»(pm) 한 손질로 구워진다. 도형마다 손질을 따로
// 두면 두 런타임에 같은 셈을 네 벌씩 둬야 한다 — 어긋날 자리를 미리 없앤다.
// 미리보기도 «구울 그 손질» 을 그대로 얹어 보여주므로 보이는 것과 구운 것이 안 갈린다.
let shapePrev=null;   // 긋는 중인 도형 (아직 안 구운 손질 줄)
let fillShape=false;  // 네모·타원을 속까지 채울지
let symOn=false;      // 좌우 대칭 — 이펙트는 대칭이 많아 손이 반으로 준다
/** 그림 크기의 표를 만든다. 붓 굵기만큼 두툼한 점을 찍는 붓과 함께. */
function newMask(){return new Uint8Array(base.w*base.h)}
const maskDot=(m,cx,cy,r)=>{
  const rr=r*r;
  const x0=Math.max(0,Math.floor(cx-r)),y0=Math.max(0,Math.floor(cy-r));
  const x1=Math.min(base.w,Math.ceil(cx+r)),y1=Math.min(base.h,Math.ceil(cy+r));
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const dx=x+0.5-cx,dy=y+0.5-cy;
    if(dx*dx+dy*dy<=rr)m[y*base.w+x]=1;
  }
};
/** 두 점을 잇는 곧은 선. 붓 굵기를 따라 두툼해진다. */
function maskLine(m,a,b,r){
  const n=Math.max(1,Math.ceil(Math.max(Math.abs(b.x-a.x),Math.abs(b.y-a.y))*2));
  for(let i=0;i<=n;i++)maskDot(m,a.x+(b.x-a.x)*i/n,a.y+(b.y-a.y)*i/n,r);
}
/** 끌고 있는 도형을 표로 그린다. */
function shapeToMask(a,p,square){
  const m=newMask(),r=brush/2;
  if(tool==='line'){
    let q=p;
    if(square){                                  // Shift = 0·45·90도로 붙인다
      const dx=p.x-a.x,dy=p.y-a.y,ax=Math.abs(dx),ay=Math.abs(dy);
      if(ax>ay*2)q={x:p.x,y:a.y};
      else if(ay>ax*2)q={x:a.x,y:p.y};
      else{const d=(ax+ay)/2;q={x:a.x+Math.sign(dx)*d,y:a.y+Math.sign(dy)*d}}
    }
    maskLine(m,a,q,r);
    return m;
  }
  let x0=Math.min(a.x,p.x),x1=Math.max(a.x,p.x);
  let y0=Math.min(a.y,p.y),y1=Math.max(a.y,p.y);
  if(square){                                    // Shift = 정사각형·정원
    const d=Math.max(x1-x0,y1-y0);
    if(p.x<a.x)x0=x1-d; else x1=x0+d;
    if(p.y<a.y)y0=y1-d; else y1=y0+d;
  }
  if(tool==='rect'){
    if(fillShape){
      for(let y=Math.floor(y0);y<=Math.floor(y1);y++)for(let x=Math.floor(x0);x<=Math.floor(x1);x++)
        if(x>=0&&y>=0&&x<base.w&&y<base.h)m[y*base.w+x]=1;
    }else{
      maskLine(m,{x:x0,y:y0},{x:x1,y:y0},r);maskLine(m,{x:x1,y:y0},{x:x1,y:y1},r);
      maskLine(m,{x:x1,y:y1},{x:x0,y:y1},r);maskLine(m,{x:x0,y:y1},{x:x0,y:y0},r);
    }
    return m;
  }
  // 타원 — 속을 채우거나, 붓 굵기만큼의 테두리만
  const cx=(x0+x1)/2,cy=(y0+y1)/2,rx=Math.max(0.5,(x1-x0)/2),ry=Math.max(0.5,(y1-y0)/2);
  const inside=(x,y,sx,sy)=>{
    const dx=(x+0.5-cx)/sx,dy=(y+0.5-cy)/sy;return dx*dx+dy*dy<=1;
  };
  const irx=Math.max(0,rx-brush),iry=Math.max(0,ry-brush);
  for(let y=Math.max(0,Math.floor(cy-ry-1));y<=Math.min(base.h-1,Math.ceil(cy+ry+1));y++)
    for(let x=Math.max(0,Math.floor(cx-rx-1));x<=Math.min(base.w-1,Math.ceil(cx+rx+1));x++){
      if(!inside(x,y,rx,ry))continue;
      if(!fillShape&&irx>0&&iry>0&&inside(x,y,irx,iry))continue;
      m[y*base.w+x]=1;
    }
  return m;
}
/** 표를 «칠하기 손질» 하나로 여민다. 빈 가장자리는 잘라 낸다. */
function maskStroke(m,rgb){
  // 무늬가 켜져 있으면 표에서 «한 점 걸러» 만 남긴다. 표는 이미 점 단위라 여기서 거르면 된다.
  if(dithOn){for(let y=0;y<base.h;y++)for(let x=0;x<base.w;x++)if((x+y)%2)m[y*base.w+x]=0}
  let x0=base.w,y0=base.h,x1=-1,y1=-1;
  for(let y=0;y<base.h;y++)for(let x=0;x<base.w;x++)if(m[y*base.w+x]){
    if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
  }
  if(x1<0)return null;
  const w=x1-x0+1,h=y1-y0+1,out=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)out[y*w+x]=m[(y+y0)*base.w+(x+x0)];
  return {t:'pm',x:x0,y:y0,w,h,mask:toB64(out),color:rgb};
}
/** 좌우로 뒤집은 표. 대칭이 켜져 있으면 그은 것과 «짝» 을 같이 남긴다. */
function mirrorMask(m){
  const o=newMask();
  for(let y=0;y<base.h;y++)for(let x=0;x<base.w;x++)
    if(m[y*base.w+x])o[y*base.w+(base.w-1-x)]=1;
  return o;
}
/** 도형 하나가 남길 손질 줄. 대칭이면 두 줄이 된다. */
function shapeStrokes(m){
  const rgb=hex2rgb(color),out=[];
  const a=maskStroke(m,rgb); if(a)out.push(a);
  if(symOn){const b=maskStroke(mirrorMask(m),rgb); if(b)out.push(b)}
  return out;
}

// ── 명암 붓 ──────────────────────────────────────────────────────────────
// 밝게/어둡게를 «색을 새로 만들어» 칠하면 도트 그림의 색 수가 금세 불어난다. 아세프라이트는
// 그 낱장이 쓰던 색을 줄 세워 두고 그 사이를 한 눈금씩 오간다. 여기도 같은 손이다.
// 한 번 끄는 동안 지나간 자리를 «몇 번 지났는지» 로 모아 두었다가, 손 뗄 때 손질 하나로 굽는다.
let shade=null;       // {x,y,w,h,steps:Uint8Array} 끄는 중인 명암
let shadeDir=-1;      // -1 어둡게 · +1 밝게
let onionN=1;         // 앞뒤로 몇 장까지 비출지
let dithOn=false;     // 무늬 — 한 점 걸러 한 점만 칠하기
let brushDrag=null;   // 도장붓으로 찍은 자리들

// ── 도장붓 ───────────────────────────────────────────────────────────────
// 「고른 곳」 을 Ctrl+C 로 복사해 두면 그걸 붓처럼 툭툭 찍는다. 불티·별·연기처럼
// 같은 알갱이를 여럿 흩뿌리는 이펙트에 손이 제일 많이 가는 자리다.
// 찍은 자리가 스물이어도 알갱이 꾸러미는 «하나» 다 — 저장 파일이 그만큼 안 부푼다.
function brushStroke(){
  if(!brushDrag||!brushDrag.at.length||!clipPx)return null;
  return {t:'stamps',sw:clipPx.w,sh:clipPx.h,data:clipPx.b64,at:brushDrag.at.slice()};
}
/** 붓이 지나간 자리에 조각 하나를 얹는다. 너무 촘촘히 겹치지 않게 띄엄띄엄 찍는다. */
function brushDab(p){
  if(!clipPx)return;
  const gap=Math.max(2,Math.round(Math.max(clipPx.w,clipPx.h)*0.6));
  const x=Math.round(p.x-clipPx.w/2),y=Math.round(p.y-clipPx.h/2);
  if(!brushDrag)brushDrag={at:[]};
  const last=brushDrag.at[brushDrag.at.length-1];
  if(last&&Math.abs(last[0]-x)<gap&&Math.abs(last[1]-y)<gap)return;
  brushDrag.at.push([x,y]);
  if(symOn)brushDrag.at.push([base.w-clipPx.w-x,y]);
}
/**
 * 색 줄 — 어두운 것부터 밝은 것까지.
 *
 * 옆 칸의 «색 목록» 을 쓰면 안 된다. 그건 손대기 «전» 원본의 색이라, 색을 손본 뒤에
 * 명암을 칠하면 화면에 없던 옛 색이 되살아난다(실측: 색 87개짜리 그림에 새 색 6개가 생겼다).
 * 지금 화면에 실제로 깔린 색만 센다 — 그래야 도트 색 수가 안 늘어난다.
 */
function shadeRamp(){
  const d=ctxOf().getImageData(0,0,base.w,base.h).data,n=new Map();
  for(let i=0;i<d.length;i+=4){
    if(d[i+3]===0)continue;
    const k=(d[i]<<16)|(d[i+1]<<8)|d[i+2];
    n.set(k,(n.get(k)||0)+1);
  }
  return [...n.entries()].sort((a,b)=>b[1]-a[1]).slice(0,64)
    .map(([k])=>[(k>>16)&255,(k>>8)&255,k&255])
    .sort((a,b)=>(a[0]*.299+a[1]*.587+a[2]*.114)-(b[0]*.299+b[1]*.587+b[2]*.114));
}
/**
 * 끄는 중인 명암을 «구울 그 손질» 로 여민다. 미리보기도 이걸 쓴다.
 *
 * 지나간 자리만 잘라 담는다. 그림 크기 표를 통째로 담으면 열 점 문지른 한 번이
 * 조리법을 22KB 씩 불린다(실측: 1KB → 23KB). 다른 표 손질도 다 잘라 담는다.
 */
function shadeStroke(){
  if(!shade)return null;
  const W=shade.w,H=shade.h,st=shade.steps;
  let x0=W,y0=H,x1=-1,y1=-1;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(st[y*W+x]){
    if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
  }
  if(x1<0)return null;                          // 아무 데도 안 닿았으면 남길 게 없다
  const w=x1-x0+1,h=y1-y0+1,out=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)out[y*w+x]=st[(y+y0)*W+(x+x0)];
  return {t:'sh',x:shade.x+x0,y:shade.y+y0,w,h,
    steps:toB64(out),dir:shadeDir,ramp:shade.ramp};
}
/** 붓이 지나간 자리를 한 눈금씩 더한다. */
function shadeDab(p){
  if(!shade)shade={x:0,y:0,w:base.w,h:base.h,steps:new Uint8Array(base.w*base.h),ramp:shadeRamp()};
  const r=brush/2,rr=r*r;
  const xs=symOn?[p.x,base.w-p.x]:[p.x];
  for(const cx of xs){
    const x0=Math.max(0,Math.floor(cx-r)),y0=Math.max(0,Math.floor(p.y-r));
    const x1=Math.min(base.w,Math.ceil(cx+r)),y1=Math.min(base.h,Math.ceil(p.y+r));
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const dx=x+0.5-cx,dy=y+0.5-p.y;
      if(dx*dx+dy*dy>rr)continue;
      const i=y*base.w+x;
      if(shade.steps[i]<8)shade.steps[i]++;   // 한자리를 오래 문질러도 8눈금까지만
    }
  }
}

// ── 색 손보기 ────────────────────────────────────────────────────────────
// 손잡이를 미는 동안은 «아직 안 구운» 채로 화면에만 얹는다. 「적용」을 눌러야 손질로
// 남는다 — 밀다 만 것이 조용히 구워지면 되돌리기 역사가 손잡이질마다 쌓여 지저분해진다.
// 다만 딴 낱장·저장으로 넘어갈 땐 얹혀 있던 것을 그 자리에서 굽는다(잃지 않게).
let adj=null;       // {x,y,w,h,mask, hue,sat,val,con}
const ADJ0={hue:0,sat:100,val:100,con:0};
const adjIdle=a=>!a||(!a.hue&&a.sat===100&&a.val===100&&!a.con);
/** 색 손보기를 손질로 남긴다. 아무것도 안 민 상태면 그냥 버린다. */
function dropAdj(){
  if(!adj)return false;
  const a=adj;adj=null;
  if(adjIdle(a)){redraw();return false}
  pushStrokes([a]);redraw();return true;
}

// ── 모든 장에 한 번에 ────────────────────────────────────────────────────
// 이펙트는 12장이 한 몸이다. 색을 손보거나 조각을 얹는 일은 «한 장만» 하는 게 오히려
// 드물다. 그런데 지금까지는 12번 똑같은 손질을 반복해야 했다.
// 켜 두면 손질 하나가 이어 붙인 줄의 «모든 칸» 에 그대로 얹힌다.
let allFrames=false;
const cloneStroke=s=>JSON.parse(JSON.stringify(s));
/**
 * 손질을 얹는다. 「모든 장에」가 꺼져 있으면 지금 낱장에만.
 *
 * 켜져 있으면 칸마다 «제 손질 줄» 을 먼저 만들고(없으면 지금 것을 베껴서) 거기에 얹는다.
 * 재료 낱장의 손질 줄에 바로 얹으면 그 낱장을 같이 쓰는 «다른 칸까지» 딸려 바뀐다 —
 * 공유하는 줄은 건드리기 전에 갈아끼워야 한다.
 */
function pushStrokes(ss){
  strokes.push(...ss.map(cloneStroke));
  if(!allFrames)return;
  // 다른 칸에는 «지금 바로» 얹힌다. 그런데 지금 칸은 「적용」 때 얹히므로, 그 사이에
  // 되돌리기 칸이 하나 더 생긴다 — Ctrl+Z 를 한 번 누르면 연 장만 돌아오고 나머지 여섯은
  // 그대로 남는다(실측: 7장 → 6장 남음). 원장님이 만든 적 없는 중간 상태다.
  // 지금 칸도 여기서 같이 얹어 «한 번 그은 것 = 되돌리기 한 칸» 으로 맞춘다.
  if(openEd){
    if(strokes.length)edits[openEd.key]=strokes.slice();else delete edits[openEd.key];
    delete editedCache[openEd.key];
  }
  // 층을 고치는 중이면 «그 줄» 의 칸마다 얹는다. 바닥에 얹으면 층으로 그린 것이
  // 본체에 구워져 버려서, 층을 지워도 안 없어진다 — 층의 뜻과 정반대다.
  if(openEd&&openEd.blank){
    const me=seq[openEd.slot];
    const L0=me&&(me.over||[]).find(x=>x.lid===openEd.lid);
    if(!L0)return;
    const tr=trackOf(L0);
    seq.forEach(s=>{
      if(s===me)return;
      let L=celAt(s,tr);
      if(!L){                                   // 그 장에 아직 칸이 없으면 만들어 준다
        L={src:'blank',i:0,lid:newUid(),track:tr,dx:0,dy:0,blend:'normal',op:1};
        s.over=s.over||[];s.over.push(L);
      }
      if(L.lid===openEd.lid)return;             // 같은 그림을 함께 쓰는 칸엔 이미 얹혔다
      const k=layKey(L);
      edits[k]=(edits[k]||[]).concat(ss.map(cloneStroke));
      delete editedCache[k];
    });
    Object.keys(compCache).forEach(k=>delete compCache[k]);
    return;
  }
  const meKey=openEd?openEd.key:null;
  seq.forEach(s=>{
    const own=slotOwn(s);
    if(own===meKey)return;                       // 지금 열어 둔 칸은 위에서 이미 얹었다
    if(!edits[own])edits[own]=slotEdits(s).map(cloneStroke);
    edits[own].push(...ss.map(cloneStroke));
    delete editedCache[own];
  });
  Object.keys(compCache).forEach(k=>delete compCache[k]);
}

/** 지금 떠 있는 조각을 «내려놓으면 남을» 손질 그대로 돌려준다.
    미리보기도 이걸로 그린다 — 보이는 것과 구워지는 것이 어긋날 자리를 아예 없앤다. */
function fltStrokes(){
  if(!flt)return [];
  const at={dx:Math.round(flt.x),dy:Math.round(flt.y),
    dw:Math.max(1,Math.round(flt.dw)),dh:Math.max(1,Math.round(flt.dh)),
    rot:flt.rot|0,fx:flt.fx?1:0,fy:flt.fy?1:0};
  if(!flt.b64&&flt.from.t==='here')
    // 같은 낱장에서 «네모로» 뜬 것은 알갱이를 안 담는다 — 뜬 자리를 그대로 가리키면 된다.
    // cut:1 이 «먼저 읽고 그 다음 비우기» 라 한 손질로 옮기기가 된다.
    return [Object.assign({t:'blit',sx:flt.from.x,sy:flt.from.y,sw:flt.w,sh:flt.h,
      cut:flt.copy?0:1},at)];
  // 알갱이를 지고 다니는 조각(다른 낱장에서 온 것 · 올가미로 뜬 것 · 비스듬히 돌린 것).
  // 뜬 자리는 따로 비우고(복제거나 남의 낱장에서 온 것이면 안 비운다), 조각은 알갱이째 찍는다.
  const stamp=Object.assign({t:'stamp',sw:flt.w,sh:flt.h,data:flt.b64},at);
  const er=(flt.copy||flt.from.t==='clip')?null:eraseStroke(flt.from);
  return er?[er,stamp]:[stamp];
}
const fltRect=()=>({x:Math.round(flt.x),y:Math.round(flt.y),
  w:Math.max(1,Math.round(flt.dw)),h:Math.max(1,Math.round(flt.dh))});
/** 고른 네모를 그림 안으로 자른다. 밖으로 나간 게 전부면 null. */
function clampRect(r){
  const x=Math.max(0,Math.floor(r.x)),y=Math.max(0,Math.floor(r.y));
  const x1=Math.min(base.w,Math.ceil(r.x+r.w)),y1=Math.min(base.h,Math.ceil(r.y+r.h));
  return (x1>x&&y1>y)?{x,y,w:x1-x,h:y1-y}:null;
}
/** 고른 곳을 들어 올린다. copy 면 뜬 자리를 안 비운다(Alt+끌기). */
function liftSel(copy){
  if(!sel||flt||!base)return false;
  const r=clampRect(sel); if(!r)return false;
  const selWas=Object.assign({},sel);
  const mk=cropMask(r);                     // 네모면 null
  push();                                   // 들어 올린 것부터가 되돌리기 한 칸
  redraw();                                 // 조각 없는 그림을 먼저 만들어 담아 둔다
  fltBase=ctxOf().getImageData(0,0,base.w,base.h);
  const from=mk
    ? {t:'mask',x:r.x,y:r.y,w:r.w,h:r.h,mask:toB64(mk)}
    : {t:'here',x:r.x,y:r.y,w:r.w,h:r.h};
  // 표로 고른 것은 알갱이를 «오려서» 지고 다닌다 — 표 밖은 비워 둔다.
  const b64=mk?toB64(maskedPixels(r,mk)):null;
  flt={w:r.w,h:r.h,b64,x:r.x,y:r.y,dw:r.w,dh:r.h,rot:0,fx:0,fy:0,angle:0,
    baseW:r.w,baseH:r.h,cx:r.x+r.w/2,cy:r.y+r.h/2,from,copy:copy?1:0,snapAt:undoStack.length,selWas};
  // 떠 있는 동안은 네모 손잡이로 다룬다(아세프라이트도 그렇다). 표는 물릴 때 되살린다.
  sel={x:r.x,y:r.y,w:r.w,h:r.h,mask:null};
  redraw();drawSel();updateSelLab();
  return true;
}
/** 뜬 자리를 비우는 손질 하나. 네모면 네모 지우기, 표면 표대로 지우기. */
const eraseStroke=f=>f.t==='mask'
  ?{t:'em',x:f.x,y:f.y,w:f.w,h:f.h,mask:f.mask}
  :{t:'r',x:f.x,y:f.y,w:f.w,h:f.h};
/** 지금 «고른 곳» 을 비우는 손질 하나. */
function eraseSel(){
  const r=clampRect(sel)||{x:sel.x,y:sel.y,w:sel.w,h:sel.h};
  const mk=cropMask(r);
  return mk?{t:'em',x:r.x,y:r.y,w:r.w,h:r.h,mask:toB64(mk)}
           :{t:'r',x:r.x,y:r.y,w:r.w,h:r.h};
}
/** 고른 곳의 표를 «잘라낸 네모» 에 맞춰 오려 온다. 네모 통째면 null. */
function cropMask(r){
  if(!sel||!sel.mask)return null;
  const m=new Uint8Array(r.w*r.h);
  for(let y=0;y<r.h;y++)for(let x=0;x<r.w;x++){
    const sx=r.x+x-sel.x,sy=r.y+y-sel.y;
    if(sx<0||sy<0||sx>=sel.w||sy>=sel.h)continue;
    m[y*r.w+x]=sel.mask[sy*sel.w+sx];
  }
  return m;
}
/** 그 네모의 알갱이를 표대로 오려 온다. 표 밖은 투명하게 둔다. */
function maskedPixels(r,m){
  const d=ctxOf().getImageData(r.x,r.y,r.w,r.h).data,out=new Uint8Array(r.w*r.h*4);
  for(let i=0;i<r.w*r.h;i++){
    if(!m[i])continue;
    out[i*4]=d[i*4];out[i*4+1]=d[i*4+1];out[i*4+2]=d[i*4+2];out[i*4+3]=d[i*4+3];
  }
  return out;
}
/** 조각을 그림에 내려놓는다. 손질 한 줄만 남는다. */
function dropFloat(){
  if(!flt)return false;
  const ss=fltStrokes();
  flt=null;fltBase=null;
  pushStrokes(ss);
  redraw();drawSel();updateSelLab();
  return true;
}
/** 붙이거나 들어 올린 것을 «없던 일로» 한다. 아직 안 구웠으니 그냥 버리면 된다. */
function cancelFloat(){
  if(!flt)return false;
  const f=flt.from,snapAt=flt.snapAt,selWas=flt.selWas;
  flt=null;fltBase=null;
  // 들어 올릴 때 쌓아 둔 되돌리기 칸도 같이 걷는다 — 아무 일도 안 일어난 셈이니까.
  if(undoStack.length===snapAt&&snapAt>0)undoStack.pop();
  // 올가미로 고른 것이면 그 «표» 까지 그대로 되살린다
  sel=selWas||((f.t==='here')?{x:f.x,y:f.y,w:f.w,h:f.h,mask:null}:null);
  redraw();drawSel();updateSelLab();
  return true;
}
// ── 비스듬히 돌리기 (RotSprite) ──────────────────────────────────────────
// 도트 그림을 45도로 돌리면 «가장 가까운 점» 셈으로는 계단이 잘게 부서져 뭉갠다.
// 아세프라이트가 쓰는 손은 이렇다 — 먼저 8배로 «도트 결을 살려» 키우고, 그 큰 그림에서
// 돌린 다음, 8×8 칸마다 «가장 많은 색» 으로 도로 줄인다. 그래야 선이 안 부서진다.
/** 도트 결을 살려 두 배로 키운다(EPX). 네 이웃이 같은 쪽으로 모서리를 채운다. */
function scale2x(src,w,h){
  const W=w*2,H=h*2,out=new Uint8Array(W*H*4);
  const at=(x,y)=>{
    x=Math.max(0,Math.min(w-1,x));y=Math.max(0,Math.min(h-1,y));
    const i=(y*w+x)*4;return (src[i]<<24)|(src[i+1]<<16)|(src[i+2]<<8)|src[i+3];
  };
  const put=(x,y,v)=>{const o=(y*W+x)*4;
    out[o]=(v>>>24)&255;out[o+1]=(v>>>16)&255;out[o+2]=(v>>>8)&255;out[o+3]=v&255};
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const P=at(x,y),A=at(x,y-1),B=at(x+1,y),C=at(x-1,y),D=at(x,y+1);
    let e0=P,e1=P,e2=P,e3=P;
    if(C===A&&C!==D&&A!==B)e0=A;
    if(A===B&&A!==C&&B!==D)e1=B;
    if(D===C&&D!==B&&C!==A)e2=C;
    if(B===D&&B!==A&&D!==C)e3=D;
    put(x*2,y*2,e0);put(x*2+1,y*2,e1);put(x*2,y*2+1,e2);put(x*2+1,y*2+1,e3);
  }
  return {px:out,w:W,h:H};
}
/** 비스듬히 돌린 알갱이를 새로 뜬다. deg 는 시계 방향. */
function rotSprite(src,w,h,deg){
  let b={px:src,w,h};
  for(let i=0;i<3;i++)b=scale2x(b.px,b.w,b.h);      // 8배
  const rad=deg*Math.PI/180,cs=Math.cos(rad),sn=Math.sin(rad);
  const nw=Math.max(1,Math.ceil(Math.abs(w*cs)+Math.abs(h*sn)));
  const nh=Math.max(1,Math.ceil(Math.abs(w*sn)+Math.abs(h*cs)));
  const out=new Uint8Array(nw*nh*4),cnt=new Map();
  for(let y=0;y<nh;y++)for(let x=0;x<nw;x++){
    cnt.clear();
    for(let sy=0;sy<8;sy++)for(let sx=0;sx<8;sx++){
      const ox=(x+(sx+0.5)/8)-nw/2, oy=(y+(sy+0.5)/8)-nh/2;
      const ux=( ox*cs+oy*sn)+w/2,  uy=(-ox*sn+oy*cs)+h/2;
      const bx=Math.floor(ux*8),by=Math.floor(uy*8);
      let k='-';
      if(bx>=0&&by>=0&&bx<b.w&&by<b.h){
        const i=(by*b.w+bx)*4;
        if(b.px[i+3]!==0)k=b.px[i]+','+b.px[i+1]+','+b.px[i+2];
      }
      cnt.set(k,(cnt.get(k)||0)+1);
    }
    let best='-',bn=0;
    for(const [k,n] of cnt)if(n>bn){bn=n;best=k}
    if(best==='-')continue;
    const v=best.split(','),o=(y*nw+x)*4;
    out[o]=+v[0];out[o+1]=+v[1];out[o+2]=+v[2];out[o+3]=255;
  }
  return {px:out,w:nw,h:nh};
}
/** 떠 있는 조각의 «원본 알갱이» 를 챙겨 둔다. 비스듬히 돌리려면 알갱이가 있어야 한다. */
function fltEnsurePixels(){
  if(!flt||flt.src)return;
  if(flt.b64){flt.src={w:flt.w,h:flt.h,b64:flt.b64};return}
  // 네모로 뜬 것은 알갱이를 안 담고 있었다 — 조각 없는 그림에서 그 자리를 떠 온다.
  const f=flt.from,tmp=document.createElement('canvas');
  tmp.width=base.w;tmp.height=base.h;
  const tc=tmp.getContext('2d',{willReadFrequently:true});
  tc.putImageData(fltBase,0,0);
  const d=tc.getImageData(f.x,f.y,f.w,f.h).data;
  flt.src={w:f.w,h:f.h,b64:toB64(new Uint8Array(d))};
}
/**
 * 조각을 그 각도로 돌린다. 언제나 «원본 알갱이» 에서 다시 뜬다 —
 * 돌린 것을 또 돌리면 그때부터 뭉개지기 때문이다.
 */
function fltSetAngle(deg){
  if(!flt)return;
  deg=((Math.round(deg)%360)+360)%360;
  flt.angle=deg;
  if(deg%90===0){
    // 직각은 원래 있던 «가장 가까운 점» 셈이 정확하다. 굳이 8배로 키울 것 없다.
    if(flt.src){flt.b64=flt.src.b64;flt.w=flt.src.w;flt.h=flt.src.h}
    flt.rot=deg;flt.free=0;
    const sw=(deg===90||deg===270)?flt.h:flt.w;
    const sh=(deg===90||deg===270)?flt.w:flt.h;
    fltFitTo(sw,sh);
    return;
  }
  fltEnsurePixels();
  const r=rotSprite(fromB64(flt.src.b64),flt.src.w,flt.src.h,deg);
  flt.b64=toB64(r.px);flt.w=r.w;flt.h=r.h;flt.rot=0;flt.free=1;
  flt.pix=1;                                   // 이제부터는 알갱이째 굽는다
  fltFitTo(r.w,r.h);
}
/** 조각의 «놓일 크기» 를 새 알갱이 크기에 맞춘다. 늘려 둔 배율과 가운데는 붙잡아 둔다. */
function fltFitTo(nw,nh){
  const oldW=flt.baseW||nw,oldH=flt.baseH||nh;
  const sx=(flt.dw||oldW)/oldW,sy=(flt.dh||oldH)/oldH;
  const cx=(flt.cx===undefined)?flt.x+flt.dw/2:flt.cx;
  const cy=(flt.cy===undefined)?flt.y+flt.dh/2:flt.cy;
  flt.baseW=nw;flt.baseH=nh;
  flt.dw=Math.max(1,Math.round(nw*sx));flt.dh=Math.max(1,Math.round(nh*sy));
  flt.x=Math.round(cx-flt.dw/2);flt.y=Math.round(cy-flt.dh/2);
}
/** 조각을 바꿔 놓는다(자리·크기·돌림). 굽지 않으니 몇 번을 해도 안 뭉갠다. */
function fltSet(o){
  if(!flt)return;
  Object.assign(flt,o);
  // 자리나 크기를 손댔으면 가운데를 다시 적어 둔다(돌릴 때 이 가운데를 붙잡는다)
  if('x' in o||'dw' in o)flt.cx=flt.x+flt.dw/2;
  if('y' in o||'dh' in o)flt.cy=flt.y+flt.dh/2;
  const r=fltRect(); sel={x:r.x,y:r.y,w:r.w,h:r.h};
  redraw();drawSel();updateSelLab();
}
/** 조각이 없으면 먼저 들어 올리고 나서 바꾼다. ⟳ ↔ ＋ 가 다 이 손을 쓴다. */
function fltEdit(fn){
  if(!flt&&!liftSel(false))return;
  fn(flt);
  fltSet({});
}
/** 손잡이를 끌어 크기를 바꾼다. 잡은 쪽 반대편은 못 박힌 채로 늘어난다. */
function fltScale(dg,p,keep){
  const f=dg.from,hz=dg.hz,R=f.x+f.w,B=f.y+f.h;
  const mx=Math.round(p.x-dg.ox),my=Math.round(p.y-dg.oy);
  let x=f.x,y=f.y,dw=f.w,dh=f.h;
  if(hz.indexOf('w')>=0){x=Math.min(R-1,f.x+mx);dw=R-x}
  if(hz.indexOf('e')>=0){dw=Math.max(1,f.w+mx)}
  if(hz.indexOf('n')>=0){y=Math.min(B-1,f.y+my);dh=B-y}
  if(hz.indexOf('s')>=0){dh=Math.max(1,f.h+my)}
  if(keep&&hz.length===2){                    // Shift = 원래 비율 그대로 (모서리 손잡이만)
    dh=Math.max(1,Math.round(dw*f.h/f.w));
    if(hz.indexOf('n')>=0)y=B-dh;
  }
  fltSet({x,y,dw,dh});
}
/** 고른 곳을 그림째 복사한다. 빈 가장자리는 잘라 낸다 — 저장 파일이 그만큼 얇아진다. */
function copySel(){
  if(!sel||!base)return false;
  const r=clampRect(sel); if(!r)return false;
  const mk=cropMask(r);
  // 표로 고른 것은 표 밖을 «비운 채로» 담는다 — 안 그러면 네모째 딸려 온다
  const px=mk?maskedPixels(r,mk):ctxOf().getImageData(r.x,r.y,r.w,r.h).data;
  let x0=r.w,y0=r.h,x1=-1,y1=-1;
  for(let y=0;y<r.h;y++)for(let x=0;x<r.w;x++){
    if(px[(y*r.w+x)*4+3]===0)continue;
    if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
  }
  if(x1<0)return false;                      // 통째로 비었으면 복사할 게 없다
  const w=x1-x0+1,h=y1-y0+1,out=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const a=((y+y0)*r.w+(x+x0))*4,b=(y*w+x)*4;
    out[b]=px[a];out[b+1]=px[a+1];out[b+2]=px[a+2];out[b+3]=px[a+3];
  }
  clipPx={w,h,x:r.x+x0,y:r.y+y0,b64:toB64(out)};
  return true;
}
const toB64=u8=>{let s='';const CH=0x8000;
  for(let i=0;i<u8.length;i+=CH)s+=String.fromCharCode.apply(null,u8.subarray(i,i+CH));
  return btoa(s)};
const fromB64=b=>{const s=atob(b||''),u=new Uint8Array(s.length);
  for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u};
/** 복사해 둔 조각을 이 낱장에 띄운다. 원래 있던 자리 그대로 놓는다(아세프라이트와 같다). */
function pasteFloat(){
  if(!clipPx||!base)return false;
  dropFloat();
  push();
  const x=Math.max(0,Math.min(base.w-1,clipPx.x)),y=Math.max(0,Math.min(base.h-1,clipPx.y));
  redraw();                                   // 밑칠은 «조각 없이» 한 번 담아 둔다
  fltBase=ctxOf().getImageData(0,0,base.w,base.h);
  flt={w:clipPx.w,h:clipPx.h,b64:clipPx.b64,x,y,dw:clipPx.w,dh:clipPx.h,rot:0,fx:0,fy:0,angle:0,
    baseW:clipPx.w,baseH:clipPx.h,cx:x+clipPx.w/2,cy:y+clipPx.h/2,from:{t:'clip'},copy:0,snapAt:undoStack.length};
  setTool('sel');
  fltSet({});
  return true;
}
/** 고른 사각형을 화면에 점선으로 그린다. 캔버스에 그리면 손질로 구워지므로 겹쳐 둔 칸으로 그린다. */
function updateSelLab(){
  const l=document.getElementById('sellab');
  if(l)l.textContent=sel?((flt?'떠 있는 조각 ':'고른 곳 ')+sel.w+'×'+sel.h):'고른 곳 없음';
  document.querySelectorAll('#selrow button').forEach(b=>{
    b.disabled=b.dataset.needflt?!flt:!sel});
  const fr=document.getElementById('freerot');
  if(fr&&!flt){fr.value=0;if(fr.nextSibling)fr.nextSibling.textContent='0도'}
  const as=document.getElementById('adjscope');
  if(as)as.textContent='색 손보기 — '+(sel?('고른 곳 '+sel.w+'×'+sel.h+' 에만'):'낱장 통째로');
  const mk=document.querySelector('.fltmark'),cw=document.querySelector('.ed .cw');
  if(flt&&!mk&&cw){const m=el('div','fltmark');m.textContent='떠 있음 — Enter 내려놓기 · Esc 물리기';cw.appendChild(m)}
  if(!flt&&mk)mk.remove();
}
// 손잡이 여덟 개. 이름 안의 n/s/e/w 가 어느 변을 잡는지다.
const HANDLES=['nw','n','ne','e','se','s','sw','w'];
const handleAt=(r,hz)=>({
  x:r.x+(hz.indexOf('w')>=0?0:hz.indexOf('e')>=0?r.w:r.w/2),
  y:r.y+(hz.indexOf('n')>=0?0:hz.indexOf('s')>=0?r.h:r.h/2)});
/** 누른 자리가 손잡이인지 — 화면에서 7점 안이면 잡은 것으로 본다. */
function hitHandle(p){
  if(!sel||!base||tool!=='sel')return null;
  // 화면에서 6점 안이면 잡은 것으로 본다. 다만 조각이 작고 배율이 낮으면 손잡이 여덟 개가
  // 조각을 통째로 삼켜 «안쪽을 끌어 옮기기» 가 안 된다 — 가운데 3분의 1은 늘 옮기기로 둔다.
  const t=Math.min(6/base.z,Math.max(1,Math.min(sel.w,sel.h)/3));
  for(const hz of HANDLES){const c=handleAt(sel,hz);
    if(Math.abs(p.x-c.x)<=t&&Math.abs(p.y-c.y)<=t)return hz}
  return null;
}
/**
 * 네모가 아닌 «고른 곳» 의 테두리를 그린다.
 * 점선 칸(.selbox)은 네모밖에 못 그린다 — 올가미로 고른 모양은 칸이 아니라 선으로 그려야
 * 어디가 잡혔는지 보인다. 화면 배율대로 큰 칸에 그려야 선이 굵어지지 않는다.
 */
function drawSelOverlay(){
  const ov=document.getElementById('selov');
  if(!ov||!base)return;
  const z=base.z,W=base.w*z,H=base.h*z;
  if(ov.width!==W||ov.height!==H){ov.width=W;ov.height=H}
  ov.style.width=W+'px';ov.style.height=H+'px';
  const c=ov.getContext('2d');c.clearRect(0,0,W,H);
  if(symOn){                                 // 대칭 축을 보여 준다 — 어디가 접히는지 알아야 한다
    c.lineWidth=1;c.setLineDash([5,4]);c.strokeStyle='rgba(255,120,200,.85)';
    c.beginPath();c.moveTo(W/2,0);c.lineTo(W/2,H);c.stroke();c.setLineDash([]);
  }
  if(!sel||!sel.mask)return;                 // 네모는 점선 칸이 맡는다
  const at=(x,y)=>(x<0||y<0||x>=sel.w||y>=sel.h)?0:sel.mask[y*sel.w+x];
  const seg=[];
  for(let y=0;y<sel.h;y++)for(let x=0;x<sel.w;x++){
    if(!at(x,y))continue;
    const gx=(sel.x+x)*z,gy=(sel.y+y)*z;
    if(!at(x,y-1))seg.push([gx,gy,gx+z,gy]);
    if(!at(x,y+1))seg.push([gx,gy+z,gx+z,gy+z]);
    if(!at(x-1,y))seg.push([gx,gy,gx,gy+z]);
    if(!at(x+1,y))seg.push([gx+z,gy,gx+z,gy+z]);
  }
  const paint=(lw,st,dash)=>{c.lineWidth=lw;c.strokeStyle=st;c.setLineDash(dash);
    c.beginPath();for(const s of seg){c.moveTo(s[0],s[1]);c.lineTo(s[2],s[3])}c.stroke()};
  paint(3,'rgba(0,0,0,.75)',[]);             // 밝은 그림 위에서도 보이게 두 겹
  paint(1,flt?'#ffd34d':'#fff',[4,3]);
}
function drawSel(){
  drawSelOverlay();
  const box=document.querySelector('.selbox');
  if(!sel||!base){if(box)box.remove();return}
  const b=box||el('div','selbox');
  b.className='selbox'+(flt?' flt':'');
  b.style.cssText='position:absolute;pointer-events:none;z-index:6;'
    +'outline:1px dashed '+(flt?'#ffd34d':'#fff')+';box-shadow:0 0 0 1px rgba(0,0,0,.7);'
    +'left:'+(sel.x*base.z)+'px;top:'+(sel.y*base.z)+'px;'
    +'width:'+(sel.w*base.z)+'px;height:'+(sel.h*base.z)+'px';
  b.textContent='';
  HANDLES.forEach(hz=>{const c=handleAt(sel,hz),d=el('div','h');
    d.style.left=((c.x-sel.x)*base.z)+'px';d.style.top=((c.y-sel.y)*base.z)+'px';b.appendChild(d)});
  if(!box){const cv=document.getElementById('cv');if(cv)cv.parentNode.appendChild(b)}
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
  dropFloat();                                // 떠 있던 조각도 여기서 박는다 — 안 그러면 조용히 사라진다
  dropAdj();                                  // 밀어 둔 색 손보기도 같이 — 잃지 않게
  const now=edits[k]||[];
  if(JSON.stringify(now)===JSON.stringify(strokes))return null;
  push();
  if(strokes.length)edits[k]=strokes.slice();else delete edits[k];
  return {key:k,src:openEd.src,i:openEd.i,blank:!!openEd.blank,
    w:base?base.w:0,h:base?base.h:0};
}
function rgb2hsv(r,g,b){
  r/=255;g/=255;b/=255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
  let h=0;
  if(d){if(max===r)h=((g-b)/d+6)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60}
  return {h:h,s:max?d/max:0,v:max};
}
function hsv2hex(h,s,v){
  const f=n=>{const k=(n+h/60)%6;return Math.round(255*(v-v*s*Math.max(0,Math.min(k,4-k,1))))};
  return '#'+[f(5),f(3),f(1)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function paintSV(cv,h){
  const c=cv.getContext('2d'),w=cv.width,ht=cv.height,d=c.createImageData(w,ht);
  for(let y=0;y<ht;y++)for(let x=0;x<w;x++){
    const hex=hsv2hex(h,x/Math.max(1,w-1),1-y/Math.max(1,ht-1)),i=(y*w+x)*4;
    const rgb=[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)];
    d.data[i]=rgb[0];d.data[i+1]=rgb[1];d.data[i+2]=rgb[2];d.data[i+3]=255;
  }
  c.putImageData(d,0,0);
}
function editor(){
  const wrap=el('div','ed'+(edFull?' full':''));
  const h=el('h2');h.innerHTML='낱장 편집 <span class="mono">'+shortSrc(openEd.src)+'·'+openEd.i+'</span>';
  const zl=el('span');zl.className='lbl';zl.style.marginLeft='auto';zl.textContent='확대';h.appendChild(zl);
  const zBtns=[];
  const markZ=()=>zBtns.forEach(t=>t.setAttribute('aria-pressed',String(+t.dataset.z===edZoom)));
  [[0,'그림','그려진 것에 맞춤 — 빈 칸은 잘라 봅니다'],[-1,'칸','256칸 전체에 맞춥니다']].forEach(([v,n,tip])=>{
    const x=el('button');x.textContent=n;x.dataset.z=v;x.setAttribute('aria-pressed',String(edZoom===v));
    x.title=tip;
    x.onclick=()=>{edZoom=v;if(v<0)fitCanvas();else fitContent();markZ()};
    zBtns.push(x);h.appendChild(x)});
  const zm=el('button');zm.textContent='−';zm.title='축소 (휠도 됩니다)';
  zm.onclick=()=>{if(!base)return;edZoom=Math.max(1,base.z-1);setZoomKeep(edZoom);markZ()};h.appendChild(zm);
  const zl2=el('span');zl2.id='zlab';zl2.className='lbl';zl2.style.minWidth='34px';h.appendChild(zl2);
  const zp=el('button');zp.textContent='＋';zp.title='확대 (휠도 됩니다)';
  zp.onclick=()=>{if(!base)return;edZoom=Math.min(32,base.z+1);setZoomKeep(edZoom);markZ()};h.appendChild(zp);
  const q=el('button');q.textContent='❓';q.title='휠 확대 · 스페이스+끌기 화면 밀기 · B 연필 E 지우개 I 스포이드 G 페인트통 V 이동 · [ ] 붓 굵기 · Ctrl+Z 되돌리기 · Enter 내려놓기 Esc 물리기 · 도구는 올려 두면 설명이 뜹니다';
  h.appendChild(q);
  const fs=el('button');fs.textContent=edFull?'창으로':'전체화면';fs.setAttribute('aria-pressed',String(edFull));
  fs.onclick=()=>{edFull=!edFull;render()};h.appendChild(fs);
  const cls=el('button','close');cls.textContent='닫기';cls.style.marginLeft='0';
  cls.onclick=()=>{const c=commitStrokes();openEd=null;mountedKey=null;
    if(c)buildEdited(c.key,c.src,c.i,()=>render(),c.blank?{w:c.w,h:c.h}:null);else render()};h.appendChild(cls);
  wrap.appendChild(h);

  const main=el('div','edmain');
  const cw=el('div','cw');
  const inner=el('div','cwrap');
  const on=el('canvas');on.id='onion';const gr=el('canvas');gr.id='grid';const cv=el('canvas');cv.id='cv';
  const ov=el('canvas');ov.id='selov';    // 올가미로 고른 «네모 아닌» 테두리를 그리는 칸
  inner.append(on,cv,gr,ov);cw.appendChild(inner);
  if(onionOn){const mk=el('div','onionmark');mk.textContent='앞뒤 '+onionN+'장 비침 — 파랑 앞 · 빨강 뒤';cw.appendChild(mk)}

  const L=el('div','palrail');
  const chars=el('div','edchars');fillCharList(chars,true);L.appendChild(chars);
  const cols=el('div','edcols');L.appendChild(cols);
  const pw=el('div','pal');cols.appendChild(pw);
  const hsv=el('div','hsvpick');
  const sv=el('canvas');sv.id='svcan';sv.width=120;sv.height=56;sv.title='채도·밝기';
  const hues=el('input');hues.type='range';hues.id='huesl';hues.min=0;hues.max=360;hues.className='huesl';hues.title='색조';
  const fg=el('div','fgbox');fg.id='fgbox';fg.style.background=color;fg.title='지금 색 — 눌러서 고르기';
  const ci0=el('input');ci0.type='color';ci0.value=color;ci0.style.cssText='position:absolute;opacity:0;width:0;height:0';
  fg.appendChild(ci0);fg.onclick=()=>ci0.click();
  ci0.oninput=e=>setColor(e.target.value);
  hsv.append(sv,hues,fg);cols.appendChild(hsv);
  const pickSV=e=>{
    const r=sv.getBoundingClientRect();
    const s=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
    const v=Math.max(0,Math.min(1,1-(e.clientY-r.top)/r.height));
    setColor(hsv2hex(+hues.value,s,v));
  };
  sv.onpointerdown=e=>{sv.setPointerCapture(e.pointerId);pickSV(e)};
  sv.onpointermove=e=>{if(e.buttons)pickSV(e)};
  hues.oninput=()=>{
    const t=rgb2hsv.apply(null,hex2rgb(color));
    setColor(hsv2hex(+hues.value,t.s,t.v));
  };
  setTimeout(()=>{const t=rgb2hsv.apply(null,hex2rgb(color));hues.value=Math.round(t.h);paintSV(sv,+hues.value)},0);

  const T=el('div','tools');
  const tg=el('div','tgrid');
  // 도구를 바꿀 때마다 render() 를 부르면 편집기가 통째로 다시 만들어지고
  // 캔버스가 새로 붙느라 화면이 깜빡인다. 단추 상태만 갈아끼운다.
  const toolBtns=[];
  const ICO={
    pencil:'<svg viewBox="0 0 16 16"><path d="M3 13 5 9 13 1l2 2-8 8z" fill="#fc8" stroke="#111" stroke-width="1"/><path d="M3 13h2v-2" fill="#fc8" stroke="#111"/></svg>',
    eraser:'<svg viewBox="0 0 16 16"><path d="M3 8 8 3l5 5-4 4H5z" fill="#f8c" stroke="#111"/><path d="M4 12h8" stroke="#111"/></svg>',
    picker:'<svg viewBox="0 0 16 16"><path d="M10 2l4 4-7 7H3V9z" fill="#8cf" stroke="#111"/><path d="M9 3l4 4" stroke="#111"/></svg>',
    bucket:'<svg viewBox="0 0 16 16"><path d="M3 6h8l-1 7H5z" fill="#6af" stroke="#111"/><path d="M4 6l4-3 4 3" fill="none" stroke="#111"/></svg>',
    swap:'<svg viewBox="0 0 16 16"><path d="M3 5h8M9 3l3 2-3 2M13 11H5M7 9l-3 2 3 2" fill="none" stroke="#111" stroke-width="1.2"/></svg>',
    move:'<svg viewBox="0 0 16 16"><path d="M8 2v12M2 8h12M8 2l-2 2M8 2l2 2M8 14l-2-2M8 14l2-2M2 8l2-2M2 8l2 2M14 8l-2-2M14 8l-2 2" stroke="#111" fill="none"/></svg>',
    sel:'<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" fill="none" stroke="#111" stroke-dasharray="2 1.5"/></svg>',
    lasso:'<svg viewBox="0 0 16 16"><path d="M4 8c0-3 3-5 6-4s3 5 0 6c-2 1-4 0-5-2" fill="none" stroke="#111"/><circle cx="5" cy="11" r="1.4" fill="#111"/></svg>',
    ellipse:'<svg viewBox="0 0 16 16"><ellipse cx="8" cy="8" rx="5.5" ry="4.2" fill="none" stroke="#111" stroke-dasharray="2 1.5"/></svg>',
    wand:'<svg viewBox="0 0 16 16"><path d="M3 13l7-7" stroke="#111" stroke-width="1.4"/><path d="M11 2v2M10 3h2M13 5v2M12 6h2" stroke="#111"/></svg>',
    line:'<svg viewBox="0 0 16 16"><path d="M3 13 13 3" stroke="#111" stroke-width="1.4"/></svg>',
    rect:'<svg viewBox="0 0 16 16"><rect x="3" y="4" width="10" height="8" fill="none" stroke="#111"/></svg>',
    oval:'<svg viewBox="0 0 16 16"><ellipse cx="8" cy="8" rx="5.5" ry="4.2" fill="none" stroke="#111"/></svg>',
    shade:'<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="#111"/><path d="M8 3a5 5 0 0 1 0 10z" fill="#ccc"/></svg>',
    brush:'<svg viewBox="0 0 16 16"><rect x="6" y="2" width="4" height="7" fill="#ea4" stroke="#111"/><path d="M6 9h4l1 5H5z" fill="#fc8" stroke="#111"/></svg>'
  };
  [['pencil','연필 (B) — 점을 칠합니다'],
   ['eraser','지우개 (E) — 점을 지웁니다'],
   ['picker','스포이드 (I) — 찍은 색을 고릅니다'],
   ['bucket','페인트통 (G) — 이어진 같은 색을 채웁니다'],
   ['swap','색바꾸기 — 고른 색과 같은 점을 바꿉니다'],
   ['move','이동 (V) — 그림 전체를 밉니다'],
   ['sel','네모 선택 (M) — 끌어 고릅니다. 안을 끌면 들립니다'],
   ['lasso','올가미 (Q) — 자유 곡선으로 고릅니다'],
   ['ellipse','타원 선택 — 타원으로 고릅니다'],
   ['wand','마술봉 (W) — 비슷한 색 덩어리를 고릅니다'],
   ['line','직선 (L) — Shift 면 반듯하게'],
   ['rect','네모 그리기 (U) — Shift 면 정사각'],
   ['oval','타원 그리기 (O) — Shift 면 정원'],
   ['shade','명암 — 그 낱장 색들 사이를 한 눈금씩'],
   ['brush','도장붓 — 고른 무늬를 찍습니다']]
    .forEach(([id,tip])=>{const x=el('button');x.innerHTML=ICO[id];x.dataset.tool=id;x.title=tip;
      x.setAttribute('aria-pressed',String(tool===id));
      x.onclick=()=>setTool(id);
      toolBtns.push(x);tg.appendChild(x)});
  T.appendChild(tg);

  // 고른 조각을 다루는 단추들. 고른 게 없으면 흐리게 둔다.
  const selRow=el('div','cur');selRow.id='selrow';selRow.style.flexWrap='wrap';
  const sLab=el('span');sLab.className='mono';sLab.id='sellab';sLab.textContent='고른 곳 없음';
  cols.appendChild(sLab);
  const selBtn=(t,title,fn,needflt)=>{const x=el('button','ico');x.textContent=t;x.title=title;
    if(needflt)x.dataset.needflt='1';
    x.onclick=()=>{if(needflt?!flt:!sel)return;fn();drawSel();updateSelLab()};selRow.appendChild(x);return x};
  // 돌리기·뒤집기·크기는 전부 «떠 있는 채로» 한다. 안 구우니 몇 번을 눌러도 안 뭉갠다.
  // 가운데를 붙잡고 돈다. 직각은 정확한 셈으로, 비스듬한 각은 도트 결을 살려서(RotSprite).
  selBtn('⟳','시계 방향으로 90도 — 떠 있는 채로 도니 몇 번을 돌려도 안 뭉갭니다',
    ()=>fltEdit(f=>fltSetAngle((f.angle||0)+90)));
  // 돌린 뒤에도 «화면에서 보이는 대로» 뒤집혀야 한다 — 돌림에 맞춰 축을 골라 준다.
  selBtn('↔','좌우 뒤집기',()=>fltEdit(f=>{
    if(f.rot%180===0)f.fx=f.fx?0:1; else f.fy=f.fy?0:1}));
  selBtn('↕','위아래 뒤집기',()=>fltEdit(f=>{
    if(f.rot%180===0)f.fy=f.fy?0:1; else f.fx=f.fx?0:1}));
  const scaleBy=k=>fltEdit(f=>{
    const r=fltRect(),nw=Math.max(1,Math.round(r.w*k)),nh=Math.max(1,Math.round(r.h*k));
    f.x=Math.round(r.x+r.w/2-nw/2);f.y=Math.round(r.y+r.h/2-nh/2);f.dw=nw;f.dh=nh;
  });
  selBtn('＋','10% 크게 (가운데 기준) — 모서리 손잡이를 끌어도 됩니다',()=>scaleBy(1.1));
  selBtn('－','10% 작게 (가운데 기준) — 모서리 손잡이를 끌어도 됩니다',()=>scaleBy(0.9));
  selBtn('🗑','고른 곳을 비웁니다',()=>{
    if(flt){                      // 떠 있는 걸 지우면 «뜬 자리를 비운 것» 만 남는다
      const f=flt.from,copy=flt.copy;flt=null;fltBase=null;
      if(!copy)pushStrokes([eraseStroke(f)]);
      sel=null;redraw();return;
    }
    push();pushStrokes([eraseSel()]);redraw();
  });
  // 비스듬히 돌리기 — 15도씩. 도트가 부서지지 않게 8배로 키워 돌린 뒤 도로 줄인다.
  const rotRow=el('div','cur');
  const rotLab=el('span');rotLab.className='mono';rotLab.style.minWidth='62px';rotLab.textContent='비스듬히';
  const rotIn=el('input');rotIn.type='range';rotIn.id='freerot';rotIn.min=-180;rotIn.max=180;
  rotIn.step=15;rotIn.value=0;rotIn.style.width='92px';
  rotIn.title='고른 조각을 비스듬히 돌립니다 — 언제나 «원본 알갱이» 에서 다시 뜨므로 안 뭉갭니다';
  const rotVal=el('span');rotVal.className='mono';rotVal.style.minWidth='38px';rotVal.textContent='0도';
  rotIn.oninput=()=>{rotVal.textContent=rotIn.value+'도';
    fltEdit(()=>fltSetAngle(+rotIn.value))};
  rotRow.append(rotLab,rotIn,rotVal);

  selBtn('📌','떠 있는 조각을 그림에 박습니다 (Enter)',()=>{dropFloat();sel=null},true);
  selBtn('↩','붙이거나 들어 올린 것을 없던 일로 (Esc)',()=>cancelFloat(),true);
  selBtn('✕','고르기를 풉니다',()=>{dropFloat();sel=null});
  T.appendChild(selRow);
  cols.appendChild(rotRow);

  const cur=el('div','cur');const box=el('div','box');box.style.background=color;
  const ci=el('input');ci.type='color';ci.value=color;ci.oninput=e=>{color=e.target.value;box.style.background=color};
  cur.append(box,ci);const bl=el('span');bl.className='mono';bl.textContent='굵기';cur.appendChild(bl);
  const bi=el('input');bi.id='brushrange';bi.type='range';bi.min=1;bi.max=24;bi.value=brush;bi.style.width='90px';
  bi.oninput=e=>{brush=+e.target.value;bs.textContent=brush};
  const bs=el('span');bs.id='brushnum';bs.className='mono';bs.textContent=brush;
  cur.append(bi,bs);cols.appendChild(cur);

  // 도형·대칭 손잡이 — 그리기 도구를 들었을 때 손이 가는 자리다.
  const shRow=el('div','cur');shRow.style.flexWrap='wrap';
  const fillBtn=el('button','ico');fillBtn.id='fillshape';fillBtn.textContent='⬛';
  fillBtn.title='속 채우기 — 네모·타원을 속까지 칠합니다 (끄면 테두리만)';
  fillBtn.setAttribute('aria-pressed',String(fillShape));
  fillBtn.onclick=()=>{fillShape=!fillShape;fillBtn.setAttribute('aria-pressed',String(fillShape))};
  const dirBtn=el('button','ico');dirBtn.id='shadedir';
  const dirLab=()=>shadeDir<0?'🌙':'☀️';
  dirBtn.textContent=dirLab();
  dirBtn.title='명암 방향 — 어둡게/밝게. 그 낱장이 쓰던 색들 사이를 한 눈금씩';
  dirBtn.onclick=()=>{shadeDir=-shadeDir;dirBtn.textContent=dirLab()};
  shRow.appendChild(dirBtn);
  const dithBtn=el('button','ico');dithBtn.id='dither';dithBtn.textContent='░';
  dithBtn.title='무늬 — 한 점 걸러 한 점만 칠합니다 (연필·페인트통·도형)';
  dithBtn.setAttribute('aria-pressed',String(dithOn));
  dithBtn.onclick=()=>{dithOn=!dithOn;dithBtn.setAttribute('aria-pressed',String(dithOn))};
  shRow.appendChild(dithBtn);
  const symBtn=el('button','ico');symBtn.id='symmetry';symBtn.textContent='☯';
  symBtn.title='좌우 대칭 — 그은 것을 반대쪽에도 그대로';
  symBtn.setAttribute('aria-pressed',String(symOn));
  symBtn.onclick=()=>{symOn=!symOn;symBtn.setAttribute('aria-pressed',String(symOn));drawSel()};
  shRow.append(fillBtn,symBtn);T.appendChild(shRow);

  // 이어 쓴 칸이면 «고치면 다 바뀐다» 는 것을 눈에 보이게 말해 준다.
  // 공유하는 것을 모르고 고치면 남의 장까지 바뀌는데, 그건 한참 뒤에야 드러난다.
  if(openEd.blank&&openEd.lid&&linkCount(openEd.lid)>1){
    const warn=el('div','cur');warn.style.flexWrap='wrap';
    const wt=el('span','cap');wt.style.color='var(--drop)';
    wt.textContent='이 그림은 '+linkCount(openEd.lid)+'장이 함께 씁니다 — 고치면 다 바뀝니다.';
    const un=el('button');un.id='unlink';un.textContent='따로 떼기';
    un.title='이 장만 제 그림을 갖게 합니다. 지금 것을 베껴서 떼므로 보이는 건 안 바뀝니다.';
    un.onclick=unlinkCel;
    warn.append(wt,un);cols.appendChild(warn);
  }

  // 「모든 장에」 — 이펙트는 12장이 한 몸이라, 한 장만 고치는 일이 오히려 드물다.
  const allBtn=el('button','ico');allBtn.id='allframes';allBtn.textContent='📚';
  allBtn.title=allFrames?('모든 장에 한 번에 · 켬 ('+seq.length+'칸)'):'모든 장에 한 번에 — 색 손보기·내려놓기·지우기가 이어 붙인 칸 전부에 얹힙니다';
  allBtn.setAttribute('aria-pressed',String(allFrames));
  allBtn.onclick=()=>{allFrames=!allFrames;allBtn.setAttribute('aria-pressed',String(allFrames));
    allBtn.title=allFrames?('모든 장에 한 번에 · 켬 ('+seq.length+'칸)'):'모든 장에 한 번에';
    toast(allFrames?('이제 '+seq.length+'칸 모두에 얹힙니다'):'이제 이 낱장에만 얹힙니다')};
  T.appendChild(allBtn);

  // ── 색 손보기 ──────────────────────────────────────────────────────────
  // 같은 이펙트를 속성별로 갈아입히는 손. 고른 곳이 있으면 «거기만», 없으면 낱장 통째로.
  const adjBox=el('div');adjBox.id='adjbox';
  const adjHead=el('div','cur');
  const adjLab=el('span');adjLab.className='mono';adjLab.id='adjscope';adjLab.textContent='색 손보기 — 낱장 통째로';
  adjHead.appendChild(adjLab);adjBox.appendChild(adjHead);
  const adjRows=[['hue','색조 돌리기',-180,180,0,'도'],['sat','진하기',0,200,100,'%'],
    ['val','밝기',0,200,100,'%'],['con','대비',-100,100,0,'']];
  const adjVals=Object.assign({},ADJ0);
  const startAdj=()=>{
    // 미는 순간 «어디에» 얹을지 못 박는다. 미는 도중 고른 곳이 바뀌면 안 되기 때문이다.
    if(adj)return;
    const r=sel?clampRect(sel):null;
    const mk=r?cropMask(r):null;
    adj=Object.assign({t:'adj'},r?{x:r.x,y:r.y,w:r.w,h:r.h}:{x:0,y:0,w:base.w,h:base.h},
      mk?{mask:toB64(mk)}:{},adjVals);
  };
  adjRows.forEach(([k,name,mn,mx,dv,unit])=>{
    const row=el('div','cur');
    const nm=el('span');nm.className='mono';nm.style.minWidth='62px';nm.textContent=name;
    const inp=el('input');inp.type='range';inp.min=mn;inp.max=mx;inp.value=dv;inp.style.width='92px';
    inp.dataset.adj=k;
    const vv=el('span');vv.className='mono';vv.style.minWidth='40px';vv.textContent=dv+unit;
    inp.oninput=()=>{adjVals[k]=+inp.value;vv.textContent=inp.value+unit;
      startAdj();adj[k]=+inp.value;redraw()};
    row.append(nm,inp,vv);adjBox.appendChild(row);
  });
  const adjBtns=el('div','cur');
  const adjApply=el('button');adjApply.textContent='적용';adjApply.title='지금 보이는 색으로 굽습니다';
  adjApply.onclick=()=>{if(!adj)return;push();dropAdj();
    Object.assign(adjVals,ADJ0);
    document.querySelectorAll('#adjbox input[data-adj]').forEach(i=>{
      const d=({hue:0,sat:100,val:100,con:0})[i.dataset.adj];i.value=d;
      i.parentNode.lastChild.textContent=d+(i.dataset.adj==='hue'?'도':i.dataset.adj==='con'?'':'%')});
    toast('색을 손봤습니다')};
  const adjReset=el('button');adjReset.textContent='되돌리기';adjReset.title='밀던 것을 원래대로';
  adjReset.onclick=()=>{adj=null;Object.assign(adjVals,ADJ0);
    document.querySelectorAll('#adjbox input[data-adj]').forEach(i=>{
      const d=({hue:0,sat:100,val:100,con:0})[i.dataset.adj];i.value=d;
      i.parentNode.lastChild.textContent=d+(i.dataset.adj==='hue'?'도':i.dataset.adj==='con'?'':'%')});
    redraw()};
  adjBtns.append(adjApply,adjReset);adjBox.appendChild(adjBtns);
  cols.appendChild(adjBox);

  const tl=el('div','cur');tl.innerHTML='<span class="mono">비슷한 색</span>';
  const ti=el('input');ti.type='range';ti.min=0;ti.max=90;ti.value=tol;ti.style.width='70px';
  const tv=el('span');tv.className='mono';tv.textContent=tol;ti.oninput=e=>{tol=+e.target.value;tv.textContent=tol};
  tl.append(ti,tv);cols.appendChild(tl);
  const opts=el('div','cur');
  const ob=el('button','ico');ob.textContent='👻';ob.setAttribute('aria-pressed',String(onionOn));
  ob.title='어니언스킨 — 앞뒤 장을 비칩니다. 앞은 파랑, 뒤는 빨강';
  ob.onclick=()=>{onionOn=!onionOn;ob.setAttribute('aria-pressed',String(onionOn));
    const on=document.getElementById('onion');if(on)drawOnion(on);
    const mk=document.querySelector('.onionmark');
    if(onionOn&&!mk){const m=el('div','onionmark');m.textContent='앞뒤 '+onionN+'장 비침 — 파랑 앞 · 빨강 뒤';document.querySelector('.cw').appendChild(m)}
    if(!onionOn&&mk)mk.remove();
  };opts.appendChild(ob);
  const onSel=el('select');onSel.id='onionn';
  onSel.title='앞뒤로 몇 장까지 비출지';
  [1,2,3].forEach(n=>{const o=el('option');o.value=String(n);o.textContent=String(n);onSel.appendChild(o)});
  onSel.value=String(onionN);
  onSel.onchange=()=>{onionN=+onSel.value;
    const on=document.getElementById('onion');if(on)drawOnion(on);
    const mk=document.querySelector('.onionmark');
    if(mk)mk.textContent='앞뒤 '+onionN+'장 비침 — 파랑 앞 · 빨강 뒤'};
  cols.appendChild(onSel);
  const ub=el('button','ico');ub.id='eu';ub.textContent='↶';ub.title='되돌리기 (Ctrl+Z)';
  ub.onclick=()=>{
    undo();
  };
  const rb=el('button','ico');rb.textContent='↺';rb.title='이 낱장 손질을 처음으로';rb.onclick=()=>{push();strokes=[];redraw()};
  opts.append(ub,rb);T.appendChild(opts);

  const ap=el('button','primary');ap.id='eapply';ap.textContent='적용하고 닫기';
  ap.onclick=()=>{
    const k=openEd.key, src=openEd.src, i=openEd.i;
    push();
    if(strokes.length)edits[k]=strokes.slice();else delete edits[k];
    openEd=null;mountedKey=null;
    buildEdited(k,src,i,()=>render());
  };
  cols.appendChild(ap);
  main.append(L,cw,T);wrap.appendChild(main);
  wrap.appendChild(edTimeline());

  setTimeout(()=>{mount(cv,on,gr,pw);drawSel();updateSelLab();applyCursor()},0);
  return wrap;
}
function edTimeline(){
  const bar=el('div','edtl');
  const prev=el('div','edprev');prev.title='재생 미리보기';
  const im=el('img');im.id='edprev';prev.appendChild(im);bar.appendChild(prev);
  const ctr=el('div','edplay');
  const mk=(t,tip,fn)=>{const b=el('button');b.textContent=t;b.title=tip;b.onclick=fn;ctr.appendChild(b);return b};
  mk('⏮','첫 장',()=>{if(!seq.length)return;playing=false;clearTimeout(playT);playAt=0;showFrame(0)});
  mk('◀','앞 장',()=>playStep(-1));
  const pb=mk(playing?'⏸':'▶',playing?'멈춤':'재생',()=>{
    playing=!playing;pb.textContent=playing?'⏸':'▶';pb.title=playing?'멈춤':'재생';
    if(playing)play();else clearTimeout(playT)});
  pb.id='edplaybtn';
  mk('⏩','다음 장',()=>playStep(1));
  mk('⏭','마지막 장',()=>{if(!seq.length)return;playing=false;clearTimeout(playT);playAt=seq.length-1;showFrame(playAt)});
  bar.appendChild(ctr);
  const cels=el('div','edcels');
  seq.forEach((s,n)=>{
    const b=el('div','edcel'+(openEd&&openEd.key===slotOwn(s)?' on':''));
    b.title=(n+1)+'장 — 눌러서 이 장을 고칩니다';
    const img=el('img');img.src=slotURL(s);b.appendChild(img);
    const m=el('div','m');m.textContent=String(n+1);b.appendChild(m);
    b.onclick=()=>openSeq(n);
    cels.appendChild(b);
  });
  bar.appendChild(cels);
  return bar;
}
/** 도구 바꾸기 — 단추와 단축키가 같은 자리를 쓴다. render() 를 부르면 캔버스가
    새로 붙어 그리던 게 끊기므로 단추 상태만 갈아끼운다. */
function setTool(id){
  // 딴 도구를 들면 떠 있던 조각은 그 자리에 내려놓는다(아세프라이트와 같다).
  // 안 그러면 연필을 드는 순간 조각이 «아무 말 없이» 사라진다.
  if(SELTOOLS.indexOf(id)<0)dropFloat();
  tool=id;
  document.querySelectorAll('.tgrid button[data-tool]').forEach(b=>
    b.setAttribute('aria-pressed',String(b.dataset.tool===id)));
  applyCursor();
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
  const rw=sc&&sc.clientWidth?sc.clientWidth-18:(edFull?innerWidth-220:460);
  const rh=sc&&sc.clientHeight?sc.clientHeight-18:(edFull?innerHeight-140:460);
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
  drawSel();                       // 고른 테두리도 배율을 따라간다
  const lab=document.getElementById('zlab');if(lab)lab.textContent=z+'배';
  const wrap=document.querySelector('.cwrap');
  if(wrap){const s=Math.max(4,8*z);wrap.style.backgroundSize=s+'px '+s+'px';
    wrap.style.backgroundPosition='0 0,'+(s/2)+'px '+(s/2)+'px'}
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
function contentBox(){
  if(!base)return null;
  try{return boxOfData(ctxOf().getImageData(0,0,base.w,base.h).data,base.w,base.h)}
  catch(e){return {x:0,y:0,w:base.w,h:base.h}}
}
/** 256칸 전체에 맞춘다. 빈 체커가 대부분이면 캐릭터가 점으로 보인다. */
function fitCanvas(){
  setZoom(autoZoom());
  const sc=document.querySelector('.ed .cw');
  if(sc&&base){sc.scrollLeft=(base.w*base.z-sc.clientWidth)/2;sc.scrollTop=(base.h*base.z-sc.clientHeight)/2}
}
/** 그려진 것에 맞춰 키운다. 리자몽이 칸 한가운데 점만 하던 자리. */
function fitContent(){
  const box=contentBox()||{x:0,y:0,w:base.w,h:base.h};
  if(box.w<8||box.h<8){fitCanvas();return}
  const sc=document.querySelector('.ed .cw');
  const rw=sc&&sc.clientWidth?sc.clientWidth-18:(edFull?innerWidth-220:460);
  const rh=sc&&sc.clientHeight?sc.clientHeight-18:(edFull?innerHeight-140:460);
  const z=Math.max(1,Math.min(32,Math.floor(Math.min(rw/box.w,rh/box.h))));
  setZoom(z);
  if(sc){sc.scrollLeft=(box.x+box.w/2)*z-sc.clientWidth/2;sc.scrollTop=(box.y+box.h/2)*z-sc.clientHeight/2}
}
function fitZoom(){fitContent()}
function mount(cv,on,gr,pw){
  const img=new Image();
  img.onload=()=>{
    base={img,z:1,w:img.width,h:img.height};
    [cv,on,gr].forEach(c=>{c.width=img.width;c.height=img.height});
    // 같은 낱장을 다시 그리는 것뿐이면(전체화면 전환 등) 하던 붓질을 이어간다.
    // 여기서 무조건 저장본을 다시 읽으면 아직 '적용' 안 한 작업이 조용히 사라진다.
    // 칸에 제 손질이 없으면 재료 낱장 손질에서 «베껴» 시작한다 — 여기서부터 갈라진다.
    const k=openEd.key;
    if(mountedKey!==k){ strokes=(edits[k]||edits[K(openEd.src,openEd.i)]||[]).slice(); mountedKey=k; sel=null; flt=null; fltBase=null; }
    redraw();drawOnion(on);buildPal(pw);
    bindCanvas(cv);
    // 그려진 것에 맞춘다. 칸 전체에 맞추면 캐릭터가 점으로 보인다.
    if(!edZoom)fitContent();
    else if(edZoom<0)fitCanvas();
    else{
      setZoom(edZoom);
      const sc0=cv.closest('.cw');
      if(sc0){sc0.scrollLeft=(img.width*base.z-sc0.clientWidth)/2;sc0.scrollTop=(img.height*base.z-sc0.clientHeight)/2}
    }
  };
  // 편집기는 **원본**에서 시작한다. 손질한 그림을 불러오면 같은 손질이 두 번 얹힌다.
  img.src=rawURL(openEd.src,openEd.i);
}
/** 고른 색을 화면에 반영한다. render() 를 부르면 그리던 붓질이 날아간다. */
function setColor(hex){
  color=hex;
  const box=document.querySelector('.ed .cur .box');if(box)box.style.background=hex;
  const ci=document.querySelector('.ed .cur input[type=color]');if(ci)ci.value=hex;
  const fg=document.getElementById('fgbox');if(fg)fg.style.background=hex;
  const hues=document.getElementById('huesl'),sv=document.getElementById('svcan');
  if(hues&&sv){const t=rgb2hsv.apply(null,hex2rgb(hex));
    if(document.activeElement!==hues)hues.value=String(Math.round(t.h));
    paintSV(sv,+hues.value)}
  document.querySelectorAll('.ed .pal .sw').forEach(o=>{
    o.classList.toggle('on',(o.style.background||'').replace(/\s/g,'')===hexToRgbCss(hex));
  });
}
const hexToRgbCss=h=>'rgb('+[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)).join(',')+')';
function ctxOf(){return document.getElementById('cv').getContext('2d',{willReadFrequently:true})}
function redraw(){
  const c=ctxOf();
  // 조각이 떠 있는 동안은 밑칠을 처음부터 다시 하지 않는다 — 끌 때마다 손질을
  // 수십 개씩 다시 얹으면 손이 무거워진다. 담아 둔 «조각 없는 그림» 을 도로 깐다.
  if(flt&&fltBase)c.putImageData(fltBase,0,0);
  else{c.clearRect(0,0,base.w,base.h);
    // 그린 층은 «바닥이 없다». 크기만 그 칸에서 빌리고 빈 칸에서 시작한다.
    if(!openEd||!openEd.blank)c.drawImage(base.img,0,0);
    for(const s of strokes)applyOne(c,s,base.w,base.h)}
  // 미리보기와 내려놓기가 «같은 손질» 을 쓴다. 어긋날 자리가 아예 없다.
  for(const s of fltStrokes())applyOne(c,s,base.w,base.h);
  if(shapePrev)for(const s of shapePrev)applyOne(c,s,base.w,base.h);
  if(shade){const sh=shadeStroke();if(sh)applyOne(c,sh,base.w,base.h)}
  if(brushDrag){const bs=brushStroke();if(bs)applyOne(c,bs,base.w,base.h)}
  if(adj&&!adjIdle(adj))applyOne(c,adj,base.w,base.h);
}
function applyOne(c,s,W,H){
  const w=W||base.w,h=H||base.h;
  // 전부 점 단위로 센다. canvas 로 그리면 가장자리가 부드럽게 칠해져(반투명 점) 굽는 쪽과
  // 갈린다 — 실측 16384점 중 58점이 달랐다. 픽셀아트는 딱 떨어지는 쪽이 맞다.
  pixelOp(c,s,w,h);
}
/**
 * 색 손보기 한 판. 편집기와 굽는 쪽이 **글자 그대로 같은 셈** 이어야 하므로
 * 두 파일에 같은 함수를 둔다(scripts/test-strokes.mjs 가 매번 둘을 맞대 본다).
 *   hue -180~180 도 돌리기 · sat/val 0~200 % · con -100~100 대비
 * 차례: 색조·진하기·밝기 를 먼저, 대비를 마지막에. 투명한 점은 안 건드린다.
 */
function adjPixels(px,w,h,s){
  const X0=Math.max(0,Math.floor(s.x??0)),Y0=Math.max(0,Math.floor(s.y??0));
  const X1=Math.min(w,Math.ceil((s.x??0)+(s.w??w))),Y1=Math.min(h,Math.ceil((s.y??0)+(s.h??h)));
  const m=s.mask?fromB64(s.mask):null;
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
function pixelOp(c,s,W,H){
  const w=W||base.w,h=H||base.h;
  const d=c.getImageData(0,0,w,h),px=d.data;
  // 굽는 쪽(lib/fxgif.mjs applyEdits)과 **같은 셈** 이어야 한다. 점 한가운데가 반지름 안에
  // 들어오는지로만 판정한다.
  const circle=fn=>{
    const rr=s.r*s.r;
    const x0=Math.max(0,Math.floor(s.x-s.r)),y0=Math.max(0,Math.floor(s.y-s.r));
    const x1=Math.min(w,Math.ceil(s.x+s.r)),y1=Math.min(h,Math.ceil(s.y+s.r));
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const dx=x+0.5-s.x,dy=y+0.5-s.y;
      if(dx*dx+dy*dy<=rr)fn((y*w+x)*4);
    }
  };
  // 무늬(dith)가 켜져 있으면 «한 점 걸러» 만 칠한다 — 도트로 중간 톤을 내는 옛 손이다.
  const dith=(i)=>{const q=i/4,x=q%w,y=(q/w)|0;return (x+y)%2===0};
  if(s.t==='c'){circle(i=>{px[i+3]=0})}
  else if(s.t==='p'){const [r,g,b]=s.color||[255,255,255];
    circle(i=>{if(s.dith&&!dith(i))return;px[i]=r;px[i+1]=g;px[i+2]=b;px[i+3]=255})}
  else if(s.t==='r'){
    const x0=Math.max(0,Math.floor(s.x)),y0=Math.max(0,Math.floor(s.y));
    const x1=Math.min(w,Math.ceil(s.x+s.w)),y1=Math.min(h,Math.ceil(s.y+s.h));
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)px[(y*w+x)*4+3]=0;
  }
  else if(s.t==='stamps'){
    // 고른 조각을 «붓» 으로 — 한 알갱이 꾸러미를 여러 자리에 툭툭 찍는다.
    // 자리마다 손질을 따로 두면 알갱이가 그 수만큼 복사돼 저장 파일이 부푼다. 꾸러미는 하나다.
    const buf=fromB64(s.data),sw=Math.max(1,s.sw|0),sh=Math.max(1,s.sh|0);
    if(buf.length<sw*sh*4){c.putImageData(d,0,0);return}
    for(const at of (s.at||[])){
      const dx=Math.round(at[0]),dy=Math.round(at[1]);
      for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){
        const b=(y*sw+x)*4; if(buf[b+3]===0)continue;
        const gx=dx+x,gy=dy+y; if(gx<0||gy<0||gx>=w||gy>=h)continue;
        const a=(gy*w+gx)*4;
        px[a]=buf[b];px[a+1]=buf[b+1];px[a+2]=buf[b+2];px[a+3]=buf[b+3];
      }
    }
  }
  else if(s.t==='sh'){
    // 명암 — 칠하는 게 아니라 «그 칸이 원래 쓰던 색들» 사이를 한 눈금씩 오간다.
    // ramp 는 이 낱장이 쓰는 색을 어두운 것부터 밝은 것까지 줄 세운 것.
    // steps 는 점마다 몇 눈금 옮길지(붓이 지나간 횟수). dir 은 +1 밝게 / -1 어둡게.
    // 색을 새로 만들지 않으니 도트 그림의 색 수가 안 늘어난다 — 이게 픽셀아트의 명암이다.
    const st=fromB64(s.steps),ramp=s.ramp||[];
    if(!ramp.length||st.length<s.w*s.h){c.putImageData(d,0,0);return}
    const dir=s.dir<0?-1:1;
    for(let y=0;y<s.h;y++)for(let x=0;x<s.w;x++){
      const n=st[y*s.w+x]; if(!n)continue;
      const gx=s.x+x,gy=s.y+y; if(gx<0||gy<0||gx>=w||gy>=h)continue;
      const i=(gy*w+gx)*4; if(px[i+3]===0)continue;
      let best=0,bd=1e9;
      for(let k=0;k<ramp.length;k++){
        const a=px[i]-ramp[k][0],b=px[i+1]-ramp[k][1],g=px[i+2]-ramp[k][2];
        const dd=a*a+b*b+g*g; if(dd<bd){bd=dd;best=k}
      }
      const j=Math.max(0,Math.min(ramp.length-1,best+dir*n));
      px[i]=ramp[j][0];px[i+1]=ramp[j][1];px[i+2]=ramp[j][2];
    }
  }
  else if(s.t==='pm'){
    // 표대로 칠하기 — 직선·네모·타원이 전부 이 하나로 구워진다.
    // 도형마다 손질을 따로 두면 두 런타임에 같은 셈을 네 벌씩 둬야 한다. 표 하나면 된다.
    const m=fromB64(s.mask);
    if(m.length<s.w*s.h){c.putImageData(d,0,0);return}
    const [cr,cg,cb]=s.color||[255,255,255];
    for(let y=0;y<s.h;y++)for(let x=0;x<s.w;x++){
      if(!m[y*s.w+x])continue;
      const gx=s.x+x,gy=s.y+y; if(gx<0||gy<0||gx>=w||gy>=h)continue;
      const i=(gy*w+gx)*4;
      px[i]=cr;px[i+1]=cg;px[i+2]=cb;px[i+3]=255;
    }
  }
  else if(s.t==='adj'){
    // 색 손보기 — 색조 돌리기·진하기·밝기·대비.
    // 같은 이펙트를 «불 → 물 → 풀» 로 갈아입히는 손이다. 고른 곳만, 또는 낱장 통째로.
    // 굽는 쪽(lib/fxgif.mjs)과 **같은 셈** 이어야 한다 — 순서까지 같아야 한다.
    adjPixels(px,w,h,s);
  }
  else if(s.t==='em'){
    // 표대로 비우기 — 올가미·마술봉으로 고른 «네모 아닌» 자리를 지운다.
    // mask 는 한 점에 한 자, 1이면 지운다. w×h 만큼 담긴다.
    const m=fromB64(s.mask);
    if(m.length<s.w*s.h){c.putImageData(d,0,0);return}
    for(let y=0;y<s.h;y++)for(let x=0;x<s.w;x++){
      if(!m[y*s.w+x])continue;
      const gx=s.x+x,gy=s.y+y; if(gx<0||gy<0||gx>=w||gy>=h)continue;
      px[(gy*w+gx)*4+3]=0;
    }
  }
  else if(s.t==='swap'){const [fr,fg,fb]=s.from,[tr,tg,tb]=s.to,t=(s.tol??20)**2*3;
    for(let i=0;i<px.length;i+=4){if(px[i+3]<40)continue;const a=px[i]-fr,b=px[i+1]-fg,g=px[i+2]-fb;
      if(a*a+b*b+g*g<=t){px[i]=tr;px[i+1]=tg;px[i+2]=tb}}}
  else if(s.t==='fill'){
    const sx=Math.floor(s.x),sy=Math.floor(s.y);if(sx<0||sy<0||sx>=w||sy>=h){c.putImageData(d,0,0);return}
    const si=(sy*w+sx)*4,seed=[px[si],px[si+1],px[si+2],px[si+3]],[tr,tg,tb]=s.color,t=(s.tol??20)**2*3;
    const near=i=>{if(seed[3]<40)return px[i+3]<40;if(px[i+3]<40)return false;
      const a=px[i]-seed[0],b=px[i+1]-seed[1],g=px[i+2]-seed[2];return a*a+b*b+g*g<=t};
    const seen=new Uint8Array(w*h),st=[sy*w+sx];seen[sy*w+sx]=1;
    while(st.length){const p=st.pop(),i=p*4;if(!near(i))continue;
      if(!s.dith||((p%w)+((p/w)|0))%2===0){px[i]=tr;px[i+1]=tg;px[i+2]=tb;px[i+3]=255}
      const x=p%w,y=(p/w)|0;
      if(x>0&&!seen[p-1]){seen[p-1]=1;st.push(p-1)}if(x<w-1&&!seen[p+1]){seen[p+1]=1;st.push(p+1)}
      if(y>0&&!seen[p-w]){seen[p-w]=1;st.push(p-w)}if(y<h-1&&!seen[p+w]){seen[p+w]=1;st.push(p+w)}}}
  else if(s.t==='blit'||s.t==='stamp'){
    // blit  = 이 그림 «안» 의 사각형을 떠서 옮긴다(알갱이를 안 담는다).
    // stamp = 다른 낱장에서 온 조각이라 이 그림엔 원본이 없다. 알갱이(data)를 지고 다닌다.
    //         data 는 점 하나에 RGBA 넉 자를 통째로 base64 로 적은 것. sw×sh 크기다.
    // 고른 사각형을 떠서 돌리고·크기를 바꿔 다른 자리에 놓는다.
    //   sx,sy,sw,sh  떠 올 자리        dx,dy,dw,dh  놓을 자리(크기까지)
    //   rot 0/90/180/270 (시계 방향)   fx,fy 좌우·위아래 뒤집기   cut 1이면 떠 온 자리는 비운다
    // 픽셀아트라 «가장 가까운 점» 으로만 늘린다(부드럽게 섞으면 도트가 뭉갠다).
    // 투명한 점은 안 그린다 — 붙인 조각이 바탕을 지우면 안 되기 때문이다.
    const sx=Math.round(s.sx||0),sy=Math.round(s.sy||0);
    const sw=Math.max(1,Math.round(s.sw)),sh=Math.max(1,Math.round(s.sh));
    const dw=Math.max(1,Math.round(s.dw??sw)),dh=Math.max(1,Math.round(s.dh??sh));
    const dx=Math.round(s.dx),dy=Math.round(s.dy);
    const rot=((Math.round((s.rot||0)/90)*90)%360+360)%360;
    let cut;
    if(s.t==='stamp'){
      cut=fromB64(s.data);
      if(cut.length<sw*sh*4){c.putImageData(d,0,0);return}   // 담긴 알갱이가 모자라면 손대지 않는다
    }else{
      cut=new Uint8Array(sw*sh*4);
      for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){
        const gx=sx+x,gy=sy+y; if(gx<0||gy<0||gx>=w||gy>=h)continue;
        const a=(gy*w+gx)*4,b=(y*sw+x)*4;
        cut[b]=px[a];cut[b+1]=px[a+1];cut[b+2]=px[a+2];cut[b+3]=px[a+3];
      }
      if(s.cut){for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){
        const gx=sx+x,gy=sy+y; if(gx<0||gy<0||gx>=w||gy>=h)continue;
        px[(gy*w+gx)*4+3]=0}}
    }
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
/**
 * 어니언스킨 — 앞뒤 장을 비쳐 준다.
 *
 * 예전에는 «바로 앞 한 장» 만, 그것도 CSS 로 통째로 파랗게 물들여 보여줬다. 그래서
 * 앞뒤를 같이 볼 수 없었고(움직임은 앞뒤를 같이 봐야 보인다), 여러 장을 겹치면
 * 어느 게 앞이고 어느 게 뒤인지 구분이 안 됐다.
 * 이제 앞 장은 파랗게, 뒷 장은 붉게, 멀수록 옅게 그린다 — 아세프라이트와 같은 손이다.
 */
function drawOnion(on){
  const c=on.getContext('2d');c.clearRect(0,0,on.width,on.height);
  if(!openEd)return;
  if(openEd.blank){
    // 그린 층은 빈 칸이라 «어디에» 그리는지 알 수가 없다. 그 칸 그림을 옅게 깔아 준다.
    const im=new Image();
    im.onload=()=>{c.globalAlpha=.4;c.drawImage(im,0,0);c.globalAlpha=1};
    im.src=furl(openEd.src,openEd.i);
    return;
  }
  if(!onionOn)return;
  const n=meta[openEd.src]&&meta[openEd.src].fills?meta[openEd.src].fills.length:0;
  const jobs=[];
  for(let k=1;k<=onionN;k++){
    const back=openEd.i-k, fwd=openEd.i+k;
    const a=0.38/k;                                  // 멀수록 옅게
    if(back>=0)jobs.push([back,'#4d8cff',a]);        // 앞 장은 파랗게
    if(n&&fwd<n)jobs.push([fwd,'#ff6b5c',a]);        // 뒷 장은 붉게
  }
  const tmp=document.createElement('canvas');tmp.width=on.width;tmp.height=on.height;
  const tc=tmp.getContext('2d');
  jobs.forEach(([i,tint,a])=>{
    const im=new Image();
    im.onload=()=>{
      tc.clearRect(0,0,tmp.width,tmp.height);
      tc.globalCompositeOperation='source-over';tc.drawImage(im,0,0);
      tc.globalCompositeOperation='source-in';    // 그림이 있는 자리만 물들인다
      tc.fillStyle=tint;tc.fillRect(0,0,tmp.width,tmp.height);
      tc.globalCompositeOperation='source-over';
      c.globalAlpha=a;c.drawImage(tmp,0,0);c.globalAlpha=1;
    };
    im.src=furl(openEd.src,i);
  });
}
async function buildPal(pw){
  const r=await fetch('/api/palette?dir='+encodeURIComponent(cur.dir)+'&kind='+cur.kind+'&src='+openEd.src+'&i='+openEd.i);
  pal=await r.json();pw.innerHTML='';
  pal.slice(0,24).forEach(p=>{const b=el('button','sw'+(p.hex===color?' on':''));b.style.background=p.hex;b.title=p.hex+' · '+p.n+'px';
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
  const stopPan=()=>{ if(!pan)return; pan=null; applyCursor(); };
  addEventListener('pointermove',e=>{ if(!pan||!scBox)return;
    scBox.scrollLeft=pan.l-(e.clientX-pan.x); scBox.scrollTop=pan.t-(e.clientY-pan.y); });
  addEventListener('pointerup',stopPan);
  addEventListener('pointercancel',stopPan);

  // 「선택」 도구 — 사각형을 긋고, 그 안을 끌면 조각이 따라온다.
  let selDrag=null,shapeDrag=null;
  const inSel=p=>selHas(p.x,p.y);   // 올가미로 고른 «표» 까지 본다

  cv.onpointerdown=e=>{
    if((spaceDown||e.button===1)&&scBox){          // 밀기가 그리기보다 먼저다
      e.preventDefault();cv.setPointerCapture(e.pointerId);cv.style.cursor='grabbing';
      pan={x:e.clientX,y:e.clientY,l:scBox.scrollLeft,t:scBox.scrollTop};return;
    }
    if(e.button!==0)return;                        // 오른쪽·가운데 버튼으로는 안 그린다
    e.preventDefault();                            // 끌면서 옆 글자가 잡히는 것을 막는다
    cv.setPointerCapture(e.pointerId);const p=pos(e);
    if(isSelTool()){
      const add=e.shiftKey,sub=e.altKey&&!inSel(p);
      if(!add&&!sub){
        const hz=hitHandle(p);
        if(hz){                                  // 손잡이가 조각 «안쪽» 보다 먼저다
          if(!flt&&!liftSel(false))return;
          selDrag={mode:'scale',hz,ox:p.x,oy:p.y,from:fltRect()};
          painting=true;return;
        }
      }
      if(inSel(p)&&!add){
        // 처음 끄는 순간 «들어 올린다». 이때부터 본체는 안 따라온다.
        if(!flt&&!liftSel(e.altKey))return;
        selDrag={mode:'move',ox:p.x-flt.x,oy:p.y-flt.y};
        painting=true;return;
      }
      dropFloat();                               // 바깥을 누르면 떠 있던 것을 내려놓는다
      const op=add?'add':(sub?'sub':'new');
      const prev=(op==='new')?null:fullMask();
      if(tool==='wand'){                         // 마술봉은 «누르는» 도구다. 끌 게 없다.
        wandSelect(p,op,prev);painting=false;return;
      }
      selDrag={mode:'new',op,prev,ax:Math.floor(p.x),ay:Math.floor(p.y),pts:[[p.x,p.y]]};
      combineSel(shapeMask(selDrag,p),op,prev);
      painting=true;return;
    }
    if(tool==='picker'){const c=ctxOf();const d=c.getImageData(Math.floor(p.x),Math.floor(p.y),1,1).data;
      color='#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
      setColor(color);return}   // 색만 집는 것은 그림을 안 바꾸니 역사에 안 남긴다
    // 여기서부터는 그림이 바뀐다. **긋기 전에** 지금 모습을 역사에 남긴다 —
    // 끌어 그은 한 번이 점 수십 개여도 되돌리기 한 번에 통째로 돌아가야 한다.
    push();
    if(tool==='bucket'){strokes.push({t:'fill',x:rd(p.x),y:rd(p.y),color:hex2rgb(color),tol,dith:dithOn?1:0});redraw();return}
    if(tool==='swap'){const c=ctxOf();const d=c.getImageData(Math.floor(p.x),Math.floor(p.y),1,1).data;
      strokes.push({t:'swap',from:[d[0],d[1],d[2]],to:hex2rgb(color),tol});redraw();return}
    if(tool==='move'){last=p;painting=true;return}
    if(tool==='brush'){
      if(!clipPx){toast('먼저 「고른 곳」 을 Ctrl+C 로 복사하세요 — 그걸 붓으로 씁니다','err');return}
      brushDrag=null;brushDab(p);painting=true;redraw();return;
    }
    if(tool==='shade'){shade=null;shadeDab(p);painting=true;redraw();return}
    if(isShapeTool()){
      // 도형은 «손 뗄 때» 구워진다. 그 전까지는 구울 손질을 그대로 얹어 보여만 준다.
      shapeDrag={a:p};shapePrev=shapeStrokes(shapeToMask(p,p,false));
      painting=true;redraw();return;
    }
    painting=true;stroke(p);
  };
  // 굵기를 숫자로만 두면 그어 봐야 안다. 그을 자리에 동그라미를 띄운다.
  const bcur=document.createElement('div');bcur.className='brushcur';
  cv.parentNode.appendChild(bcur);
  const moveBrushCur=e=>{
    // 「선택」 은 어디를 잡느냐로 하는 일이 다르다 — 손 모양으로 미리 알려 준다.
    // 모서리 손잡이면 늘리기, 안쪽이면 옮기기, 바깥이면 새로 긋기.
    if(isSelTool()&&base&&!pan&&!spaceDown&&!selDrag){
      const q=pos(e),hz=hitHandle(q);
      cv.style.cursor=hz?HZCUR[hz]:(inSel(q)?'move':'crosshair');
    }
    if(!base||(tool!=='pencil'&&tool!=='eraser')){bcur.style.display='none';return}
    const p=pos(e),d=Math.max(2,brush*base.z);
    bcur.style.display='block';bcur.style.width=d+'px';bcur.style.height=d+'px';
    bcur.style.left=(p.x*base.z)+'px';bcur.style.top=(p.y*base.z)+'px';
  };
  cv.addEventListener('pointermove',moveBrushCur);
  cv.addEventListener('pointerleave',()=>{bcur.style.display='none'});

  cv.onpointermove=e=>{if(!painting)return;const p=pos(e);
    if(isSelTool()&&selDrag){
      if(selDrag.mode==='new'){
        // 올가미는 지나온 자리를 다 기억해 두었다가 닫아서 채운다
        if(tool==='lasso')selDrag.pts.push([p.x,p.y]);
        combineSel(shapeMask(selDrag,p),selDrag.op,selDrag.prev);
        return;
      }
      if(!flt)return;
      if(selDrag.mode==='move'){fltSet({x:Math.round(p.x-selDrag.ox),y:Math.round(p.y-selDrag.oy)});return}
      if(selDrag.mode==='scale'){fltScale(selDrag,p,e.shiftKey);return}
      return;
    }
    if(tool==='brush'){brushDab(p);redraw();return}
    if(tool==='shade'){shadeDab(p);redraw();return}
    if(isShapeTool()&&shapeDrag){shapePrev=shapeStrokes(shapeToMask(shapeDrag.a,p,e.shiftKey));redraw();return}
    if(tool==='move'){const dx=Math.round(p.x-last.x),dy=Math.round(p.y-last.y);
      if(dx||dy){strokes.push({t:'shift',dx,dy});last=p;redraw()}return}
    stroke(p)};
  cv.onpointerup=()=>{
    if(isSelTool()&&selDrag){
      // 손을 떼도 «굽지 않는다». 조각은 계속 떠 있고, 내려놓기는 Enter·딴 도구·저장 때다.
      selDrag=null;painting=false;drawSel();updateSelLab();return;
    }
    if(tool==='brush'&&brushDrag){const bs=brushStroke();brushDrag=null;painting=false;
      if(bs)pushStrokes([bs]);redraw();return}
    if(tool==='shade'&&shade){const sh=shadeStroke();shade=null;painting=false;
      if(sh)pushStrokes([sh]);redraw();return}
    if(isShapeTool()&&shapeDrag){
      const ss=shapePrev||[];shapePrev=null;shapeDrag=null;painting=false;
      if(ss.length)pushStrokes(ss);
      redraw();return;
    }
    painting=false;last=null};
  function stroke(p){
    const rd=v=>Math.round(v*10)/10;
    // 대칭이 켜져 있으면 그은 점마다 반대쪽 짝을 같이 남긴다(아세프라이트의 대칭 그리기).
    const xs=symOn?[p.x,base.w-p.x]:[p.x];
    for(const x of xs){
      if(tool==='eraser')strokes.push({t:'c',x:rd(x),y:rd(p.y),r:brush/2});
      else strokes.push({t:'p',x:rd(x),y:rd(p.y),r:brush/2,color:hex2rgb(color),dith:dithOn?1:0});
    }
    redraw();
  }
}
boot();
</script></body></html>`;
