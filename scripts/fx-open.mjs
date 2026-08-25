#!/usr/bin/env node
/**
 * scripts/fx-open.mjs — 「FX 편집기」 단추가 부르는 문지기.
 *
 * 대시보드(https)는 PC 프로그램을 직접 켤 수 없다. 그래서 윈도우에 `skoolfx://` 라는
 * 주소 형식을 등록해 두고, 단추가 그 주소를 열면 윈도우가 이 파일을 실행한다.
 * 이 파일이 하는 일은 셋뿐이다:
 *
 *   1. 편집기가 이미 켜져 있나 물어본다 (켜져 있으면 두 번 켜지 않는다 —
 *      두 번 켜면 포트가 밀려 4322 로 떠서 단추가 엉뚱한 곳을 연다)
 *   2. 안 켜져 있으면 조용히 켠다 (창 없이, 이 프로세스가 죽어도 계속 살게)
 *   3. 준비되면 브라우저로 그 항목을 연다
 *
 *   node scripts/fx-open.mjs "skoolfx://open?dir=6-charizard&kind=attack"
 *   node scripts/fx-open.mjs                     ← 첫 화면만 연다
 */
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 4321;
const BASE = 'http://localhost:' + PORT;

/** skoolfx://open?dir=..&kind=.. 에서 값만 뽑는다. 형식이 달라도 안 죽는다. */
function parseArg(raw) {
  if (!raw) return {};
  try {
    const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
    const p = new URLSearchParams(q);
    return { dir: p.get('dir') || '', kind: p.get('kind') || '' };
  } catch { return {}; }
}

const ping = async (ms = 700) => {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    const r = await fetch(BASE + '/api/ping', { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
};

const openBrowser = url => spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();

const { dir, kind } = parseArg(process.argv[2]);
const target = BASE + (dir ? `/?dir=${encodeURIComponent(dir)}&kind=${encodeURIComponent(kind || 'attack')}` : '/');

if (await ping()) {
  openBrowser(target);                       // 이미 켜져 있다 — 탭만 연다
} else {
  // 창 없이 뒤에서 돌린다. 부모(이 프로세스)가 끝나도 살아 있어야 한다.
  spawn(process.execPath, [join(__dirname, 'fx-studio.mjs'), '--port', String(PORT)],
    { detached: true, stdio: 'ignore', windowsHide: true }).unref();

  // 뜰 때까지 기다렸다가 연다. 먼저 열면 «연결할 수 없음» 이 뜬다.
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await ping(400)) break;
  }
  openBrowser(target);
}
