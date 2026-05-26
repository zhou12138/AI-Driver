// ========== Pure helper functions (shared between drive.mjs and Electron) ==========

export function makeStreetViewUrl(lat, lng, heading = 90) {
  return `https://www.google.com/maps/@${lat},${lng},3a,75y,${heading}h,83t/data=!3m4!1e1!3m2!1s!2e0`;
}

export async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'StreetViewDrive/1.0' } });
  const data = await resp.json();
  if (data.length > 0) {
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), name: data[0].display_name };
  }
  return null;
}

export async function getOSRMRoute(startLat, startLng, endLat, endLng) {
  // Round to 2 decimals first to avoid OSRM road-snapping bugs in city centers
  const tryCoords = [
    [startLat, startLng, endLat, endLng],
    [Math.round(startLat * 100) / 100, Math.round(startLng * 100) / 100,
     Math.round(endLat * 100) / 100, Math.round(endLng * 100) / 100],
  ];
  const straightDist = haversine(startLat, startLng, endLat, endLng);

  for (let ci = 0; ci < tryCoords.length; ci++) {
    const [sLat, sLng, eLat, eLng] = tryCoords[ci];
    const url = `https://router.project-osrm.org/route/v1/driving/${sLng},${sLat};${eLng},${eLat}?overview=full&geometries=geojson&steps=true`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'StreetViewDrive/1.0' } });
    const data = await resp.json();
    if (data.code === 'Ok' && data.routes.length > 0) {
      const route = data.routes[0];
      const routeDistKm = route.distance / 1000;
      // If route is >3x straight-line distance, likely a snapping issue — try next coords
      if (routeDistKm > straightDist * 3 && ci < tryCoords.length - 1) {
        console.log(`  ⚠️ OSRM 路线异常 (${routeDistKm.toFixed(0)}km vs 直线${straightDist.toFixed(0)}km), 重试...`);
        continue;
      }
      const coords = route.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
      return {
        coords,
        distanceKm: routeDistKm.toFixed(1),
        durationMin: Math.round(route.duration / 60)
      };
    }
  }
  return null;
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const la1 = lat1 * Math.PI / 180, la2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

export function sampleRoute(coords, intervalKm = 0.05) {
  if (coords.length < 2) return coords;
  const sampled = [coords[0]];
  let accum = 0;
  for (let i = 1; i < coords.length; i++) {
    accum += haversine(coords[i - 1].lat, coords[i - 1].lng, coords[i].lat, coords[i].lng);
    if (accum >= intervalKm) {
      sampled.push(coords[i]);
      accum = 0;
    }
  }
  const last = coords[coords.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

// Google Maps route extraction (via BrowserWindow navigation + response interception)
export function parseGoogleRouteBody(body, displayDistKm) {
  const clean = body.replace(/^\)\]\}'\n?/, '');
  const data = JSON.parse(clean);

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

  const byLen = {};
  for (const arr of allNumArrays) {
    if (!byLen[arr.length]) byLen[arr.length] = [];
    byLen[arr.length].push(arr);
  }

  let bestRoute = null;
  let bestDistDiff = Infinity;

  for (const [, arrs] of Object.entries(byLen)) {
    if (arrs.length < 2) continue;
    const latArr = arrs[0], lngArr = arrs[1];
    const coords = [];
    let lat = 0, lng = 0;
    for (let i = 0; i < latArr.length; i++) {
      lat += latArr[i]; lng += lngArr[i];
      coords.push({ lat: lat / 1e7, lng: lng / 1e7 });
    }
    const valid = coords.filter(c => Math.abs(c.lat) < 90 && Math.abs(c.lng) < 180);
    if (valid.length < 10) continue;
    let dist = 0;
    for (let j = 1; j < valid.length; j++) {
      dist += haversine(valid[j - 1].lat, valid[j - 1].lng, valid[j].lat, valid[j].lng);
    }
    const diff = displayDistKm ? Math.abs(dist - displayDistKm) : -valid.length;
    if (diff < bestDistDiff) {
      bestDistDiff = diff;
      bestRoute = { coords: valid, distKm: dist };
    }
  }

  return bestRoute;
}
