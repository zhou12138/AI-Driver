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

  // Dismiss dialogs
  try {
    for (const txt of ['Accept all', 'Accept', '全部接受']) {
      const btn = page.locator(`button:has-text("${txt}")`);
      if (await btn.isVisible({ timeout: 1000 })) { await btn.click(); await page.waitForTimeout(1000); break; }
    }
  } catch (e) {}

  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  
  // Focus canvas
  await page.mouse.click(vp.w / 2, vp.h / 2);
  await page.waitForTimeout(1000);

  // === Simulated driving loop with steering ===
  // This simulates what drive.mjs does: ArrowUp + mouse drag

  async function driveWithSteering(steerAngle, ticks, label) {
    const h0 = getHeading(page.url());
    const p0 = getPos(page.url());
    console.log(`\n--- ${label} ---`);
    console.log(`  Start: heading=${h0}°, lng=${p0?.lng}`);

    for (let i = 0; i < ticks; i++) {
      // Forward: ArrowUp x3 (simulating D3 gear)
      for (let j = 0; j < 3; j++) {
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(15);
      }

      // Steering: mouse drag proportional to angle
      if (Math.abs(steerAngle) > 5) {
        const dragPx = Math.round(-steerAngle * 0.3);
        const dragY = vp.h / 4;
        const dragX = vp.w / 2;
        await page.mouse.move(dragX, dragY);
        await page.mouse.down();
        await page.mouse.move(dragX + dragPx, dragY, { steps: 3 });
        await page.mouse.up();
      }

      await page.waitForTimeout(100);
    }

    await page.waitForTimeout(1500);
    const h1 = getHeading(page.url());
    const p1 = getPos(page.url());
    console.log(`  End:   heading=${h1}°, lng=${p1?.lng}`);
    console.log(`  Delta: heading=${(h1 - h0).toFixed(2)}°, lng=${((p1?.lng || 0) - (p0?.lng || 0)).toFixed(6)}`);
    console.log(`  Forward: ${p1?.lng !== p0?.lng ? 'YES ✅' : 'NO ❌'}`);
    console.log(`  Heading changed: ${Math.abs(h1 - h0) > 1 ? 'YES ✅ (Δ=' + (h1-h0).toFixed(1) + '°)' : 'NO ❌ (Δ=' + (h1-h0).toFixed(2) + '°)'}`);
    return { headingDelta: h1 - h0, forward: p1?.lng !== p0?.lng };
  }

  // TEST 1: Drive straight (no steering)
  const r1 = await driveWithSteering(0, 30, 'TEST 1: Straight (angle=0°, 30 ticks)');

  // TEST 2: Steer right 60° (moderate)
  const r2 = await driveWithSteering(60, 30, 'TEST 2: Right 60° (30 ticks)');

  // TEST 3: Steer left -60° (moderate)
  const r3 = await driveWithSteering(-60, 30, 'TEST 3: Left -60° (30 ticks)');

  // TEST 4: Hard right 150° 
  const r4 = await driveWithSteering(150, 20, 'TEST 4: Hard right 150° (20 ticks)');

  // TEST 5: Hard left -150°
  const r5 = await driveWithSteering(-150, 20, 'TEST 5: Hard left -150° (20 ticks)');

  // TEST 6: Small steering 15° (near dead zone)
  const r6 = await driveWithSteering(15, 30, 'TEST 6: Slight right 15° (30 ticks)');

  // SUMMARY
  console.log('\n======= SUMMARY =======');
  console.log(`Straight:      forward=${r1.forward?'✅':'❌'} heading_delta=${r1.headingDelta.toFixed(1)}°`);
  console.log(`Right 60°:     forward=${r2.forward?'✅':'❌'} heading_delta=${r2.headingDelta.toFixed(1)}°`);
  console.log(`Left -60°:     forward=${r3.forward?'✅':'❌'} heading_delta=${r3.headingDelta.toFixed(1)}°`);
  console.log(`Hard right:    forward=${r4.forward?'✅':'❌'} heading_delta=${r4.headingDelta.toFixed(1)}°`);
  console.log(`Hard left:     forward=${r5.forward?'✅':'❌'} heading_delta=${r5.headingDelta.toFixed(1)}°`);
  console.log(`Slight right:  forward=${r6.forward?'✅':'❌'} heading_delta=${r6.headingDelta.toFixed(1)}°`);

  const allForward = [r1,r2,r3,r4,r5,r6].every(r => r.forward);
  const steerWorks = Math.abs(r2.headingDelta) > 3 && Math.abs(r3.headingDelta) > 3;
  const dirCorrect = r2.headingDelta > 0 && r3.headingDelta < 0; // right=+, left=-
  
  console.log(`\nAll forward: ${allForward ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Steering effective: ${steerWorks ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Direction correct (R=+, L=-): ${dirCorrect ? '✅ PASS' : '❌ FAIL'}`);
  
  console.log(`\nOverall: ${allForward && steerWorks && dirCorrect ? '✅ ALL TESTS PASS' : '❌ SOME TESTS FAILED'}`);

  await browser.close();
})();
