import { chromium } from 'playwright';

const START_URL = 'https://www.google.com/maps/@36.212413,29.4832002,3a,75y,97.12h,83.29t/data=!3m7!1e1!3m5!1sABSnSDNWN4GhketAH-R_yQ!2e0!6shttps:%2F%2Fstreetviewpixels-pa.googleapis.com%2Fv1%2Fthumbnail%3Fcb_client%3Dmaps_sv.tactile%26w%3D900%26h%3D600%26pitch%3D6.71%26panoid%3DABSnSDNWN4GhketAH-R_yQ%26yaw%3D97.12!7i16384!8i8192';

function getHeading(url) {
  const m = url.match(/([\d.]+)h/);
  return m ? parseFloat(m[1]) : null;
}
function getPos(url) {
  const m = url.match(/@([\d.-]+),([\d.-]+)/);
  return m ? { lat: parseFloat(m[1]), lng: parseFloat(m[2]) } : null;
}

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge', headless: false, args: ['--start-maximized']
  });
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
    const h0 = getHeading(page.url());
    const p0 = getPos(page.url());
    console.log(`\n--- ${label} ---`);
    console.log(`  Start: heading=${h0}°, lng=${p0?.lng}`);

    for (let i = 0; i < ticks; i++) {
      // Strategy A: Interleave steering drag and forward
      if (Math.abs(steerAngle) > 5) {
        // 1. Drag to steer
        const dragPx = Math.round(-steerAngle * 0.3);
        await page.mouse.move(cx, dragY);
        await page.mouse.down();
        await page.mouse.move(cx + dragPx, dragY, { steps: 3 });
        await page.mouse.up();
        await page.waitForTimeout(30);
        // 2. Click to restore keyboard focus
        await page.mouse.click(cx, vp.h / 2);
        await page.waitForTimeout(30);
      }

      // 3. Forward: ArrowUp
      for (let j = 0; j < 3; j++) {
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(15);
      }

      await page.waitForTimeout(80);
    }

    await page.waitForTimeout(1500);
    const h1 = getHeading(page.url());
    const p1 = getPos(page.url());
    const hDelta = h1 - h0;
    const fwd = p1?.lng !== p0?.lng;
    console.log(`  End:   heading=${h1}°, lng=${p1?.lng}`);
    console.log(`  Forward: ${fwd ? 'YES ✅' : 'NO ❌'} | Heading Δ=${hDelta.toFixed(1)}° ${Math.abs(hDelta) > 1 ? '✅' : '(small)'}`);
    return { hDelta, fwd };
  }

  // Tests
  const r1 = await drive(0, 30, 'Straight (0°)');
  const r2 = await drive(60, 25, 'Right 60°');
  const r3 = await drive(-60, 25, 'Left -60°');
  const r4 = await drive(120, 15, 'Hard right 120°');

  console.log('\n======= RESULTS =======');
  console.log(`Straight:    fwd=${r1.fwd?'✅':'❌'} Δh=${r1.hDelta.toFixed(1)}°`);
  console.log(`Right 60°:   fwd=${r2.fwd?'✅':'❌'} Δh=${r2.hDelta.toFixed(1)}°`);
  console.log(`Left -60°:   fwd=${r3.fwd?'✅':'❌'} Δh=${r3.hDelta.toFixed(1)}°`);
  console.log(`Hard right:  fwd=${r4.fwd?'✅':'❌'} Δh=${r4.hDelta.toFixed(1)}°`);

  const allFwd = [r1,r2,r3,r4].every(r => r.fwd);
  const steerOk = Math.abs(r2.hDelta) > 3 && Math.abs(r3.hDelta) > 3;
  const dirOk = r2.hDelta > 0 && r3.hDelta < 0;
  console.log(`\n${allFwd && steerOk && dirOk ? '✅ ALL PASS' : '❌ ISSUES (see above)'}`);

  await browser.close();
})();
