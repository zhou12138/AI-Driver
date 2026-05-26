import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const START_URL = 'https://www.google.com/maps/@36.212413,29.4832002,3a,75y,97.12h,83.29t/data=!3m7!1e1!3m5!1sABSnSDNWN4GhketAH-R_yQ!2e0!6shttps:%2F%2Fstreetviewpixels-pa.googleapis.com%2Fv1%2Fthumbnail%3Fcb_client%3Dmaps_sv.tactile%26w%3D900%26h%3D600%26pitch%3D6.71%26panoid%3DABSnSDNWN4GhketAH-R_yQ%26yaw%3D97.12!7i16384!8i8192';

const STEPS = 25;  // number of forward clicks
const DELAY = 3000; // ms to wait after each click for scene to load

function extractPanoid(url) {
  const m = url.match(/panoid[=:]([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function extractCoords(url) {
  const m = url.match(/@([\d.-]+),([\d.-]+)/);
  return m ? { lat: m[1], lng: m[2] } : null;
}

(async () => {
  const browser = await chromium.launch({
    headless: false,  // UI mode - visible browser
    args: ['--window-size=1400,900']
  });

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  console.log('Opening Google Maps Street View...');
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000); // wait for street view to render

  // Accept cookies if prompted
  try {
    const acceptBtn = page.locator('button:has-text("Accept all")');
    if (await acceptBtn.isVisible({ timeout: 3000 })) {
      await acceptBtn.click();
      await page.waitForTimeout(1000);
    }
  } catch (e) { /* no cookie dialog */ }

  const collected = [];

  for (let step = 0; step < STEPS; step++) {
    const url = page.url();
    const panoid = extractPanoid(url);
    const coords = extractCoords(url);

    if (panoid && !collected.find(c => c.panoid === panoid)) {
      collected.push({ step, panoid, ...coords });
      console.log(`Step ${step}: panoid=${panoid} lat=${coords?.lat} lng=${coords?.lng}`);
    }

    // Click forward on the road - center of viewport, slightly above center
    // Street View arrows are typically in the lower-center area
    await page.mouse.move(700, 500);
    await page.waitForTimeout(500);
    await page.mouse.click(700, 500);
    await page.waitForTimeout(DELAY);
  }

  // Final position
  const finalUrl = page.url();
  const finalPanoid = extractPanoid(finalUrl);
  const finalCoords = extractCoords(finalUrl);
  if (finalPanoid && !collected.find(c => c.panoid === finalPanoid)) {
    collected.push({ step: STEPS, panoid: finalPanoid, ...finalCoords });
  }

  console.log(`\nCollected ${collected.length} unique panoids:`);
  console.log(JSON.stringify(collected, null, 2));

  // Save panoid list
  writeFileSync('panoids.json', JSON.stringify(collected, null, 2));
  console.log('Saved to panoids.json');

  // Download thumbnails for each panoid
  console.log('\nDownloading thumbnails...');
  for (const item of collected) {
    const thumbUrl = `https://streetviewpixels-pa.googleapis.com/v1/thumbnail?cb_client=maps_sv.tactile&w=900&h=600&pitch=0&panoid=${item.panoid}&yaw=97`;
    try {
      const response = await page.request.get(thumbUrl);
      if (response.ok()) {
        const buffer = await response.body();
        const filename = `public/turkey_${item.panoid}.jpg`;
        writeFileSync(filename, buffer);
        console.log(`  Downloaded: ${filename} (${buffer.length} bytes)`);
      }
    } catch (e) {
      console.log(`  Failed: ${item.panoid} - ${e.message}`);
    }
  }

  console.log('\nDone! Press Ctrl+C to close browser or it will close in 10s.');
  await page.waitForTimeout(10000);
  await browser.close();
})();
