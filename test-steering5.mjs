import { chromium } from 'playwright';

const START_URL = 'https://www.google.com/maps/@36.212413,29.4832002,3a,75y,97.12h,83.29t/data=!3m7!1e1!3m5!1sABSnSDNWN4GhketAH-R_yQ!2e0!6shttps:%2F%2Fstreetviewpixels-pa.googleapis.com%2Fv1%2Fthumbnail%3Fcb_client%3Dmaps_sv.tactile%26w%3D900%26h%3D600%26pitch%3D6.71%26panoid%3DABSnSDNWN4GhketAH-R_yQ%26yaw%3D97.12!7i16384!8i8192';

function getHeading(url) { return parseFloat(url.match(/([\d.]+)h/)?.[1]) || 0; }
function getPitch(url) { return parseFloat(url.match(/([\d.]+)t/)?.[1]) || 0; }
function getLng(url) { return parseFloat(url.match(/@[\d.-]+,([\d.-]+)/)?.[1]) || 0; }

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

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

  const cx = vp.w / 2, dragY = vp.h / 4;

  async function drive(steerAngle, ticks, label) {
    const h0 = getHeading(page.url()), p0 = getPitch(page.url()), lng0 = getLng(page.url());
    console.log(`\n--- ${label} ---`);
    console.log(`  Start: heading=${h0}° pitch=${p0}° lng=${lng0}`);

    for (let i = 0; i < ticks; i++) {
      if (Math.abs(steerAngle) > 5) {
        const dragPx = Math.round(-steerAngle * 0.3);
        await page.mouse.move(cx, dragY);
        await page.mouse.down();
        await page.mouse.move(cx + dragPx, dragY, { steps: 3 });
        await page.mouse.up();
        await page.waitForTimeout(20);
        // Programmatic focus restore (no click!)
        await page.evaluate(() => { const c = document.querySelector('canvas'); if (c) c.focus(); });
        await page.waitForTimeout(20);
      }
      for (let j = 0; j < 3; j++) {
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(15);
      }
      await page.waitForTimeout(80);
    }

    await page.waitForTimeout(1500);
    const h1 = getHeading(page.url()), p1 = getPitch(page.url()), lng1 = getLng(page.url());
    const dH = h1 - h0, dP = p1 - p0, fwd = lng1 !== lng0;
    console.log(`  End:   heading=${h1}° pitch=${p1}° lng=${lng1}`);
    console.log(`  Δheading=${dH.toFixed(1)}° Δpitch=${dP.toFixed(1)}° forward=${fwd ? '✅' : '❌'}`);
    console.log(`  Pitch stable: ${Math.abs(dP) < 2 ? '✅ YES' : '❌ NO (drift ' + dP.toFixed(1) + '°)'}`);
    return { dH, dP, fwd };
  }

  const r1 = await drive(0, 25, 'Straight (0°)');
  const r2 = await drive(60, 25, 'Right 60°');
  const r3 = await drive(-60, 25, 'Left -60°');

  console.log('\n======= RESULTS =======');
  console.log(`Straight:  fwd=${r1.fwd?'✅':'❌'} Δh=${r1.dH.toFixed(1)}° Δpitch=${r1.dP.toFixed(1)}°`);
  console.log(`Right 60°: fwd=${r2.fwd?'✅':'❌'} Δh=${r2.dH.toFixed(1)}° Δpitch=${r2.dP.toFixed(1)}°`);
  console.log(`Left -60°: fwd=${r3.fwd?'✅':'❌'} Δh=${r3.dH.toFixed(1)}° Δpitch=${r3.dP.toFixed(1)}°`);

  const pitchOk = [r1,r2,r3].every(r => Math.abs(r.dP) < 2);
  const allFwd = [r1,r2,r3].every(r => r.fwd);
  const steerOk = Math.abs(r2.dH) > 3 && Math.abs(r3.dH) > 3;
  console.log(`\nPitch stable: ${pitchOk ? '✅' : '❌'}`);
  console.log(`Forward works: ${allFwd ? '✅' : '❌'}`);
  console.log(`Steering works: ${steerOk ? '✅' : '❌'}`);
  console.log(`Overall: ${pitchOk && allFwd && steerOk ? '✅ ALL PASS' : '❌ ISSUES'}`);

  await browser.close();
})();
