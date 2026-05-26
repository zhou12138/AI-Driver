import { chromium } from 'playwright';

// Decode Google Maps encoded polyline
function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();

  let routeBody = null;
  page.on('response', async (resp) => {
    if (resp.url().includes('/maps/preview/directions')) {
      try { routeBody = await resp.text(); } catch (e) { }
    }
  });

  console.log('Navigating to Google Maps directions...');
  await page.goto('https://www.google.com/maps/dir/Fethiye/Ka%C5%9F', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await page.waitForTimeout(8000);

  if (!routeBody) {
    console.log('No route response captured');
    await browser.close();
    return;
  }

  const clean = routeBody.replace(/^\)\]\}'\n?/, '');
  const data = JSON.parse(clean);
  const str = JSON.stringify(data);

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Google stores route coords as delta-encoded arrays at 1e7 precision
  // Array pairs: [latDeltas], [lngDeltas] where first value is absolute*1e7
  // and subsequent values are deltas from previous
  const allNumArrays = [];
  function findNumArrays(obj, depth) {
    if (depth > 25) return;
    if (!Array.isArray(obj)) return;
    if (obj.length > 100 && obj.every(n => typeof n === 'number')) {
      allNumArrays.push(obj);
    }
    for (const item of obj) {
      if (Array.isArray(item)) findNumArrays(item, depth + 1);
    }
  }
  findNumArrays(data, 0);
  
  // Group arrays by length (lat/lng pairs have same length)
  const byLen = {};
  for (const arr of allNumArrays) {
    const key = arr.length;
    if (!byLen[key]) byLen[key] = [];
    byLen[key].push(arr);
  }
  
  console.log('Arrays grouped by length:');
  for (const [len, arrs] of Object.entries(byLen)) {
    if (arrs.length >= 2) {
      console.log(`  Length ${len}: ${arrs.length} arrays`);
    }
  }
  
  // Decode delta-encoded coords for paired arrays
  for (const [len, arrs] of Object.entries(byLen)) {
    if (arrs.length < 2) continue;
    
    // Try first two arrays as lat/lng
    const latArr = arrs[0];
    const lngArr = arrs[1];
    
    // Decode deltas
    const coords = [];
    let lat = 0, lng = 0;
    for (let i = 0; i < latArr.length; i++) {
      lat += latArr[i];
      lng += lngArr[i];
      coords.push({ lat: lat / 1e7, lng: lng / 1e7 });
    }
    
    // Check if coords are in Turkey
    const valid = coords.filter(c => c.lat > 35 && c.lat < 42 && c.lng > 26 && c.lng < 45);
    if (valid.length > 10) {
      let dist = 0;
      for (let j = 1; j < valid.length; j++) {
        dist += haversine(valid[j - 1].lat, valid[j - 1].lng, valid[j].lat, valid[j].lng);
      }
      console.log(`\n  Route (${len} pts): ${valid.length} valid, dist=${dist.toFixed(1)} km`);
      console.log(`    Start: ${valid[0].lat.toFixed(6)}, ${valid[0].lng.toFixed(6)}`);
      console.log(`    End:   ${valid[valid.length - 1].lat.toFixed(6)}, ${valid[valid.length - 1].lng.toFixed(6)}`);
      console.log(`    Sample points (every 500):`);
      for (let i = 0; i < valid.length; i += 500) {
        console.log(`      [${i}] ${valid[i].lat.toFixed(6)}, ${valid[i].lng.toFixed(6)}`);
      }
    }
  }

  // Also search for distance/duration values in the data
  // Google often stores distance in meters as integers
  const numMatches = str.match(/1[0-4]\d{4}(?=[,\]\[])/g);
  if (numMatches) {
    const unique = [...new Set(numMatches)].map(n => `${n} (${(parseInt(n) / 1000).toFixed(1)}km)`);
    console.log('Distance candidates (meters):', unique.slice(0, 10));
  }

  // Search for duration in seconds (5000-7000 = ~83-117 min)
  const durMatches = str.match(/[5-7]\d{3}(?=[,\]\[])/g);
  if (durMatches) {
    const unique = [...new Set(durMatches)].map(n => `${n} (${(parseInt(n) / 60).toFixed(0)}min)`);
    console.log('Duration candidates (seconds):', unique.slice(0, 10));
  }

  await browser.close();
})();
