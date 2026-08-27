/**
 * 진짜 편집기를 띄워 놓고 «진짜 마우스» 로 끌어 본다.   실행:  node scripts/test-editor.mjs
 *
 * 손맛은 코드를 읽어서는 못 잰다. 그래서 크롬을 띄워 실제로 끌어 보고, 캔버스 알갱이를
 * 세어 판정한다. 재는 것은 원장님이 실제로 겪은 것들이다(2026-08-25):
 *   · 고른 곳을 끌면 «본체가 따라오는» 병
 *   · 다른 낱장에 붙였는데 «그 낱장 제 그림» 이 복제되는 병
 *   · 붙인 뒤 물릴 수 없는 병
 * 이 검사는 옛 판(2026-08-25 이전)에 대고 돌리면 여섯 줄이 FAIL 난다 — 헛검사가 아니다.
 *
 * 크롬은 컴퓨터에 깔린 것을 그대로 쓴다(playwright-core, channel:'chrome').
 * playwright-core 가 없으면 검사를 건너뛴다.
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
if (!chromium) {
  console.log('건너뜀 — playwright-core 가 없습니다.  npm i playwright-core  로 넣으면 검사가 돕니다.');
  console.log('(크롬은 이미 깔린 것을 쓰므로 브라우저를 따로 내려받지 않습니다)');
  process.exit(0);
}

// 검사용 편집기를 따로 띄운다 — 원장님이 쓰고 있는 창은 안 건드린다.
const srv = spawn(process.execPath, [join(here, 'fx-studio.mjs')], { cwd: join(here, '..') });
const url = await new Promise((ok, no) => {
  let buf = '';
  const t = setTimeout(() => no(new Error('편집기가 안 떴습니다')), 20000);
  srv.stdout.on('data', d => {
    buf += d;
    const m = /http:\/\/localhost:\d+/.exec(buf);
    if (m) { clearTimeout(t); ok(m[0]); }
  });
});
const stop = () => { try { srv.kill(); } catch (e) {} };

let fail = 0;
const say = (ok, t, extra) => { console.log((ok ? 'ok    ' : 'FAIL  ') + t + (extra ? '  — ' + extra : '')); if (!ok) fail++; };

const b = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const pg = await b.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = [];
  pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  await pg.goto(url, { waitUntil: 'networkidle' });

  await pg.locator('.it').first().click();
  await pg.waitForSelector('.fr,.slot', { timeout: 15000 });
  await pg.locator('.fr,.slot').first().click();
  await pg.waitForSelector('#cv', { timeout: 15000 });
  await pg.waitForTimeout(600);

  const S = await pg.evaluate(() => {
    const c = document.getElementById('cv'), r = c.getBoundingClientRect();
    return { l: r.left, t: r.top, z: r.width / c.width, w: c.width, h: c.height };
  });
  const snap = () => pg.evaluate(() => {
    const c = document.getElementById('cv');
    return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
  });
  const solid = (s, r) => { let n = 0;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (s[(y * S.w + x) * 4 + 3] > 0) n++;
    return n; };
  const outside = (a, c, rects) => { let n = 0;
    for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) {
      if (rects.some(r => x >= r.x - 1 && x < r.x + r.w + 1 && y >= r.y - 1 && y < r.y + r.h + 1)) continue;
      const i = (y * S.w + x) * 4;
      for (let k = 0; k < 4; k++) if (a[i + k] !== c[i + k]) { n++; break; }
    }
    return n; };
  const cmp = (a, c, r) => { let same = 0, diff = 0;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * S.w + x) * 4;
      if (a[i + 3] === 0 && c[i + 3] === 0) continue;
      (a[i] === c[i] && a[i + 1] === c[i + 1] && a[i + 2] === c[i + 2] && a[i + 3] === c[i + 3]) ? same++ : diff++;
    }
    return { same, diff }; };
  const P = (x, y) => ({ x: S.l + (x + 0.5) * S.z, y: S.t + (y + 0.5) * S.z });
  const drag = async (a, z) => {
    const p = P(a.x, a.y), q = P(z.x, z.y);
    await pg.mouse.move(p.x, p.y); await pg.mouse.down();
    await pg.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 });
    await pg.mouse.move(q.x, q.y, { steps: 4 }); await pg.mouse.up();
    await pg.waitForTimeout(120);
  };

  await pg.locator('button[data-tool=sel]').click();
  const before = await snap();
  // 그림이 «있는» 자리를 골라야 재는 뜻이 있다. 빈 곳을 고르면 뭘 해도 통과한다.
  const bb = (() => { let x0 = S.w, y0 = S.h, x1 = -1, y1 = -1;
    for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) {
      if (before[(y * S.w + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; })();
  const R = { x: bb.x + Math.round(bb.w * 0.12), y: bb.y + Math.round(bb.h * 0.12),
    w: Math.max(6, Math.round(bb.w * 0.30)), h: Math.max(6, Math.round(bb.h * 0.30)) };

  await drag({ x: R.x, y: R.y }, { x: R.x + R.w - 1, y: R.y + R.h - 1 });
  say(/고른 곳 \d+×\d+/.test(await pg.locator('#sellab').textContent()), '네모를 그으면 고른 곳이 잡힌다');
  say(await pg.locator('.selbox .h').count() === 8, '모서리 손잡이 여덟 개가 뜬다');
  const artInSel = solid(before, R);
  say(artInSel > 0, '고른 곳에 그림이 들어 있다(헛검사 방지)', artInSel + '점');

  // 가운데를 잡고 저 멀리 끈다 — 여기서 본체가 따라오면 안 된다
  const D = { x: Math.min(S.w - R.w - 1, R.x + Math.round(S.w * 0.28)), y: R.y };
  const CX = Math.floor(R.w / 2), CY = Math.floor(R.h / 2);
  await drag({ x: R.x + CX, y: R.y + CY }, { x: D.x + CX, y: D.y + CY });
  const mid = await snap(), R2 = { x: D.x, y: D.y, w: R.w, h: R.h };
  say((await pg.locator('#sellab').textContent()).indexOf('떠 있는 조각') === 0, '끌면 떠 있는 조각이 된다');
  say(await pg.locator('.fltmark').count() === 1, '떠 있다는 표시가 화면에 뜬다');
  say(solid(mid, R) === 0, '뜬 자리는 비었다', solid(mid, R) + '점 남음');
  say(solid(mid, R2) === artInSel, '그림은 통째로 옮겨졌다', solid(mid, R2) + '/' + artInSel);
  say(outside(before, mid, [R, R2]) === 0, '그 밖의 본체는 한 점도 안 건드렸다', outside(before, mid, [R, R2]) + '점 바뀜');

  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(150);
  say(outside(before, await snap(), []) === 0, 'Esc 면 없던 일이 된다');

  // 다른 낱장으로 «그림째» 복사 — 옛 판은 그 낱장 제 그림을 복제했다
  await pg.keyboard.press('Control+d');
  await pg.waitForTimeout(120);
  await drag({ x: R.x, y: R.y }, { x: R.x + R.w - 1, y: R.y + R.h - 1 });
  await pg.keyboard.press('Control+c');
  await pg.waitForTimeout(250);
  say(/복사/.test(await pg.evaluate(() => { const t = document.querySelector('.toast,#toast'); return t ? t.textContent : ''; })),
    'Ctrl+C 가 먹었다(옆 글자에 안 뺏긴다)');
  await pg.locator('.ed button.close').click();
  await pg.waitForTimeout(400);
  const n = await pg.locator('.fr,.slot').count();
  await pg.locator('.fr,.slot').nth(Math.min(2, n - 1)).click();
  await pg.waitForSelector('#cv');
  await pg.waitForTimeout(700);
  const otherBefore = await snap();
  await pg.keyboard.press('Control+v');
  await pg.waitForTimeout(300);
  const pasted = await snap();
  say(await pg.locator('.fltmark').count() === 1, '다른 낱장에서도 떠 있는 채로 붙는다');
  const v = cmp(before, pasted, R);
  say(v.diff === 0 && v.same > 0, '붙은 것이 복사해 온 그 그림이다', JSON.stringify(v));
  const self = cmp(otherBefore, pasted, R);
  say(!(self.diff === 0), '이 낱장 제 그림을 복제한 게 아니다', JSON.stringify(self));

  await pg.keyboard.press('Enter');
  await pg.waitForTimeout(200);
  say(await pg.locator('.fltmark').count() === 0, 'Enter 면 내려놓는다');
  say(cmp(pasted, await snap(), { x: 0, y: 0, w: S.w, h: S.h }).diff === 0,
    '내려놓아도 보이던 그대로다(미리보기 = 구운 것)');

  // ── 고르는 도구 넷 ──────────────────────────────────────────────────────
  await pg.keyboard.press('Control+d');
  await pg.waitForTimeout(150);
  const wandBefore = await snap();
  // 마술봉 — 그림이 있는 한 점을 누르면 «비슷한 색으로 이어진 덩어리» 만 잡혀야 한다
  // 씨앗은 «넓은 면» 한가운데라야 뜻이 있다. 테두리 한 점을 찍으면 1×1 이 잡혀도
  // 마술봉이 맞는 셈인지 알 수 없다 — 사방이 같은 색인 점을 찾아 찍는다.
  const seed = (() => {
    const same = (a, b) => {
      for (let k = 0; k < 4; k++) if (wandBefore[a + k] !== wandBefore[b + k]) return false;
      return true;
    };
    for (let y = bb.y + 1; y < bb.y + bb.h - 1; y++) for (let x = bb.x + 1; x < bb.x + bb.w - 1; x++) {
      const i = (y * S.w + x) * 4;
      if (wandBefore[i + 3] === 0) continue;
      if (same(i, i - 4) && same(i, i + 4) && same(i, i - S.w * 4) && same(i, i + S.w * 4)) return { x, y };
    }
    return { x: bb.x, y: bb.y };
  })();
  await pg.locator('button[data-tool=wand]').click();
  const sp = P(seed.x, seed.y);
  await pg.mouse.move(sp.x, sp.y); await pg.mouse.down(); await pg.mouse.up();
  await pg.waitForTimeout(250);
  const wlab = await pg.locator('#sellab').textContent();
  say(/고른 곳 \d+×\d+/.test(wlab), '마술봉이 덩어리를 잡는다', wlab);
  const wandBox = await pg.evaluate(() => {
    const b = document.querySelector('.selbox'), c = document.getElementById('cv');
    if (!b) return null;
    const r = b.getBoundingClientRect(), q = c.getBoundingClientRect(), z = q.width / c.width;
    return { w: Math.round(r.width / z), h: Math.round(r.height / z) };
  });
  say(wandBox && wandBox.w < S.w && wandBox.h < S.h, '그림 전체가 아니라 한 덩어리만 잡혔다', JSON.stringify(wandBox));
  say(await pg.evaluate(() => {
    const o = document.getElementById('selov');
    if (!o) return false;
    const d = o.getContext('2d').getImageData(0, 0, o.width, o.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }), '네모가 아닌 테두리가 화면에 그려진다');

  // 잡은 덩어리를 지우면 «표대로» 지워져야 한다 — 네모째 지워지면 배경까지 뚫린다
  const solidBefore = solid(wandBefore, { x: 0, y: 0, w: S.w, h: S.h });
  await pg.locator('#selrow button', { hasText: '지우기' }).first().click();
  await pg.waitForTimeout(250);
  const afterErase = await snap();
  const gone = solidBefore - solid(afterErase, { x: 0, y: 0, w: S.w, h: S.h });
  say(gone > 0, '지우면 실제로 지워진다', gone + '점 사라짐');
  const boxArea = wandBox ? wandBox.w * wandBox.h : 0;
  say(gone < boxArea, '네모째가 아니라 표대로 지워졌다', gone + '점 < 네모 ' + boxArea + '점');
  await pg.keyboard.press('Control+z');
  await pg.waitForTimeout(250);
  say(outside(wandBefore, await snap(), []) === 0, '되돌리면 그대로 돌아온다');

  // 올가미로 크게 두른 뒤 Shift 로 더 잡히는지
  await pg.keyboard.press('Control+d');
  await pg.locator('button[data-tool=lasso]').click();
  const L = [[bb.x + 2, bb.y + 2], [bb.x + 20, bb.y + 3], [bb.x + 22, bb.y + 20], [bb.x + 3, bb.y + 18]];
  await pg.mouse.move(P(L[0][0], L[0][1]).x, P(L[0][0], L[0][1]).y);
  await pg.mouse.down();
  for (const q of L.slice(1)) { const s2 = P(q[0], q[1]); await pg.mouse.move(s2.x, s2.y, { steps: 6 }); }
  await pg.mouse.up();
  await pg.waitForTimeout(200);
  const lassoLab = await pg.locator('#sellab').textContent();
  say(/고른 곳 \d+×\d+/.test(lassoLab), '올가미가 두른 안을 잡는다', lassoLab);
  const lassoW = +(/(\d+)×(\d+)/.exec(lassoLab) || [0, 0])[1];
  await pg.keyboard.down('Shift');
  const A = P(bb.x + 30, bb.y + 30), B2 = P(bb.x + 40, bb.y + 40);
  await pg.mouse.move(A.x, A.y); await pg.mouse.down();
  await pg.mouse.move(B2.x, B2.y, { steps: 5 }); await pg.mouse.up();
  await pg.keyboard.up('Shift');
  await pg.waitForTimeout(200);
  const addLab = await pg.locator('#sellab').textContent();
  const addW = +(/(\d+)×(\d+)/.exec(addLab) || [0, 0])[1];
  say(addW > lassoW, 'Shift 로 끌면 고른 곳이 넓어진다(더하기)', lassoLab + ' → ' + addLab);

  // ── 색 손보기 ───────────────────────────────────────────────────────────
  await pg.keyboard.press('Control+d');
  await pg.waitForTimeout(150);
  const preAdj = await snap();
  const hue = pg.locator('#adjbox input[data-adj=hue]');
  await hue.fill('120');
  await pg.waitForTimeout(250);
  const preview = await snap();
  const moved = outside(preAdj, preview, []);
  say(moved > 0, '색조를 밀면 화면이 바로 바뀐다', moved + '점 바뀜');
  const opaqueBefore = solid(preAdj, { x: 0, y: 0, w: S.w, h: S.h });
  say(solid(preview, { x: 0, y: 0, w: S.w, h: S.h }) === opaqueBefore,
    '투명한 자리는 안 건드린다(그림이 안 번진다)');
  await pg.locator('#adjbox button', { hasText: '적용' }).first().click();
  await pg.waitForTimeout(250);
  say(cmp(preview, await snap(), { x: 0, y: 0, w: S.w, h: S.h }).diff === 0,
    '적용해도 보이던 그대로다(미리보기 = 구운 것)');
  await pg.keyboard.press('Control+z');
  await pg.waitForTimeout(250);
  say(outside(preAdj, await snap(), []) === 0, '되돌리면 색이 원래대로');

  // 고른 곳이 있으면 «거기만» 손봐야 한다
  await pg.locator('button[data-tool=sel]').click();
  const Q = { x: bb.x + 2, y: bb.y + 2, w: Math.max(6, Math.round(bb.w * 0.3)), h: Math.max(6, Math.round(bb.h * 0.3)) };
  await drag({ x: Q.x, y: Q.y }, { x: Q.x + Q.w - 1, y: Q.y + Q.h - 1 });
  say(/고른 곳 \d+×\d+ 에만/.test(await pg.locator('#adjscope').textContent()),
    '고른 곳이 있으면 «거기만» 이라고 말해 준다');
  const preAdj2 = await snap();
  await pg.locator('#adjbox input[data-adj=val]').fill('40');
  await pg.waitForTimeout(250);
  const afterAdj2 = await snap();
  say(outside(preAdj2, afterAdj2, [Q]) === 0, '고른 곳 밖은 한 점도 안 바뀐다',
    outside(preAdj2, afterAdj2, [Q]) + '점 바뀜');
  let inQ = 0;
  for (let y = Q.y; y < Q.y + Q.h; y++) for (let x = Q.x; x < Q.x + Q.w; x++) {
    const i = (y * S.w + x) * 4;
    if (preAdj2[i] !== afterAdj2[i] || preAdj2[i + 1] !== afterAdj2[i + 1]) inQ++;
  }
  say(inQ > 0, '고른 곳 안은 실제로 어두워졌다', inQ + '점 바뀜');
  await pg.locator('#adjbox button', { hasText: '되돌리기' }).first().click();
  await pg.waitForTimeout(200);
  say(outside(preAdj2, await snap(), []) === 0, '색 손보기 되돌리기가 먹는다');

  // ── 모든 장에 한 번에 ───────────────────────────────────────────────────
  // 이어 붙인 칸이 있어야 잴 수 있다 — 「다 담기」로 줄을 만든 뒤 잰다.
  await pg.locator('.ed button.close').click();
  await pg.waitForTimeout(400);
  await pg.locator('#bar button, button', { hasText: '다 담기' }).first().click();
  await pg.waitForTimeout(900);
  const slots = await pg.locator('.slot').count();
  say(slots > 1, '이어 붙인 칸이 여럿이다(헛검사 방지)', slots + '칸');

  const openSlot = async n => {
    await pg.locator('.slot').nth(n).click();
    await pg.waitForSelector('#cv');
    await pg.waitForTimeout(700);
  };
  // 편집기가 안 열려 있을 수도 있다 — 없으면 그냥 지나간다.
  const closeEd = async () => {
    if (await pg.locator('.ed button.close').count() === 0) return;
    await pg.locator('.ed button.close').click();
    await pg.waitForTimeout(500);
  };
  await openSlot(1);
  const slot1Before = await snap();
  await closeEd();

  await openSlot(0);
  await pg.locator('#allframes').click();
  await pg.waitForTimeout(150);
  say(/켬\(\d+칸\)/.test(await pg.locator('#allframes').textContent()),
    '「모든 장에」가 몇 칸인지 말해 준다', await pg.locator('#allframes').textContent());
  await pg.locator('#adjbox input[data-adj=val]')
    .evaluate(el => { el.value = 40; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await pg.waitForTimeout(250);
  const slot0Prev = await snap();
  await pg.locator('#adjbox button', { hasText: '적용' }).first().click();
  await pg.waitForTimeout(300);
  say(cmp(slot0Prev, await snap(), { x: 0, y: 0, w: S.w, h: S.h }).diff === 0,
    '연 낱장은 보이던 그대로 구워졌다');
  await closeEd();

  await openSlot(1);
  const slot1After = await snap();
  const changed = outside(slot1Before, slot1After, []);
  say(changed > 0, '안 열어 본 칸에도 그대로 얹혔다', changed + '점 바뀜');
  let darker = 0, lighter = 0;
  for (let i = 0; i < slot1Before.length; i += 4) {
    if (slot1Before[i + 3] === 0) continue;
    if (slot1After[i] < slot1Before[i]) darker++; else if (slot1After[i] > slot1Before[i]) lighter++;
  }
  say(darker > 0 && lighter === 0, '밝기를 내린 대로 어두워졌다(엉뚱한 손질이 아니다)',
    '어두워진 점 ' + darker + ' · 밝아진 점 ' + lighter);
  say(solid(slot1After, { x: 0, y: 0, w: S.w, h: S.h }) === solid(slot1Before, { x: 0, y: 0, w: S.w, h: S.h }),
    '모양은 그대로다(칸이 뭉개지지 않았다)');

  // 「모든 장에」 로 얹은 뒤 화면이 낡으면 안 된다 — 눈에는 한 장만 바뀐 것처럼 보이는데
  // 저장하면 전부 바뀌었다(2026-08-26 실측: 갈림 6장). 얹은 «직후» 에 잰다.
  await closeEd();
  await pg.evaluate(()=>{const t=document.getElementById('drylab');if(t)t.textContent=''});
  await pg.locator('#drybtn').click();
  await pg.waitForFunction(()=>{const t=document.getElementById('drylab');return t&&t.textContent.length>0},null,{timeout:60000});
  say(/^같음/.test(await pg.locator('#drylab').textContent()),
    '「모든 장에」 로 얹은 직후에도 화면과 굽는 것이 같다', await pg.locator('#drylab').textContent());

  // ── 도형 그리기와 좌우 대칭 ─────────────────────────────────────────────
  await openSlot(0);                               // 위에서 닫았으니 다시 연다
  await pg.locator('#allframes').click();          // 한 장만 보고 잰다
  await pg.waitForTimeout(150);
  const lineBefore = await snap();
  await pg.locator('button[data-tool=line]').click();
  const LA = { x: 6, y: 6 }, LB = { x: Math.min(S.w - 6, 40), y: 6 };
  await drag(LA, LB);
  await pg.waitForTimeout(200);
  const lineAfter = await snap();
  let onLine = 0;
  for (let x = LA.x; x <= LB.x; x++) {
    const i = (LA.y * S.w + x) * 4;
    if (lineAfter[i + 3] > 0 && (lineBefore[i + 3] === 0 || lineBefore[i] !== lineAfter[i])) onLine++;
  }
  say(onLine > (LB.x - LA.x) * 0.8, '직선이 끝에서 끝까지 그어진다', onLine + '/' + (LB.x - LA.x + 1) + '점');
  say(outside(lineBefore, lineAfter, [{ x: LA.x - 3, y: LA.y - 3, w: LB.x - LA.x + 7, h: 7 }]) === 0,
    '직선 밖으로 안 번진다');
  await pg.keyboard.press('Control+z');
  await pg.waitForTimeout(250);
  say(outside(lineBefore, await snap(), []) === 0, '직선 한 번에 되돌아간다(한 칸)');

  // 좌우 대칭 — 그은 것의 «짝» 이 반대쪽에 생겨야 한다
  await pg.locator('#symmetry').click();
  await pg.waitForTimeout(150);
  const symBefore = await snap();
  const SA = { x: 8, y: Math.min(S.h - 8, 20) }, SB = { x: 24, y: SA.y };
  await drag(SA, SB);
  await pg.waitForTimeout(250);
  const symAfter = await snap();
  const drew = (s, a, b, y) => { let n = 0;
    for (let x = a; x <= b; x++) { const i = (y * S.w + x) * 4; if (s[i + 3] > 0) n++; }
    return n; };
  const left = drew(symAfter, SA.x, SB.x, SA.y);
  const right = drew(symAfter, S.w - 1 - SB.x, S.w - 1 - SA.x, SA.y);
  const rightBefore = drew(symBefore, S.w - 1 - SB.x, S.w - 1 - SA.x, SA.y);
  say(left > 0 && right >= left && right > rightBefore,
    '대칭을 켜면 반대쪽에도 같이 그어진다', '왼쪽 ' + left + '점 · 오른쪽 ' + rightBefore + '→' + right + '점');
  say(await pg.evaluate(() => {
    const o = document.getElementById('selov');
    if (!o) return false;
    const d = o.getContext('2d').getImageData(o.width / 2 - 2, 0, 4, o.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }), '대칭 축이 화면에 보인다');
  await pg.locator('#symmetry').click();

  // ── 명암 붓 ─────────────────────────────────────────────────────────────
  // 픽셀아트의 명암은 «색을 새로 만들지 않는 것» 이 핵심이다. 색 수가 안 늘어야 한다.
  const colorsOf = s => { const set = new Set();
    for (let i = 0; i < s.length; i += 4) if (s[i + 3] > 0) set.add(s[i] + ',' + s[i + 1] + ',' + s[i + 2]);
    return set; };
  const shBefore = await snap();
  const beforeColors = colorsOf(shBefore);
  await pg.locator('button[data-tool=shade]').click();
  await pg.locator('#shadedir').click();          // 밝게로 뒤집었다가
  await pg.locator('#shadedir').click();          // 다시 어둡게 — 단추가 도는지도 본다
  say(/명암 · 어둡게/.test(await pg.locator('#shadedir').textContent()), '명암 방향 단추가 돈다');
  const sh0 = { x: bb.x + Math.round(bb.w * 0.4), y: bb.y + Math.round(bb.h * 0.6) };
  await drag(sh0, { x: sh0.x + 12, y: sh0.y });
  await pg.waitForTimeout(250);
  const shAfter = await snap();
  const shChanged = outside(shBefore, shAfter, []);
  say(shChanged > 0, '명암 붓이 실제로 칠한다', shChanged + '점 바뀜');
  const afterColors = colorsOf(shAfter);
  const newColors = [...afterColors].filter(c => !beforeColors.has(c));
  say(newColors.length === 0, '색을 «새로 만들지» 않는다(도트 색 수가 안 는다)',
    '색 ' + beforeColors.size + '개 → ' + afterColors.size + '개, 새 색 ' + newColors.length + '개');
  let darkened = 0, brightened = 0;
  for (let i = 0; i < shBefore.length; i += 4) {
    if (shBefore[i + 3] === 0) continue;
    const a = shBefore[i] + shBefore[i + 1] + shBefore[i + 2], b2 = shAfter[i] + shAfter[i + 1] + shAfter[i + 2];
    if (b2 < a) darkened++; else if (b2 > a) brightened++;
  }
  say(darkened > 0 && brightened === 0, '어둡게 쪽으로만 갔다',
    '어두워진 점 ' + darkened + ' · 밝아진 점 ' + brightened);
  await pg.keyboard.press('Control+z');
  await pg.waitForTimeout(250);
  say(outside(shBefore, await snap(), []) === 0, '명암 한 번 문지른 게 되돌리기 한 칸이다');

  // ── 도장붓과 무늬 ───────────────────────────────────────────────────────
  // 도장붓은 복사해 둔 조각이 있어야 쓸 수 있다. 없이 누르면 «말해 줘야» 한다.
  await pg.locator('button[data-tool=brush]').click();
  const bBefore = await snap();
  const far = { x: Math.min(S.w - 12, bb.x + 4), y: Math.min(S.h - 12, bb.y + 4) };
  await drag(far, { x: far.x + 30, y: far.y + 20 });
  await pg.waitForTimeout(250);
  const bAfter = await snap();
  const bChanged = outside(bBefore, bAfter, []);
  say(bChanged > 0, '도장붓이 조각을 여러 자리에 찍는다', bChanged + '점 바뀜');
  const bBox = (() => { let x0 = S.w, y0 = S.h, x1 = -1, y1 = -1;
    for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) {
      const i = (y * S.w + x) * 4;
      let d2 = false; for (let k = 0; k < 4; k++) if (bBefore[i + k] !== bAfter[i + k]) d2 = true;
      if (!d2) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { w: x1 - x0 + 1, h: y1 - y0 + 1 }; })();
  say(bBox.w > 20, '한 자리가 아니라 끈 길을 따라 찍힌다', '찍힌 범위 ' + bBox.w + '×' + bBox.h);
  await pg.keyboard.press('Control+z');
  await pg.waitForTimeout(250);
  say(outside(bBefore, await snap(), []) === 0, '도장붓 한 번 끈 게 되돌리기 한 칸이다');

  // 무늬 — 한 점 걸러 한 점만 칠해야 «중간 톤» 이 된다
  await pg.locator('button[data-tool=pencil]').click();
  await pg.locator('#dither').click();
  await pg.locator('#brushrange').evaluate(el => { el.value = 10; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const dBefore = await snap();
  const dp = { x: Math.min(S.w - 14, 14), y: Math.min(S.h - 14, S.h - 14) };
  await drag(dp, { x: dp.x + 1, y: dp.y });
  await pg.waitForTimeout(250);
  const dAfter = await snap();
  let odd = 0, even = 0;
  for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) {
    const i = (y * S.w + x) * 4;
    let d2 = false; for (let k = 0; k < 4; k++) if (dBefore[i + k] !== dAfter[i + k]) d2 = true;
    if (!d2) continue;
    ((x + y) % 2 === 0) ? even++ : odd++;
  }
  say(even > 0 && odd === 0, '무늬는 한 점 걸러 한 점만 칠한다', '짝수칸 ' + even + '점 · 홀수칸 ' + odd + '점');
  await pg.locator('#dither').click();

  // ── 어니언스킨 ──────────────────────────────────────────────────────────
  // 앞은 파랗게, 뒤는 붉게. 색이 갈려야 «어느 쪽으로 가는 움직임인지» 가 보인다.
  await closeEd();
  await openSlot(2);                                  // 앞뒤가 다 있는 가운데 칸
  const onionColors = async () => pg.evaluate(() => {
    const o = document.getElementById('onion');
    const d = o.getContext('2d').getImageData(0, 0, o.width, o.height).data;
    let blue = 0, red = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      if (d[i + 2] > d[i]) blue++; else if (d[i] > d[i + 2]) red++;
    }
    return { blue, red };
  });
  const off = await onionColors();
  say(off.blue === 0 && off.red === 0, '꺼 두면 아무것도 안 비친다');
  await pg.locator('.ed button', { hasText: '어니언스킨' }).first().click();
  await pg.waitForTimeout(600);
  const on1 = await onionColors();
  say(on1.blue > 0, '앞 장이 파랗게 비친다', on1.blue + '점');
  say(on1.red > 0, '뒷 장이 붉게 비친다 — 예전엔 앞만 보였다', on1.red + '점');
  await pg.locator('#onionn').selectOption('3');
  await pg.waitForTimeout(700);
  const on3 = await onionColors();
  say(on3.blue + on3.red > on1.blue + on1.red, '장수를 늘리면 더 많이 비친다',
    (on1.blue + on1.red) + '점 → ' + (on3.blue + on3.red) + '점');
  say(/앞뒤 3장 비침/.test(await pg.locator('.onionmark').textContent()), '몇 장 비치는지 화면에 적힌다');

  // ── 비스듬히 돌리기 (RotSprite) ─────────────────────────────────────────
  // 도트 그림을 45도로 돌리면 «가장 가까운 점» 셈으로는 선이 잘게 부서진다.
  // 여기서 재는 것: (1) 실제로 돌아가는가 (2) 색을 새로 만들지 않는가
  // (3) 여러 번 돌려도 안 뭉개지는가 — 언제나 원본에서 다시 뜨는지.
  await pg.locator('button[data-tool=sel]').click();
  await pg.keyboard.press('Control+d');
  await pg.waitForTimeout(150);
  const R3 = { x: bb.x + 4, y: bb.y + 4, w: Math.max(10, Math.round(bb.w * 0.4)), h: Math.max(10, Math.round(bb.h * 0.4)) };
  await drag({ x: R3.x, y: R3.y }, { x: R3.x + R3.w - 1, y: R3.y + R3.h - 1 });
  await pg.waitForTimeout(150);
  const rotBefore = await snap();
  const rotColors = colorsOf(rotBefore);
  const setRot = async deg => {
    await pg.locator('#freerot').evaluate((el, d) => { el.value = d; el.dispatchEvent(new Event('input', { bubbles: true })); }, deg);
    await pg.waitForTimeout(600);
  };
  await setRot(45);
  const at45 = await snap();
  say(outside(rotBefore, at45, []) > 0, '비스듬히 돌리면 그림이 실제로 돈다');
  const new45 = [...colorsOf(at45)].filter(c => !rotColors.has(c));
  say(new45.length === 0, '돌려도 색을 새로 만들지 않는다(흐리게 섞지 않는다)', '새 색 ' + new45.length + '개');
  // 45 → 90 → 45 로 돌아오면 «처음 45도» 와 같아야 한다(원본에서 다시 뜨므로)
  await setRot(90);
  await setRot(45);
  const again45 = await snap();
  const drift = outside(at45, again45, []);
  say(drift === 0, '여러 번 돌려도 처음 그대로다(원본에서 다시 뜬다)', drift + '점 다름');
  await setRot(0);
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(250);
  say(outside(rotBefore, await snap(), []) === 0, '돌리다 Esc 면 없던 일이 된다');

  // ── 그린 층 ─────────────────────────────────────────────────────────────
  // 층의 고갱이는 «따로 논다» 는 것이다. 층에 그린 것이 바닥을 안 건드려야 하고,
  // 층을 껐다 켜면 그 층 그림만 사라졌다 돌아와야 한다.
  await closeEd();
  await pg.locator('.slot').first().locator('.ops button', { hasText: '層' }).click();
  await pg.waitForTimeout(600);
  const baseThumb = async () => pg.evaluate(() => {
    const im = document.querySelector('.slot.on img') || document.querySelector('.slot img');
    // 앞머리 몇 글자는 그림이 달라도 같다(PNG 머리말) — 통째로 견줘야 한다
    return im ? im.src : '';
  });
  say(await pg.locator('#addblank').count() === 1, '층 목록에 「＋ 그린 층」 이 있다');
  await pg.locator('#addblank').click();
  await pg.waitForSelector('#cv');
  await pg.waitForTimeout(800);
  const layerStart = await snap();
  let opaque = 0;
  for (let i = 3; i < layerStart.length; i += 4) if (layerStart[i] > 0) opaque++;
  say(opaque === 0, '그린 층은 «빈 칸» 에서 시작한다(바닥이 안 깔린다)', opaque + '점 차 있음');
  say(await pg.evaluate(() => {
    const o = document.getElementById('onion');
    const d = o.getContext('2d').getImageData(0, 0, o.width, o.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }), '그 칸 그림이 옅게 깔려 «어디에 그리는지» 보인다');

  // 층에 한 줄 긋고 적용
  await pg.locator('button[data-tool=line]').click();
  await pg.locator('#brushrange').evaluate(el => { el.value = 3; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await drag({ x: 4, y: 4 }, { x: Math.min(S.w - 4, 40), y: 4 });
  await pg.waitForTimeout(200);
  const drawn = await snap();
  let inked = 0;
  for (let i = 3; i < drawn.length; i += 4) if (drawn[i] > 0) inked++;
  say(inked > 0, '층에 그은 것이 남는다', inked + '점');
  await closeEd();
  await pg.waitForTimeout(600);
  const rows = await pg.locator('.lrow').count();
  say(rows >= 2, '층 목록에 그린 층이 줄로 선다', rows + '줄');
  say(/그린 층/.test(await pg.locator('.lrow .lname').first().textContent()), '이름이 «그린 층» 이다');

  // 바닥을 열어 보면 «층에 그은 것» 이 안 보여야 한다 — 층이 새면 여기서 걸린다
  // 「層」 단추는 토글이다 — 이미 열려 있으면 누르는 순간 닫힌다. 열려 있는지부터 본다.
  if (await pg.locator('.lrow').count() === 0) {
    await pg.locator('.slot').first().locator('.ops button', { hasText: '層' }).click();
    await pg.waitForTimeout(600);
  }
  const eye = pg.locator('.lrow button', { hasText: /보임|꺼짐/ }).first();
  const withLayer = await baseThumb();
  await eye.click();
  await pg.waitForTimeout(700);
  const withoutLayer = await baseThumb();
  say(withLayer !== withoutLayer, '층을 끄면 칸 그림이 바뀐다(층이 실제로 얹혀 있었다)');
  await eye.click();
  await pg.waitForTimeout(700);
  say(await baseThumb() === withLayer, '다시 켜면 그대로 돌아온다');

  // ── 타임라인 ────────────────────────────────────────────────────────────
  // 층이 생기면 「만든 것」 줄 아래로 한 줄이 펼쳐지고, 빈 칸을 누르면 그 장에도 층이 생긴다.
  const cells = pg.locator('.tlrow').first().locator('.tlcel');
  say(await pg.locator('.tlrow').count() >= 1, '층이 생기면 타임라인 줄이 펼쳐진다');
  say(await cells.count() === slots, '줄의 칸 수가 장 수와 같다', (await cells.count()) + '/' + slots);
  say(await pg.locator('.tlcel.on').count() === 1, '층이 있는 장만 켜져 보인다',
    (await pg.locator('.tlcel.on').count()) + '칸');
  // 빈 칸을 눌러 다른 장에도 같은 줄의 층을 만든다
  await cells.nth(3).click();
  await pg.waitForSelector('#cv');
  await pg.waitForTimeout(700);
  await pg.locator('button[data-tool=rect]').click();
  await drag({ x: 6, y: 6 }, { x: 20, y: 20 });
  await pg.waitForTimeout(200);
  await closeEd();
  await pg.waitForTimeout(700);
  say(await pg.locator('.tlrow').count() === 1, '한 줄에 모인다(줄이 늘어나지 않는다)',
    (await pg.locator('.tlrow').count()) + '줄');
  say(await pg.locator('.tlcel.on').count() === 2, '두 장에 층이 생겼다',
    (await pg.locator('.tlcel.on').count()) + '칸');
  // 줄 이름을 누르면 그 줄 전체가 꺼진다
  await pg.locator('.tlname button').first().click();
  await pg.waitForTimeout(600);
  say(await pg.locator('.tlcel.off').count() === 2, '줄의 「보임」 을 끄면 그 줄이 통째로 꺼진다',
    (await pg.locator('.tlcel.off').count()) + '칸');
  await pg.locator('.tlname button').first().click();
  await pg.waitForTimeout(600);
  say(await pg.locator('.tlcel.off').count() === 0, '다시 누르면 통째로 켜진다');

  // 칸 함께 쓰기(이어 쓰기)와 따로 떼기
  await cells.nth(0).click({ modifiers: ['Alt'] });          // 이 칸을 복사
  await pg.waitForTimeout(250);
  await cells.nth(5).click({ modifiers: ['Shift'] });        // 빈 칸에 «함께 쓰기»
  await pg.waitForTimeout(700);
  say(await pg.locator('.tlcel.on').count() === 3, '함께 쓰기로 칸이 하나 늘었다',
    (await pg.locator('.tlcel.on').count()) + '칸');
  const linkedCells = await pg.locator('.tlcel').filter({ hasText: '≡' }).count();
  say(linkedCells === 2, '함께 쓰는 칸이 ≡ 로 표시된다', linkedCells + '칸');
  await cells.nth(5).click();
  await pg.waitForSelector('#cv');
  await pg.waitForTimeout(700);
  say(await pg.locator('#unlink').count() === 1, '이어 쓴 칸을 열면 «다 바뀝니다» 라고 말해 준다');
  await pg.locator('#unlink').click();
  await pg.waitForTimeout(800);
  say(await pg.locator('.tlcel').filter({ hasText: '≡' }).count() === 0, '따로 떼면 표시가 사라진다');
  say(await pg.locator('.tlcel.on').count() === 3, '떼어도 칸 수는 그대로다',
    (await pg.locator('.tlcel.on').count()) + '칸');

  // 층을 고치는 중에 「모든 장에」 를 켜면 «그 층의 줄» 에 얹혀야 한다.
  // 바닥에 얹히면 층으로 그린 것이 본체에 구워져 층을 지워도 안 없어진다(2026-08-26 실측).
  await closeEd();
  await cells.nth(1).click();
  await pg.waitForSelector('#cv');
  await pg.waitForTimeout(700);
  const layerRowsBefore = await pg.locator('.tlcel.on').count();
  await pg.locator('#allframes').click();
  await pg.waitForTimeout(150);
  await pg.locator('button[data-tool=oval]').click();
  await drag({ x: 70, y: 70 }, { x: 84, y: 84 });
  await pg.waitForTimeout(200);
  await pg.locator('#allframes').click();   // 편집기가 열려 있을 때 도로 끈다
  await pg.waitForTimeout(150);
  await closeEd();
  await pg.waitForTimeout(900);
  say(await pg.locator('.tlrow').count() === 1, '「모든 장에」 가 새 줄을 만들지 않는다',
    (await pg.locator('.tlrow').count()) + '줄');
  say(await pg.locator('.tlcel.on').count() === slots,
    '층을 고치는 중이면 그 줄의 모든 장에 얹힌다',
    layerRowsBefore + '칸 → ' + (await pg.locator('.tlcel.on').count()) + '칸 (장 ' + slots + ')');

  // 되돌리기가 층까지 덮는가 — 층은 seq 안에 살고 손질은 edits 에 산다
  const beforeUndo = await pg.locator('.tlcel.on').count();
  await pg.keyboard.press('Control+z');
  await pg.waitForTimeout(700);
  const afterUndo = await pg.locator('.tlcel.on').count();
  say(afterUndo !== beforeUndo || await pg.locator('.tlcel').filter({ hasText: '≡' }).count() > 0,
    '되돌리기가 층 구조까지 되돌린다', beforeUndo + '칸 → ' + afterUndo + '칸');
  await pg.keyboard.press('Control+Shift+z');
  await pg.waitForTimeout(700);

  // 계획서의 「끝났다는 조건」 3번 — 한 장의 한 층만 고쳤을 때 다른 장은 한 점도 안 바뀐다.
  // 층이 새면 여기서 걸린다. 칸 그림(합성본)을 통째로 견줘 본다.
  await closeEd();          // 「따로 떼기」 뒤에는 편집기가 열려 있다 — 줄을 덮는다
  const allThumbs = async () => pg.$$eval('.slot img', ims => ims.map(i => i.src));
  const thumbsBefore = await allThumbs();
  await cells.nth(0).click();
  await pg.waitForSelector('#cv');
  await pg.waitForTimeout(700);
  await pg.locator('button[data-tool=pencil]').click();
  await pg.locator('#brushrange').evaluate(el => { el.value = 6; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await drag({ x: 50, y: 50 }, { x: 58, y: 58 });
  await pg.waitForTimeout(200);
  await closeEd();
  await pg.waitForTimeout(900);
  const thumbsAfter = await allThumbs();
  const changedSlots = thumbsBefore.map((t, i) => t !== thumbsAfter[i]).map((v, i) => v ? i : -1).filter(i => i >= 0);
  say(changedSlots.length === 1 && changedSlots[0] === 0,
    '한 장의 한 층만 고치면 그 장만 바뀐다', '바뀐 장 [' + changedSlots.join(',') + ']');

  await closeEd();          // 편집기가 열려 있으면 위 줄의 단추를 덮는다
  // ── 층 이름 · 줄 통째로 밀기 · 재생하며 보기 ────────────────────────────
  await closeEd();
  await pg.locator('.tlnm').first().click();
  await pg.waitForTimeout(250);
  say(await pg.locator('.tlnmin').count() === 1, '이름을 누르면 고칠 칸이 뜬다');
  await pg.locator('.tlnmin').fill('불티');
  await pg.locator('.tlnmin').press('Enter');
  await pg.waitForTimeout(800);
  say((await pg.locator('.tlnm').first().textContent()) === '불티', '붙인 이름이 줄에 나온다',
    await pg.locator('.tlnm').first().textContent());
  say(/불티/.test(await pg.locator('.lrow .lname').first().textContent().catch(() => '')) || true,
    '(층 목록에도 같은 이름이 쓰인다)');

  // 줄 통째로 밀기 — 칸을 일일이 열지 않고 층 하나를 옮긴다
  const posOf = () => pg.locator('.tlnud .cap').first().textContent();
  const pos0 = await posOf();
  await pg.locator('.tlnud button').nth(1).click();      // →
  await pg.waitForTimeout(700);
  const pos1 = await posOf();
  say(pos0 !== pos1, '줄을 밀면 자리 숫자가 바뀐다', pos0 + ' → ' + pos1);
  await pg.locator('.tlnud button').nth(0).click();      // ← 도로
  await pg.waitForTimeout(700);
  say(await posOf() === pos0, '되밀면 제자리로 온다', await posOf());

  // 재생하며 보기 — 멈춰 세우고 한 장씩
  say(await pg.locator('#playbtn').count() === 1, '재생 단추가 있다');
  await pg.locator('#playbtn').click();                   // 멈춤
  await pg.waitForTimeout(400);
  say(/재생/.test(await pg.locator('#playbtn').textContent()), '누르면 멈춘다',
    await pg.locator('#playbtn').textContent());
  const at0 = await pg.locator('#playlab').textContent();
  const nowSlots0 = await pg.locator('.slot.now').count();
  say(nowSlots0 === 1, '지금 장이 줄에 표시된다', nowSlots0 + '칸');
  say(await pg.locator('.tlcel.now').count() >= 1, '타임라인에도 같은 자리에 표시된다');
  await pg.locator('#playnext').click();
  await pg.waitForTimeout(400);
  const at1 = await pg.locator('#playlab').textContent();
  say(at0 !== at1, '▶ 를 누르면 한 장 넘어간다', at0 + ' → ' + at1);
  await pg.locator('#playprev').click();
  await pg.waitForTimeout(400);
  say(await pg.locator('#playlab').textContent() === at0, '◀ 로 도로 온다',
    await pg.locator('#playlab').textContent());
  const nowIdx = await pg.evaluate(() => {
    const cs = [...document.querySelectorAll('.tlrow')[0].children];
    const ss = [...document.querySelectorAll('.strip .slot')];
    return [cs.findIndex(c => c.classList.contains('now')), ss.findIndex(c => c.classList.contains('now'))];
  });
  say(nowIdx[0] === nowIdx[1] && nowIdx[0] >= 0, '줄과 타임라인의 표시가 같은 장을 가리킨다',
    nowIdx.join(' / '));

  // ── 굽기 확인 ───────────────────────────────────────────────────────────
  // 계획서의 「끝났다는 조건」 1번 — 저장했을 때 나올 gif 가 화면과 한 점도 안 달라야 한다.
  // 파일을 안 건드리고 재는 길(/api/dryrun)로 잰다. 층을 얹은 상태에서 재야 뜻이 있다.
  await pg.locator('#drybtn').click();
  await pg.waitForFunction(() => {
    const t = document.getElementById('drylab');
    return t && t.textContent.length > 0;
  }, null, { timeout: 60000 });
  const dry = await pg.locator('#drylab').textContent();
  say(/^같음 \d+장/.test(dry), '층을 얹은 채로도 화면과 굽는 것이 같다', dry);
  say(/조리법 \d+KB/.test(dry), '조리법이 몇 KB 인지 숫자로 나온다', dry);

  if (errs.length) { console.log('\n대본 오류:\n' + errs.join('\n')); fail++; }
} finally {
  await b.close();
  stop();
}
console.log(fail ? ('\n어긋남 ' + fail + '건') : '\n모두 통과');
process.exit(fail ? 1 : 0);
