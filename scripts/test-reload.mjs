/**
 * 저장한 조리법을 «다시 열었을 때» 층과 그림이 그대로인가.   실행: node scripts/test-reload.mjs
 *
 * 이게 어긋나면 조용히 일이 사라진다 — 층은 살아나는데 «빈 채로» 살아나고, 그 상태로
 * 한 번만 더 저장하면 그린 것이 없어진다. 화면엔 아무 말도 안 뜬다(2026-08-26 실측).
 *
 * 파일은 하나도 안 건드린다. 「굽기 확인」이 서버로 보내는 몸통을 가로채 그것을 조리법으로
 * 되돌려주게 해서, 진짜 «다시 열기» 길을 그대로 태운다.
 */
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
let chromium = null;
for (const p of ['playwright-core', 'playwright', 'E:/Tools/node_modules/playwright-core']) {
  try { chromium = req(p).chromium; break; } catch (e) { /* 다음 자리를 본다 */ }
}
if (!chromium) { console.log('건너뜀 — playwright-core 가 없습니다.'); process.exit(0); }

const srv = spawn(process.execPath, [join(here, 'fx-studio.mjs')], { cwd: join(here, '..') });
const url = await new Promise((ok, no) => {
  let buf = '';
  const t = setTimeout(() => no(new Error('편집기가 안 떴습니다')), 20000);
  srv.stdout.on('data', d => { buf += d; const m = /http:\/\/localhost:\d+/.exec(buf); if (m) { clearTimeout(t); ok(m[0]); } });
});
const stop = () => { try { srv.kill(); } catch (e) {} };
let fail = 0;
const say = (ok, t, extra) => { console.log((ok ? 'ok    ' : 'FAIL  ') + t + (extra ? '  — ' + extra : '')); if (!ok) fail++; };

const b = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const pg = await b.newPage({ viewport: { width: 1500, height: 980 } });
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  let body = null;
  pg.on('request', r => { if (r.url().endsWith('/api/dryrun') && r.method() === 'POST') body = r.postData(); });
  await pg.goto(url, { waitUntil: 'networkidle' });
  await pg.locator('.it').first().click();
  await pg.waitForSelector('.fr,.slot');
  await pg.locator('button', { hasText: '다 담기' }).first().click();
  await pg.waitForTimeout(1200);

  const geo = () => pg.evaluate(() => { const c = document.getElementById('cv'), r = c.getBoundingClientRect();
    return { l: r.left, t: r.top, z: r.width / c.width, w: c.width, h: c.height }; });
  const drag = async (S, a, z) => { const P = (x, y) => ({ x: S.l + (x + 0.5) * S.z, y: S.t + (y + 0.5) * S.z });
    const p = P(a.x, a.y), q = P(z.x, z.y);
    await pg.mouse.move(p.x, p.y); await pg.mouse.down();
    await pg.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 3 });
    await pg.mouse.move(q.x, q.y, { steps: 3 }); await pg.mouse.up(); await pg.waitForTimeout(180); };
  const dry = async () => {
    await pg.evaluate(() => { const t = document.getElementById('drylab'); if (t) t.textContent = ''; });
    await pg.locator('#drybtn').click();
    await pg.waitForFunction(() => { const t = document.getElementById('drylab'); return t && t.textContent.length > 0; }, null, { timeout: 60000 });
    return pg.locator('#drylab').textContent();
  };

  // 층 하나를 만들고, 타임라인으로 다른 장에도 한 칸 더 만든다
  await pg.locator('.slot').nth(0).locator('.ops button', { hasText: '層' }).click();
  await pg.waitForTimeout(500);
  await pg.locator('#addblank').click();
  await pg.waitForSelector('#cv'); await pg.waitForTimeout(800);
  let S = await geo();
  await pg.locator('button[data-tool=rect]').click();
  if (await pg.locator('#fillshape[aria-pressed=false]').count()) await pg.locator('#fillshape').click();
  await drag(S, { x: 10, y: 10 }, { x: 30, y: 30 });
  await pg.locator('.ed button.close').click();
  await pg.waitForTimeout(800);
  await pg.locator('.tlrow').first().locator('.tlcel').nth(4).click();
  await pg.waitForSelector('#cv'); await pg.waitForTimeout(800);
  S = await geo();
  await drag(S, { x: 70, y: 70 }, { x: 90, y: 90 });
  await pg.locator('.ed button.close').click();
  await pg.waitForTimeout(800);

  // 이름을 붙여 둔다 — 이것도 조리법에 남아야 한다
  await pg.locator('.tlnm').first().click();
  await pg.waitForTimeout(250);
  await pg.locator('.tlnmin').fill('불티');
  await pg.locator('.tlnmin').press('Enter');
  await pg.waitForTimeout(700);

  const beforeLabel = await dry();
  const beforeRows = await pg.locator('.tlrow').count();
  const beforeCells = await pg.locator('.tlcel.on').count();
  const thumbsBefore = await pg.$$eval('.slot img', ims => ims.map(i => i.src));
  say(beforeRows === 1 && beforeCells === 2, '재기 전에 층이 두 장에 있다',
    '줄 ' + beforeRows + ' · 칸 ' + beforeCells);

  // 보낸 몸통에 층의 정체와 손질이 실렸는가 — 이게 빠지면 다시 열 때 되살릴 길이 없다
  const saved = JSON.parse(body);
  const lays = saved.seq.flatMap(s => (s.over || []).filter(L => L.src === 'blank'));
  say(lays.length === 2, '조리법에 그린 층이 둘 담긴다', lays.length + '개');
  say(lays.every(L => L.lid !== undefined), '층마다 «누구인지»(lid)가 실린다',
    lays.map(L => L.lid).join(','));
  say(lays.every(L => (L.erase || []).length > 0), '층의 손질이 실린다',
    lays.map(L => (L.erase || []).length).join(','));
  say(new Set(lays.map(L => L.lid)).size === lays.length, '층끼리 이름이 안 겹친다');

  // 그 조리법을 돌려주게 해 놓고 «다시 연다». 남의 종엔 안 물린다.
  await pg.route('**/api/recipe*', route => {
    if (!route.request().url().includes(encodeURIComponent(saved.dir))) { route.continue(); return; }
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ steps: saved.seq, fitMs: 3000 }) });
  });
  await pg.locator('.it').nth(2).click();
  await pg.waitForTimeout(1500);
  await pg.locator('.it').first().click();
  await pg.waitForTimeout(2000);

  const afterRows = await pg.locator('.tlrow').count();
  const afterCells = await pg.locator('.tlcel.on').count();
  const afterLabel = await dry();
  const thumbsAfter = await pg.$$eval('.slot img', ims => ims.map(i => i.src));
  say(afterRows === beforeRows && afterCells === beforeCells, '다시 열어도 층이 그대로 있다',
    '줄 ' + afterRows + ' · 칸 ' + afterCells);
  say(thumbsBefore.length === thumbsAfter.length && thumbsBefore.every((t, i) => t === thumbsAfter[i]),
    '칸 그림이 전과 한 자도 안 다르다');
  say(/^같음/.test(afterLabel), '다시 연 뒤에도 화면과 굽는 것이 같다', afterLabel);
  say((await pg.locator('.tlnm').first().textContent()) === '불티',
    '붙인 이름도 다시 열면 그대로다', await pg.locator('.tlnm').first().textContent());
  if (errs.length) { console.log('\n대본 오류:\n  ' + errs.join('\n  ')); fail++; }
} finally {
  await b.close(); stop();
}
console.log(fail ? ('\n어긋남 ' + fail + '건') : '\n모두 통과');
process.exit(fail ? 1 : 0);
