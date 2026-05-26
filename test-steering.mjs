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

  // Focus canvas
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await page.mouse.click(vp.w / 2, vp.h / 2);
  await page.waitForTimeout(1000);

  // --- TEST 1: Check heading from URL ---
  function getHeading(url) {
    const m = url.match(/([\d.]+)h/);
    return m ? parseFloat(m[1]) : null;
  }
  const h0 = getHeading(page.url());
  console.log(`\n=== TEST 1: Initial heading from URL: ${h0}° ===`);

  // --- TEST 2: Try ArrowLeft keyboard ---
  console.log('\n=== TEST 2: ArrowLeft x 10 ===');
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(500);
  const h1 = getHeading(page.url());
  console.log(`  After ArrowLeft x10: heading=${h1}° (delta: ${h1 !== null && h0 !== null ? (h1 - h0).toFixed(2) : '?'}°)`);

  // --- TEST 3: Try ArrowRight keyboard ---
  console.log('\n=== TEST 3: ArrowRight x 20 ===');
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(500);
  const h2 = getHeading(page.url());
  console.log(`  After ArrowRight x20: heading=${h2}° (delta from start: ${h2 !== null && h0 !== null ? (h2 - h0).toFixed(2) : '?'}°)`);

  // --- TEST 4: Try mouse drag ---
  console.log('\n=== TEST 4: Mouse drag 200px left ===');
  const cx = vp.w / 2, cy = vp.h / 3;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 200, cy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1000);
  const h3 = getHeading(page.url());
  console.log(`  After drag left 200px: heading=${h3}° (delta from prev: ${h3 !== null && h2 !== null ? (h3 - h2).toFixed(2) : '?'}°)`);

  // --- TEST 5: Quick discrete drag ---
  console.log('\n=== TEST 5: Quick discrete drag x5 (down-move-up 30px each) ===');
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 30, cy, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(500);
  const h4 = getHeading(page.url());
  console.log(`  After 5 quick drags right: heading=${h4}° (delta from prev: ${h4 !== null && h3 !== null ? (h4 - h3).toFixed(2) : '?'}°)`);

  // --- TEST 6: Check Google Maps API ---
  console.log('\n=== TEST 6: Google Maps panorama API ===');
  const apiResult = await page.evaluate(() => {
    const results = [];
    // Check google.maps
    results.push('google exists: ' + (typeof window.google !== 'undefined'));
    results.push('google.maps exists: ' + (typeof window.google?.maps !== 'undefined'));

    // Try to find panorama object in window
    let panoFound = false;
    for (const key of Object.keys(window)) {
      try {
        const v = window[key];
        if (v && typeof v === 'object' && typeof v.getPov === 'function' && typeof v.setPov === 'function') {
          panoFound = true;
          results.push('Pano found at window.' + key);
          const pov = v.getPov();
          results.push('  getPov(): heading=' + pov.heading + ' pitch=' + pov.pitch);
          break;
        }
      } catch (e) {}
    }
    if (!panoFound) results.push('No pano found in window keys');

    // Try walking DOM from canvas
    const canvases = document.querySelectorAll('canvas');
    results.push('Canvas count: ' + canvases.length);
    for (const c of canvases) {
      let el = c;
      for (let i = 0; i < 20 && el; i++) {
        const keys = Object.keys(el).filter(k => k.includes('pano') || k.includes('Pano') || k.includes('gm'));
        if (keys.length > 0) {
          results.push('  DOM walk found keys at depth ' + i + ': ' + keys.join(', '));
        }
        // Check for __gmaps properties
        for (const k of Object.getOwnPropertyNames(el)) {
          if (k.startsWith('__')) {
            const desc = typeof el[k];
            if (desc === 'object' && el[k] && typeof el[k].getPov === 'function') {
              results.push('  PANO API found at el.' + k + ' depth=' + i);
              panoFound = true;
            }
          }
        }
        el = el.parentElement;
      }
    }

    return results.join('\n');
  });
  console.log(apiResult);

  // --- SUMMARY ---
  console.log('\n=== SUMMARY ===');
  console.log(`ArrowLeft works: ${h1 !== h0 ? 'YES ✅' : 'NO ❌'}`);
  console.log(`ArrowRight works: ${h2 !== h1 ? 'YES ✅' : 'NO ❌'}`);
  console.log(`Mouse drag works: ${h3 !== h2 ? 'YES ✅' : 'NO ❌'}`);
  console.log(`Quick discrete drag works: ${h4 !== h3 ? 'YES ✅' : 'NO ❌'}`);

  await browser.close();
})();
