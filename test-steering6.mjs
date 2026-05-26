import { chromium } from 'playwright';

const START_URL = 'https://www.google.com/maps/@36.212413,29.4832002,3a,75y,97.12h,83.29t/data=!3m7!1e1!3m5!1sABSnSDNWN4GhketAH-R_yQ!2e0!6shttps:%2F%2Fstreetviewpixels-pa.googleapis.com%2Fv1%2Fthumbnail%3Fcb_client%3Dmaps_sv.tactile%26w%3D900%26h%3D600%26pitch%3D6.71%26panoid%3DABSnSDNWN4GhketAH-R_yQ%26yaw%3D97.12!7i16384!8i8192';

function getH(url) { return parseFloat(url.match(/([\d.]+)h/)?.[1]) || 0; }
function getT(url) { return parseFloat(url.match(/([\d.]+)t/)?.[1]) || 0; }
function getLng(url) { return parseFloat(url.match(/@[\d.-]+,([\d.-]+)/)?.[1]) || 0; }

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--start-maximized'] });
  const page = (await browser.newContext({ viewport: null })).newPage();
  const p = await page;

  console.log('Loading...');
  await p.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(8000);

  try {
    for (const txt of ['Accept all', 'Accept', '全部接受']) {
      const btn = p.locator(`button:has-text("${txt}")`);
      if (await btn.isVisible({ timeout: 1000 })) { await btn.click(); await p.waitForTimeout(1000); break; }
    }
  } catch (e) {}

  const vp = await p.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await p.mouse.click(vp.w / 2, vp.h / 2);
  await p.waitForTimeout(1000);

  const cx = Math.round(vp.w / 2), dragY = Math.round(vp.h / 4);

  async function drive(steerAngle, ticks, label) {
    const h0 = getH(p.url()), t0 = getT(p.url()), lng0 = getLng(p.url());
    console.log(`\n--- ${label} ---`);
    console.log(`  Start: h=${h0}° t=${t0}° lng=${lng0}`);

    for (let i = 0; i < ticks; i++) {
      // ArrowUp FIRST (keyboard focus is good)
      for (let j = 0; j < 3; j++) {
        await p.keyboard.press('ArrowUp');
        await p.waitForTimeout(15);
      }

      // Drag AFTER (purely horizontal, integer coords, more steps)
      if (Math.abs(steerAngle) > 5) {
        const dragPx = Math.round(-steerAngle * 0.3);
        await p.mouse.move(cx, dragY);
        await p.mouse.down();
        await p.mouse.move(cx + dragPx, dragY, { steps: 5 });
        await p.mouse.up();
      }

      await p.waitForTimeout(80);
    }

    await p.waitForTimeout(1500);
    const h1 = getH(p.url()), t1 = getT(p.url()), lng1 = getLng(p.url());
    const dH = h1 - h0, dT = t1 - t0, fwd = lng1 !== lng0;
    console.log(`  End:   h=${h1}° t=${t1}° lng=${lng1}`);
    console.log(`  Δh=${dH.toFixed(1)}° Δt=${dT.toFixed(1)}° fwd=${fwd ? '✅' : '❌'}`);
    console.log(`  Pitch stable: ${Math.abs(dT) < 3 ? '✅' : '❌ (drift ' + dT.toFixed(1) + '°)'}`);
    return { dH, dT, fwd };
  }

  const r1 = await drive(0, 30, 'Straight (0°)');
  const r2 = await drive(60, 30, 'Right 60°');
  const r3 = await drive(-60, 30, 'Left -60°');
  const r4 = await drive(120, 20, 'Hard right 120°');

  console.log('\n======= RESULTS =======');
  [['Straight', r1], ['Right 60°', r2], ['Left -60°', r3], ['Hard 120°', r4]].forEach(([n, r]) => {
    console.log(`${n.padEnd(12)} fwd=${r.fwd?'✅':'❌'} Δh=${r.dH.toFixed(1).padStart(7)}° Δt=${r.dT.toFixed(1).padStart(6)}°`);
  });

  const pitchOk = [r1,r2,r3,r4].every(r => Math.abs(r.dT) < 3);
  const allFwd = [r1,r2,r3,r4].every(r => r.fwd);
  const steerOk = Math.abs(r2.dH) > 3 && r2.dH > 0 && r3.dH < 0;
  console.log(`\nPitch: ${pitchOk?'✅':'❌'} Fwd: ${allFwd?'✅':'❌'} Steer: ${steerOk?'✅':'❌'}`);
  console.log(`Overall: ${pitchOk && allFwd && steerOk ? '✅ ALL PASS' : '❌ ISSUES'}`);

  await browser.close();
})();
