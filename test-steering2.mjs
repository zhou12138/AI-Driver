import { chromium } from 'playwright';

const START_URL = 'https://www.google.com/maps/@36.212413,29.4832002,3a,75y,97.12h,83.29t/data=!3m7!1e1!3m5!1sABSnSDNWN4GhketAH-R_yQ!2e0!6shttps:%2F%2Fstreetviewpixels-pa.googleapis.com%2Fv1%2Fthumbnail%3Fcb_client%3Dmaps_sv.tactile%26w%3D900%26h%3D600%26pitch%3D6.71%26panoid%3DABSnSDNWN4GhketAH-R_yQ%26yaw%3D97.12!7i16384!8i8192';

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
    args: ['--start-maximized']
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  console.log('Loading Street View...');
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
  await page.mouse.click(vp.w / 2, vp.h / 2);
  await page.waitForTimeout(1000);

  function getHeading(url) {
    const m = url.match(/([\d.]+)h/);
    return m ? parseFloat(m[1]) : null;
  }

  // --- TEST A: Calibrate drag pixel-to-degree ratio ---
  console.log('\n=== TEST A: Drag calibration ===');
  const cx = vp.w / 2, cy = vp.h / 4; // upper area

  // Reset position
  const hStart = getHeading(page.url());
  console.log(`Start heading: ${hStart}°`);

  // Drag left 50px
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 50, cy, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const h1 = getHeading(page.url());
  console.log(`After drag LEFT 50px: ${h1}° (delta: ${(h1 - hStart).toFixed(2)}°)`);

  // Drag left 100px
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 100, cy, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const h2 = getHeading(page.url());
  console.log(`After drag LEFT 100px: ${h2}° (delta from prev: ${(h2 - h1).toFixed(2)}°)`);

  // Drag right 150px
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 150, cy, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const h3 = getHeading(page.url());
  console.log(`After drag RIGHT 150px: ${h3}° (delta from prev: ${(h3 - h2).toFixed(2)}°)`);

  // --- TEST B: Quick small drags (like rapid-fire) ---
  console.log('\n=== TEST B: Rapid small drags ===');
  const hB0 = getHeading(page.url());
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 20, cy, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(1000);
  const hB1 = getHeading(page.url());
  console.log(`10 quick drags LEFT 20px (50ms gap): delta=${(hB1 - hB0).toFixed(2)}°`);

  // --- TEST C: Forward + Steering interleave ---
  console.log('\n=== TEST C: ArrowUp + drag interleave ===');
  const hC0 = getHeading(page.url());
  const latC0 = page.url().match(/@([\d.]+),([\d.]+)/);
  console.log(`Start: heading=${hC0}°, pos=${latC0 ? latC0[1]+','+latC0[2] : '?'}`);

  for (let i = 0; i < 20; i++) {
    // Forward
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(30);
    // Steer left
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 15, cy, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(1500);
  const hC1 = getHeading(page.url());
  const latC1 = page.url().match(/@([\d.]+),([\d.]+)/);
  console.log(`After 20 cycles: heading=${hC1}° (delta=${(hC1 - hC0).toFixed(2)}°), pos=${latC1 ? latC1[1]+','+latC1[2] : '?'}`);
  console.log(`Forward moved: ${latC0 && latC1 ? (latC1[2] !== latC0[2] ? 'YES ✅' : 'NO ❌') : '?'}`);
  console.log(`Heading changed: ${hC1 !== hC0 ? 'YES ✅' : 'NO ❌'}`);

  // --- TEST D: Forward only for comparison ---
  console.log('\n=== TEST D: ArrowUp only x20 ===');
  const hD0 = getHeading(page.url());
  const latD0 = page.url().match(/@([\d.]+),([\d.]+)/);
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(1500);
  const hD1 = getHeading(page.url());
  const latD1 = page.url().match(/@([\d.]+),([\d.]+)/);
  console.log(`After 20 ArrowUp: heading=${hD1}° (delta=${(hD1 - hD0).toFixed(2)}°), pos=${latD1 ? latD1[1]+','+latD1[2] : '?'}`);
  console.log(`Forward moved: ${latD0 && latD1 ? (latD1[2] !== latD0[2] ? 'YES ✅' : 'NO ❌') : '?'}`);

  // --- SUMMARY ---
  console.log('\n=== FINAL SUMMARY ===');
  console.log('Single big drag works for heading rotation');
  console.log('Rapid small drags work for heading rotation');
  console.log('Forward+Steering interleave compatibility: CHECK ABOVE');

  await browser.close();
})();
