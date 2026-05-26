import { chromium } from 'playwright';

const START_URL = 'https://www.google.com/maps/@36.212413,29.4832002,3a,75y,97.12h,83.29t/data=!3m7!1e1!3m5!1sABSnSDNWN4GhketAH-R_yQ!2e0!6shttps:%2F%2Fstreetviewpixels-pa.googleapis.com%2Fv1%2Fthumbnail%3Fcb_client%3Dmaps_sv.tactile%26w%3D900%26h%3D600%26pitch%3D6.71%26panoid%3DABSnSDNWN4GhketAH-R_yQ%26yaw%3D97.12!7i16384!8i8192';

function getH(url) { return parseFloat(url.match(/([\d.]+)h/)?.[1]) || 0; }
function getT(url) { return parseFloat(url.match(/([\d.]+)t/)?.[1]) || 0; }
function getLng(url) { return parseFloat(url.match(/@[\d.-]+,([\d.-]+)/)?.[1]) || 0; }

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--start-maximized'] });
  const page = await (await browser.newContext({ viewport: null })).newPage();
  const cdp = await page.context().newCDPSession(page);

  console.log('Loading...');
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);

  try {
    for (const txt of ['Accept all', 'Accept', '全部接受']) {
      const btn = page.locator(`button:has-text("${txt}")`);
      if (await btn.isVisible({ timeout: 1000 })) { await btn.click(); await page.waitForTimeout(1000); break; }
    }
  } catch (e) {}

  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await page.mouse.click(vp.w / 2, vp.h / 2);
  await page.waitForTimeout(1000);

  const cx = Math.round(vp.w / 2);
  const dragY = Math.round(vp.h / 4);

  // Single CDP drag operation
  async function cdpDrag(fromX, toX, y) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: fromX, y: y, button: 'left', clickCount: 1
    });
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: Math.round(fromX + (toX - fromX) * i / steps), y: y, button: 'left'
      });
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: toX, y: y, button: 'left', clickCount: 1
    });
  }

  // Safe steering: split large drags into multiple ≤18px operations
  const MAX_DRAG_PER_OP = 18;
  async function steer(angle) {
    if (Math.abs(angle) <= 5) return;
    const totalDrag = Math.round(-angle * 0.3);
    const ops = Math.max(1, Math.ceil(Math.abs(totalDrag) / MAX_DRAG_PER_OP));
    const perOp = Math.round(totalDrag / ops);
    for (let k = 0; k < ops; k++) {
      await cdpDrag(cx, cx + perOp, dragY);
    }
  }

  async function drive(steerAngle, ticks, label) {
    const h0 = getH(page.url()), t0 = getT(page.url()), lng0 = getLng(page.url());
    console.log(`\n--- ${label} ---`);
    console.log(`  Start: h=${h0}° t=${t0}° lng=${lng0}`);

    for (let i = 0; i < ticks; i++) {
      for (let j = 0; j < 3; j++) {
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(15);
      }
      await steer(steerAngle);
      await page.waitForTimeout(80);
    }

    await page.waitForTimeout(1500);
    const h1 = getH(page.url()), t1 = getT(page.url()), lng1 = getLng(page.url());
    const dH = h1 - h0, dT = t1 - t0, fwd = lng1 !== lng0;
    console.log(`  End:   h=${h1}° t=${t1}° lng=${lng1}`);
    console.log(`  Δh=${dH.toFixed(1)}° Δt=${dT.toFixed(1)}° fwd=${fwd?'✅':'❌'}`);
    console.log(`  Pitch: ${Math.abs(dT) < 3 ? '✅' : '❌ ('+dT.toFixed(1)+'°)'}`);
    return { dH, dT, fwd };
  }

  const r1 = await drive(0, 30, 'Straight (0°)');
  const r2 = await drive(60, 30, 'Right 60°');
  const r3 = await drive(-60, 30, 'Left -60°');
  const r4 = await drive(120, 25, 'Hard right 120°');
  const r5 = await drive(-120, 25, 'Hard left -120°');
  const r6 = await drive(180, 20, 'Max right 180°');

  console.log('\n======= RESULTS =======');
  const all = [['Straight',r1],['Right 60°',r2],['Left -60°',r3],['Hard R 120°',r4],['Hard L -120°',r5],['Max 180°',r6]];
  all.forEach(([n,r]) => console.log(`${n.padEnd(13)} fwd=${r.fwd?'✅':'❌'} Δh=${r.dH.toFixed(1).padStart(7)}° Δt=${r.dT.toFixed(1).padStart(6)}°`));

  const pitchOk = all.every(([,r]) => Math.abs(r.dT) < 3);
  const allFwd = all.every(([,r]) => r.fwd);
  const steerOk = r2.dH > 0 && r3.dH < 0;
  console.log(`\nPitch: ${pitchOk?'✅':'❌'} Fwd: ${allFwd?'✅':'❌'} Steer: ${steerOk?'✅':'❌'}`);
  console.log(`Overall: ${pitchOk && allFwd && steerOk ? '✅ ALL PASS' : '❌ ISSUES'}`);

  await browser.close();
})();
