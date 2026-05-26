import { chromium } from 'playwright';

function makeStreetViewUrl(lat, lng, heading = 90) {
  return `https://www.google.com/maps/@${lat},${lng},3a,75y,${heading}h,83t/data=!3m4!1e1!3m2!1s!2e0`;
}

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'StreetViewDrive/1.0' } });
  const data = await resp.json();
  if (data.length > 0) {
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), name: data[0].display_name };
  }
  return null;
}

async function getRoute(startLat, startLng, endLat, endLng) {
  const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson&steps=true`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'StreetViewDrive/1.0' } });
  const data = await resp.json();
  if (data.code === 'Ok' && data.routes.length > 0) {
    const route = data.routes[0];
    const coords = route.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
    return {
      coords,
      distanceKm: (route.distance / 1000).toFixed(1),
      durationMin: Math.round(route.duration / 60)
    };
  }
  return null;
}

// Get route from Google Maps directions page (accurate distance + coords)
async function getGoogleRoute(browser, startName, endName) {
  let routePage;
  try {
    routePage = await browser.newPage();
    let routeBody = null;
    routePage.on('response', async (resp) => {
      if (resp.url().includes('/maps/preview/directions')) {
        try { routeBody = await resp.text(); } catch (e) { }
      }
    });

    const dirUrl = `https://www.google.com/maps/dir/${encodeURIComponent(startName)}/${encodeURIComponent(endName)}`;
    console.log('  🌐 正在从 Google Maps 获取路线...');
    await routePage.goto(dirUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for route data to load
    for (let i = 0; i < 20 && !routeBody; i++) {
      await routePage.waitForTimeout(500);
    }
    if (!routeBody) return null;

    const clean = routeBody.replace(/^\)\]\}'\n?/, '');
    const data = JSON.parse(clean);

    // Extract distance & duration from page text
    const pageText = await routePage.evaluate(() => document.body.innerText);
    const distMatch = pageText.match(/(\d+(?:\.\d+)?)\s*km/);
    const timeMatch = pageText.match(/(\d+)\s*hr\s*(\d+)\s*min|(\d+)\s*min/);
    let displayDistKm = null, displayDurMin = null;
    if (distMatch) displayDistKm = parseFloat(distMatch[1]);
    if (timeMatch) {
      displayDurMin = timeMatch[1]
        ? parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2])
        : parseInt(timeMatch[3]);
    }

    // Find delta-encoded coordinate arrays (Google stores as [latDeltas], [lngDeltas])
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

    // Group by length to find lat/lng pairs
    const byLen = {};
    for (const arr of allNumArrays) {
      if (!byLen[arr.length]) byLen[arr.length] = [];
      byLen[arr.length].push(arr);
    }

    // Decode delta arrays and find best route
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
      // Validate coords are in reasonable range
      const valid = coords.filter(c => c.lat > 30 && c.lat < 50 && c.lng > 20 && c.lng < 50);
      if (valid.length < 10) continue;
      // Calculate distance
      let dist = 0;
      for (let j = 1; j < valid.length; j++) {
        dist += haversine(valid[j - 1].lat, valid[j - 1].lng, valid[j].lat, valid[j].lng);
      }
      // Pick route closest to displayed distance, or the longest route
      const diff = displayDistKm ? Math.abs(dist - displayDistKm) : -valid.length;
      if (diff < bestDistDiff) {
        bestDistDiff = diff;
        bestRoute = { coords: valid, distKm: dist };
      }
    }

    if (!bestRoute) return null;

    return {
      coords: bestRoute.coords,
      distanceKm: (displayDistKm || bestRoute.distKm).toFixed(1),
      durationMin: displayDurMin || Math.round(bestRoute.distKm / 60 * 60) // rough estimate
    };
  } catch (e) {
    console.log('  ⚠️ Google Maps 路线获取失败:', e.message);
    return null;
  } finally {
    if (routePage) await routePage.close().catch(() => {});
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const la1 = lat1 * Math.PI / 180, la2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// Sample every N meters to reduce waypoints
function sampleRoute(coords, intervalKm = 0.05) {
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

// ========== AI Navigation (LiteLLM Proxy) ==========
// Load .env
import { readFileSync } from 'fs';
try {
  const envContent = readFileSync(new URL('.env', import.meta.url), 'utf8');
  for (const line of envContent.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0 && !process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
} catch (_) {}
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'claude-haiku-4.5';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'http://localhost:4000/v1';

const AI_SYSTEM_PROMPT = `You are a GPS navigation AI for a Google Street View driving simulator.
Given the car's coordinates, heading, destination, and route waypoints, decide the next driving action.

ACTIONS:
- "drive": heading is roughly correct (within ~15°), keep moving forward
- "turn": need to change heading significantly, then move forward
- "teleport": car is stuck (>15 ticks no movement) or too far from route. Jump to a route waypoint
- "arrived": within 0.8km of final destination

RULES:
1. Calculate bearing from current position toward the route waypoints ahead of wpIndex
2. Use waypoints 3-8 ahead for a stable heading (not just the next one)
3. If stuck >15 ticks at same position, teleport to wpIndex+8 (skip ahead on route)
4. For teleport, set heading = bearing from teleport waypoint toward the one 5 after it
5. Street View roads may not match route exactly — be tolerant of 200-500m offset
6. Consider the route's general direction, not just the nearest waypoint

Respond ONLY with compact JSON (no markdown, no explanation outside JSON):
{"heading":N,"action":"drive|turn|teleport|arrived","teleport_idx":N,"reason":"brief"}`;

async function callAI(ctx) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY environment variable not set');

  const wpList = ctx.nearbyWps.map(w =>
    `  [${w.idx}] ${w.lat.toFixed(6)}, ${w.lng.toFixed(6)}`
  ).join('\n');

  const historyStr = ctx.posHistory.length > 0
    ? ctx.posHistory.map(p =>
        `  (${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}) h=${p.heading.toFixed(0)}° tick=${p.tick}`
      ).join('\n')
    : '  (none)';

  const userMsg = `Position: ${ctx.curLat.toFixed(6)}, ${ctx.curLng.toFixed(6)} heading=${ctx.curHead.toFixed(0)}°
Destination: ${ctx.destName} (${ctx.destLat.toFixed(4)}, ${ctx.destLng.toFixed(4)}) straight-line=${ctx.distToDest.toFixed(1)}km
Current wpIndex: ${ctx.wpIndex}/${ctx.wpTotal}
Stuck ticks: ${ctx.stuckCounter}
Odometer: ${ctx.odometer.toFixed(2)}km

Route waypoints nearby:
${wpList}

Recent positions:
${historyStr}`;

  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: userMsg }
      ],
      temperature: 0.1,
      max_tokens: 150
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI API ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const data = await resp.json();
  const content = data.choices[0].message.content.trim();

  // Parse JSON (handle possible markdown wrapping)
  const jsonStr = content.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
  const result = JSON.parse(jsonStr);

  // Validate & normalize
  if (typeof result.heading !== 'number') result.heading = ctx.curHead;
  if (!['drive', 'turn', 'teleport', 'arrived'].includes(result.action)) result.action = 'drive';
  result.heading = ((result.heading % 360) + 360) % 360;
  if (!result.reason) result.reason = '';

  return result;
}

(async () => {
  console.log('🚗 启动浏览器...');

  // Launch browser first with default location
  const DEFAULT_LOC = { lat: 36.212413, lng: 29.4832002, name: 'D400 Coast Road, Fethiye' };
  const START_URL = makeStreetViewUrl(DEFAULT_LOC.lat, DEFAULT_LOC.lng);

  const browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
    args: ['--start-maximized']
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Dismiss cookie/consent dialogs
  try {
    const btns = ['Accept all', 'Accept', '全部接受', 'I agree'];
    for (const txt of btns) {
      const btn = page.locator(`button:has-text("${txt}")`);
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click();
        await page.waitForTimeout(1000);
        break;
      }
    }
  } catch (e) { /* no dialog */ }

  // Hide Google Maps UI
  await page.evaluate(() => {
    ['#omnibox-singlebox', '#vasquette', '.app-viewcard-strip',
     '#runway-expand-button', '.scene-footer', '#watermark',
     '.app-horizontal-widget-holder', '#minimap', '.scene-description',
     '.scene-footer-container', '.app-bottom-content-anchor',
     '.widget-scene', '.widget-scene-canvas-bottom-left',
     '#image-header', '.scene-action-bar', '#fineprint-label',
     '.app-viewcard-strip', '.noprint', '#mapDiv'
    ].forEach(s => {
      document.querySelectorAll(s).forEach(el => el.style.display = 'none');
    });
  });

  // ===== Show in-page navigation input form =====
  await page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'nav-overlay';
    overlay.innerHTML = `
      <style>
        #nav-overlay {
          position: fixed; inset: 0; z-index: 999999;
          background: rgba(0,0,0,0.85);
          display: flex; align-items: center; justify-content: center;
          font-family: 'Segoe UI', Arial, sans-serif;
        }
        #nav-form {
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
          border: 1px solid #0af; border-radius: 16px;
          padding: 40px 48px; min-width: 420px;
          box-shadow: 0 0 60px rgba(0,170,255,0.3);
        }
        #nav-form h1 {
          color: #fff; font-size: 28px; text-align: center; margin: 0 0 8px;
        }
        #nav-form .subtitle {
          color: #888; font-size: 13px; text-align: center; margin-bottom: 28px;
        }
        #nav-form label {
          color: #0af; font-size: 13px; font-weight: 600;
          display: block; margin-bottom: 6px; margin-top: 16px;
        }
        #nav-form input {
          width: 100%; box-sizing: border-box;
          padding: 12px 14px; font-size: 15px;
          background: rgba(255,255,255,0.08); border: 1px solid #335;
          border-radius: 8px; color: #fff; outline: none;
          transition: border-color 0.2s;
        }
        #nav-form input:focus { border-color: #0af; }
        #nav-form input::placeholder { color: #556; }
        #nav-form .btn-row {
          display: flex; gap: 12px; margin-top: 28px;
        }
        #nav-form button {
          flex: 1; padding: 12px; font-size: 15px; font-weight: 600;
          border: none; border-radius: 8px; cursor: pointer;
          transition: transform 0.1s, box-shadow 0.2s;
        }
        #nav-form button:active { transform: scale(0.97); }
        #nav-start-btn {
          background: linear-gradient(135deg, #0af, #06d);
          color: #fff; box-shadow: 0 4px 20px rgba(0,170,255,0.4);
        }
        #nav-free-btn {
          background: rgba(255,255,255,0.1);
          color: #aaa; border: 1px solid #335;
        }
        #nav-free-btn:hover { background: rgba(255,255,255,0.15); color: #fff; }
        #nav-status {
          color: #0f0; font-size: 13px; text-align: center;
          margin-top: 16px; min-height: 18px;
        }
      </style>
      <div id="nav-form">
        <h1>🚗 全景自动驾驶</h1>
        <div class="subtitle">Street View Panorama Auto-Drive</div>
        <label>📍 起点 Start</label>
        <input id="nav-start-input" placeholder="输入地名或城市 (如: 北京天安门, Tokyo Tower)" autofocus />
        <label>🏁 终点 Destination</label>
        <input id="nav-end-input" placeholder="输入终点 (如: 上海外滩, Shibuya)" />
        <div class="btn-row">
          <button id="nav-start-btn">🗺️ 导航驾驶</button>
          <button id="nav-free-btn">🚗 自由驾驶</button>
        </div>
        <div id="nav-status"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Enter key in end input triggers start button
    document.getElementById('nav-end-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('nav-start-btn').click();
    });
    // Enter key in start input moves to end input
    document.getElementById('nav-start-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('nav-end-input').focus();
    });
  });

  console.log('⏳ 等待用户在页面输入起终点...');

  // Check for CLI args: node drive.mjs "起点" "终点"
  const cliStart = process.argv[2];
  const cliEnd = process.argv[3];
  let navResult;

  if (cliStart && cliEnd) {
    console.log(`📋 CLI模式: 起点="${cliStart}", 终点="${cliEnd}"`);
    navResult = { mode: 'nav', start: cliStart, end: cliEnd };
  } else {
  // Wait for user to click a button, result stored in window.__navResult
  navResult = await page.evaluate(() => {
    return new Promise((resolve) => {
      document.getElementById('nav-start-btn').addEventListener('click', () => {
        const s = document.getElementById('nav-start-input').value.trim();
        const e = document.getElementById('nav-end-input').value.trim();
        const status = document.getElementById('nav-status');
        if (!s && !e) {
          status.textContent = '⚠️ 请至少输入起点或终点';
          status.style.color = '#fa0';
          return;
        }
        status.textContent = '🔍 正在搜索地点并规划路线...';
        status.style.color = '#0af';
        resolve({ mode: 'nav', start: s, end: e });
      });
      document.getElementById('nav-free-btn').addEventListener('click', () => {
        const s = document.getElementById('nav-start-input').value.trim();
        const status = document.getElementById('nav-status');
        status.textContent = '🚗 启动自由驾驶...';
        status.style.color = '#0f0';
        resolve({ mode: 'free', start: s, end: '' });
      });
    });
  });
  } // end else (no CLI args)

  console.log(`📋 用户选择: ${navResult.mode}, 起点="${navResult.start}", 终点="${navResult.end}"`);

  // Geocode & route planning
  let startLoc = DEFAULT_LOC;
  let endLoc = null;
  let routeWaypoints = null;
  let routeInfo = null;

  // Update status in page
  const setStatus = async (msg, color = '#0af') => {
    await page.evaluate(([m, c]) => {
      const el = document.getElementById('nav-status');
      if (el) { el.textContent = m; el.style.color = c; }
    }, [msg, color]);
  };

  if (navResult.start) {
    await setStatus(`🔍 搜索起点 "${navResult.start}"...`);
    const r = await geocode(navResult.start);
    if (r) {
      startLoc = r;
      await setStatus(`✅ 起点: ${r.name}`, '#0f0');
      console.log(`  ✅ 起点: ${r.name}`);
    } else {
      await setStatus('❌ 起点未找到，使用默认位置', '#fa0');
    }
    await page.waitForTimeout(800);
  }

  if (navResult.mode === 'nav' && navResult.end) {
    await setStatus(`🔍 搜索终点 "${navResult.end}"...`);
    const r = await geocode(navResult.end);
    if (r) {
      endLoc = r;
      await setStatus(`✅ 终点: ${r.name}`, '#0f0');
      console.log(`  ✅ 终点: ${r.name}`);
      await page.waitForTimeout(500);

      // Validate: check straight-line distance between start and end
      const straightDist = haversine(startLoc.lat, startLoc.lng, endLoc.lat, endLoc.lng);
      console.log(`  📏 直线距离: ${straightDist.toFixed(1)} km`);

      if (straightDist > 2000) {
        // Likely a geocoding error — distance too far
        await setStatus(`⚠️ 起终点直线距离 ${straightDist.toFixed(0)} km，可能地点有误，请检查`, '#fa0');
        console.log(`  ⚠️ 直线距离异常: ${straightDist.toFixed(0)} km，可能地名输入有误`);
        await page.waitForTimeout(3000);
        endLoc = null;
      } else {
        await setStatus('🗺️ 规划路线中...');
      }
    }

    if (endLoc) {
      // Try Google Maps first (accurate), fall back to OSRM
      let route = await getGoogleRoute(browser, startLoc.name, endLoc.name);
      if (route) {
        console.log('  ✅ 路线来源: Google Maps');
      } else {
        console.log('  ⚠️ Google Maps 失败，使用 OSRM 备选');
        route = await getRoute(startLoc.lat, startLoc.lng, endLoc.lat, endLoc.lng);
      }

      // Validate route distance vs straight-line distance
      if (route) {
        const routeDist = parseFloat(route.distanceKm);
        const straightDist2 = haversine(startLoc.lat, startLoc.lng, endLoc.lat, endLoc.lng);
        const ratio = routeDist / straightDist2;
        if (ratio > 5) {
          console.log(`  ⚠️ 路线距离(${routeDist}km)是直线距离(${straightDist2.toFixed(0)}km)的${ratio.toFixed(1)}倍，路线可能有误，尝试OSRM`);
          await setStatus(`⚠️ 路线距离异常，尝试备选路线...`, '#fa0');
          const osrmRoute = await getRoute(startLoc.lat, startLoc.lng, endLoc.lat, endLoc.lng);
          if (osrmRoute) {
            const osrmRatio = parseFloat(osrmRoute.distanceKm) / straightDist2;
            route = osrmRatio < ratio ? osrmRoute : route; // pick shorter
          }
        }
        // Store straight-line distance for display
        route.straightKm = straightDist2.toFixed(1);
      }
      if (route) {
        routeWaypoints = sampleRoute(route.coords, 0.03);
        routeInfo = route;
        console.log(`  ✅ 路线: ${route.distanceKm} km, ${routeWaypoints.length} 航点`);

        // Show route preview panel
        await page.evaluate(([info, startName, endName, wpCount]) => {
          const form = document.getElementById('nav-form');
          if (!form) return;
          // Hide the input fields
          form.querySelectorAll('label, input, .btn-row').forEach(el => el.style.display = 'none');
          // Update title
          form.querySelector('h1').textContent = '🗺️ 路线规划';
          form.querySelector('.subtitle').textContent = '路线已规划，确认后开始驾驶';

          // Route preview panel
          const preview = document.createElement('div');
          preview.id = 'route-preview';
          preview.innerHTML = `
            <style>
              #route-preview { margin-top: 8px; }
              .rp-card {
                background: rgba(255,255,255,0.06); border: 1px solid #335;
                border-radius: 10px; padding: 14px 16px; margin: 10px 0;
              }
              .rp-label { color: #888; font-size: 11px; margin-bottom: 4px; }
              .rp-value { color: #fff; font-size: 14px; word-break: break-all; }
              .rp-stats {
                display: flex; gap: 16px; margin: 14px 0;
              }
              .rp-stat {
                flex: 1; text-align: center;
                background: rgba(0,170,255,0.1); border: 1px solid #0af3;
                border-radius: 10px; padding: 12px 8px;
              }
              .rp-stat-val {
                color: #0af; font-size: 24px; font-weight: bold;
                font-family: 'Courier New', monospace;
              }
              .rp-stat-unit { color: #888; font-size: 11px; margin-top: 2px; }
              .rp-wp { color: #888; font-size: 12px; text-align: center; margin: 8px 0; }
              #rp-go-btn {
                width: 100%; padding: 14px; font-size: 16px; font-weight: 700;
                border: none; border-radius: 10px; cursor: pointer; margin-top: 16px;
                background: linear-gradient(135deg, #0a4, #0c6);
                color: #fff; box-shadow: 0 4px 20px rgba(0,200,100,0.4);
                transition: transform 0.1s;
              }
              #rp-go-btn:active { transform: scale(0.97); }
              #rp-back-btn {
                width: 100%; padding: 10px; font-size: 13px;
                border: 1px solid #335; border-radius: 8px; cursor: pointer;
                margin-top: 8px; background: transparent; color: #888;
              }
              #rp-back-btn:hover { color: #fff; border-color: #666; }
            </style>
            <div class="rp-card">
              <div class="rp-label">📍 起点</div>
              <div class="rp-value">${startName}</div>
            </div>
            <div class="rp-card">
              <div class="rp-label">🏁 终点</div>
              <div class="rp-value">${endName}</div>
            </div>
            <div class="rp-stats">
              <div class="rp-stat">
                <div class="rp-stat-val">${info.distanceKm}</div>
                <div class="rp-stat-unit">公里 km</div>
              </div>
              <div class="rp-stat">
                <div class="rp-stat-val">${info.straightKm}</div>
                <div class="rp-stat-unit">直线 km</div>
              </div>
              <div class="rp-stat">
                <div class="rp-stat-val">${info.durationMin}</div>
                <div class="rp-stat-unit">分钟 min</div>
              </div>
              <div class="rp-stat">
                <div class="rp-stat-val">${wpCount}</div>
                <div class="rp-stat-unit">航点</div>
              </div>
            </div>
            <button id="rp-go-btn">🚗 确认出发</button>
            <button id="rp-back-btn">← 返回修改</button>
          `;
          form.appendChild(preview);

          const statusEl = document.getElementById('nav-status');
          if (statusEl) statusEl.textContent = '';
        }, [
          { distanceKm: route.distanceKm, durationMin: route.durationMin, straightKm: route.straightKm || '—' },
          startLoc.name,
          endLoc.name,
          routeWaypoints.length
        ]);

        // Wait for user to confirm or go back (auto-confirm in CLI mode)
        let confirmed;
        if (cliStart && cliEnd) {
          confirmed = true;
          // Auto-click the confirm button
          await page.evaluate(() => {
            const btn = document.getElementById('rp-go-btn');
            if (btn) btn.click();
          });
        } else {
          confirmed = await page.evaluate(() => {
            return new Promise((resolve) => {
              document.getElementById('rp-go-btn').addEventListener('click', () => resolve(true));
              document.getElementById('rp-back-btn').addEventListener('click', () => resolve(false));
            });
          });
        }

        if (!confirmed) {
          // User wants to go back — restart the whole process
          console.log('  ↩️ 用户返回修改');
          // Remove preview, show inputs again
          await page.evaluate(() => {
            const preview = document.getElementById('route-preview');
            if (preview) preview.remove();
            const form = document.getElementById('nav-form');
            if (form) {
              form.querySelector('h1').textContent = '🚗 全景自动驾驶';
              form.querySelector('.subtitle').textContent = 'Street View Panorama Auto-Drive';
              form.querySelectorAll('label, input, .btn-row').forEach(el => el.style.display = '');
            }
          });
          // Re-wait for input (recursive-like, but we just re-run)
          // For simplicity, proceed as free drive with the start location
          routeWaypoints = null;
          routeInfo = null;
          endLoc = null;
        }
      } else {
        await setStatus('❌ 路线规划失败，切换自由驾驶', '#f55');
        await page.waitForTimeout(1500);
      }
    } else {
      await setStatus('❌ 终点未找到，切换自由驾驶', '#f55');
      await page.waitForTimeout(1500);
    }
  }

  // Calculate initial heading based on nearest waypoint on route
  let initHeading = 90;
  if (routeWaypoints && routeWaypoints.length > 1) {
    // Find nearest waypoint to start location
    let nearestIdx = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < routeWaypoints.length; i++) {
      const d = haversine(startLoc.lat, startLoc.lng, routeWaypoints[i].lat, routeWaypoints[i].lng);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    }
    // Use a waypoint ~300m ahead for more stable initial heading
    let headingIdx = nearestIdx;
    let accumulated = 0;
    for (let i = nearestIdx; i < routeWaypoints.length - 1; i++) {
      accumulated += haversine(routeWaypoints[i].lat, routeWaypoints[i].lng,
                                routeWaypoints[i+1].lat, routeWaypoints[i+1].lng);
      headingIdx = i + 1;
      if (accumulated >= 0.3) break; // 300m ahead
    }
    initHeading = Math.round(bearing(routeWaypoints[nearestIdx].lat, routeWaypoints[nearestIdx].lng,
                                      routeWaypoints[headingIdx].lat, routeWaypoints[headingIdx].lng));
    console.log(`  🧭 初始朝向: ${initHeading}° (从航点 ${nearestIdx} 看向航点 ${headingIdx})`);
  }

  // Remove overlay
  await page.evaluate(() => {
    const ov = document.getElementById('nav-overlay');
    if (ov) ov.remove();
  });

  // Navigate to start location (use first route waypoint if in nav mode for alignment)
  const navStartLat = routeWaypoints ? routeWaypoints[0].lat : startLoc.lat;
  const navStartLng = routeWaypoints ? routeWaypoints[0].lng : startLoc.lng;
  const FINAL_URL = makeStreetViewUrl(navStartLat, navStartLng, initHeading);
  await page.goto(FINAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Re-dismiss cookie dialog & re-hide Maps UI
  try {
    const btns = ['Accept all', 'Accept', '全部接受', 'I agree'];
    for (const txt of btns) {
      const btn = page.locator(`button:has-text("${txt}")`);
      if (await btn.isVisible({ timeout: 1000 })) { await btn.click(); await page.waitForTimeout(1000); break; }
    }
  } catch (e) {}
  await page.evaluate(() => {
    ['#omnibox-singlebox', '#vasquette', '.app-viewcard-strip',
     '#runway-expand-button', '.scene-footer', '#watermark',
     '.app-horizontal-widget-holder', '#minimap', '.scene-description',
     '.scene-footer-container', '.app-bottom-content-anchor',
     '.widget-scene', '.widget-scene-canvas-bottom-left',
     '#image-header', '.scene-action-bar', '#fineprint-label',
     '.app-viewcard-strip', '.noprint', '#mapDiv'
    ].forEach(s => {
      document.querySelectorAll(s).forEach(el => el.style.display = 'none');
    });
  });

  // ===== Reusable injection functions =====
  async function hideGoogleUI() {
    await page.evaluate(() => {
      ['#omnibox-singlebox', '#vasquette', '.app-viewcard-strip',
       '#runway-expand-button', '.scene-footer', '#watermark',
       '.app-horizontal-widget-holder', '#minimap', '.scene-description',
       '.scene-footer-container', '.app-bottom-content-anchor',
       '.widget-scene', '.widget-scene-canvas-bottom-left',
       '#image-header', '.scene-action-bar', '#fineprint-label',
       '.noprint', '#mapDiv'
      ].forEach(s => {
        document.querySelectorAll(s).forEach(el => el.style.display = 'none');
      });
    });
  }

  // Inject car interior + steering wheel overlay
  const IS_NAV = !!routeWaypoints;
  async function injectCarUI() {
    await page.evaluate((navMode) => {
    const style = document.createElement('style');
    style.textContent = `
      /* Dashboard base */
      #dashboard {
        position: fixed; bottom: 0; left: 0; right: 0; height: 280px;
        z-index: 99991; pointer-events: none;
        background: transparent;
      }

      /* Dashboard top surface reflection */
      #dash-surface {
        display: none;
      }

      /* Side vents */
      .dash-vent {
        position: absolute; bottom: 180px; width: 50px; height: 30px;
        background: #1a1a1a; border: 1px solid #333; border-radius: 4px;
        overflow: hidden;
      }
      .dash-vent::before {
        content: ''; position: absolute; top: 4px; left: 4px; right: 4px; bottom: 4px;
        background: repeating-linear-gradient(0deg, #111 0px, #111 2px, #222 2px, #222 5px);
        border-radius: 2px;
      }
      .dash-vent-left { left: 80px; }
      .dash-vent-right { right: 80px; }

      /* RPM gauge (small, left of steering) */
      #rpm-gauge {
        position: fixed; bottom: 100px; left: 50%; margin-left: -200px;
        width: 80px; height: 80px; z-index: 99999; pointer-events: none;
      }

      /* Speed gauge (small, right of steering) */
      #speed-gauge {
        position: fixed; bottom: 100px; left: 50%; margin-left: 120px;
        width: 80px; height: 80px; z-index: 99999; pointer-events: none;
      }

      /* ===== WASF Key Indicator HUD ===== */
      #key-hud {
        position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
        z-index: 99999; pointer-events: none;
        display: flex; flex-direction: column; align-items: center; gap: 4px;
      }
      .key-row { display: flex; gap: 4px; }
      .key-box {
        width: 44px; height: 44px; border-radius: 6px;
        border: 2px solid rgba(255,255,255,0.25); background: rgba(0,0,0,0.5);
        color: #888; font-family: 'Courier New', monospace; font-size: 18px;
        font-weight: bold; display: flex; align-items: center; justify-content: center;
        transition: all 0.1s;
      }
      .key-box.active {
        background: rgba(0,180,0,0.5); color: #0f0; border-color: #0f0;
        box-shadow: 0 0 12px rgba(0,255,0,0.4);
      }
      /* Speed Control Slider */
      #speed-control {
        position: fixed; right: 30px; bottom: 120px;
        z-index: 99999; display: flex; flex-direction: column;
        align-items: center; gap: 6px;
        pointer-events: auto;
      }
      #speed-control .speed-label {
        color: #0f0; font-family: 'Courier New', monospace; font-size: 13px;
        text-shadow: 0 0 6px rgba(0,255,0,0.5);
        letter-spacing: 1px;
      }
      #speed-control .speed-display {
        color: #fff; font-family: 'Courier New', monospace; font-size: 22px;
        font-weight: bold; text-shadow: 0 0 8px rgba(255,255,255,0.4);
        min-width: 80px; text-align: center;
      }
      #speed-slider {
        -webkit-appearance: none; appearance: none;
        width: 160px; height: 6px; border-radius: 3px;
        background: linear-gradient(90deg, #0a0 0%, #ff0 50%, #f00 100%);
        outline: none; cursor: pointer;
      }
      #speed-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 18px; height: 18px; border-radius: 50%;
        background: #fff; border: 2px solid #0f0;
        box-shadow: 0 0 8px rgba(0,255,0,0.6);
        cursor: pointer;
      }
      #speed-control .speed-btn-row {
        display: flex; gap: 8px;
      }
      #speed-control .speed-btn {
        width: 32px; height: 28px; border-radius: 4px;
        border: 1px solid rgba(255,255,255,0.3); background: rgba(0,0,0,0.6);
        color: #fff; font-family: 'Courier New', monospace; font-size: 16px;
        font-weight: bold; cursor: pointer; text-align: center;
        line-height: 26px;
      }
      #speed-control .speed-btn:hover {
        background: rgba(0,180,0,0.4); border-color: #0f0;
      }
      #speed-control .speed-hint {
        color: #666; font-family: 'Courier New', monospace; font-size: 9px;
        text-align: center;
      }

      /* Distance HUD */
      #distance-hud {
        position: fixed; top: 10px; right: 20px;
        z-index: 99999; pointer-events: none;
        font-family: 'Courier New', monospace;
        background: rgba(0,0,0,0.7); border: 1px solid #444;
        border-radius: 8px; padding: 8px 14px;
      }
      #distance-hud .label { color: #888; font-size: 11px; }
      #distance-hud .value { color: #0f0; font-size: 16px; font-weight: bold; text-shadow: 0 0 6px #0f0; }
      /* Location HUD */
      #location-hud {
        position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
        z-index: 99999; pointer-events: none;
        font-family: 'Courier New', monospace;
        background: rgba(0,0,0,0.75); border: 1px solid #444;
        border-radius: 8px; padding: 4px 14px;
        max-width: 500px; text-align: center;
      }
      #location-hud .loc-addr { color: #fff; font-size: 12px; }
      #location-hud .loc-coord { color: #888; font-size: 10px; margin-top: 1px; }
      /* Route Progress HUD */
      #route-hud {
        position: fixed; top: 100px; left: 20px;
        z-index: 99999; pointer-events: none;
        font-family: 'Courier New', monospace;
        background: rgba(0,0,0,0.75); border: 1px solid #0af;
        border-radius: 8px; padding: 8px 14px; min-width: 180px;
      }
      #route-hud .rh-title { color: #0af; font-size: 12px; font-weight: bold; margin-bottom: 4px; }
      #route-hud .rh-row { color: #ccc; font-size: 11px; margin: 2px 0; }
      #route-hud .rh-val { color: #0f0; font-weight: bold; }
      #route-progress-bar {
        width: 100%; height: 6px; background: #333; border-radius: 3px;
        margin-top: 6px; overflow: hidden;
      }
      #route-progress-fill {
        height: 100%; background: linear-gradient(90deg, #0af, #0f0);
        border-radius: 3px; transition: width 0.5s; width: 0%;
      }
      #mode-badge {
        position: fixed; top: 60px; left: 50%; transform: translateX(-50%);
        z-index: 99999; pointer-events: none;
        font-family: 'Courier New', monospace; font-size: 14px; font-weight: bold;
        padding: 6px 18px; border-radius: 8px;
        border: 2px solid rgba(255,255,255,0.3);
        text-shadow: 0 0 8px currentColor;
        transition: all 0.3s;
      }
      #mode-badge.auto {
        background: rgba(0,100,200,0.6); color: #4cf; border-color: #4cf;
      }
      #mode-badge.manual {
        background: rgba(200,100,0,0.6); color: #fc4; border-color: #fc4;
      }
    `;
    document.head.appendChild(style);

    // ===== Dashboard & Gauges =====
    const dashboard = document.createElement('div');
    dashboard.id = 'dashboard';
    dashboard.innerHTML = `
      <div id="dash-surface"></div>
      <div class="dash-vent dash-vent-left"></div>
      <div class="dash-vent dash-vent-right"></div>
    `;
    document.body.appendChild(dashboard);

    // RPM Gauge (SVG mini gauge)
    const rpmGauge = document.createElement('div');
    rpmGauge.id = 'rpm-gauge';
    rpmGauge.innerHTML = `
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="38" fill="#111" stroke="#333" stroke-width="2"/>
        <path d="M 20 70 A 35 35 0 1 1 80 70" fill="none" stroke="#444" stroke-width="4" stroke-linecap="round"/>
        <path d="M 65 25 A 35 35 0 0 1 80 70" fill="none" stroke="#c00" stroke-width="4" stroke-linecap="round"/>
        <line id="rpm-needle" x1="50" y1="50" x2="30" y2="60" stroke="#f00" stroke-width="2" stroke-linecap="round"
          style="transform-origin: 50px 50px; transition: transform 0.3s;"/>
        <circle cx="50" cy="50" r="4" fill="#333"/>
        <text x="50" y="88" text-anchor="middle" fill="#666" font-size="8" font-family="monospace">RPM</text>
        <text x="50" y="42" text-anchor="middle" fill="#888" font-size="7" font-family="monospace">×1000</text>
      </svg>
    `;
    document.body.appendChild(rpmGauge);

    // Speed Gauge (SVG mini gauge)
    const speedGauge = document.createElement('div');
    speedGauge.id = 'speed-gauge';
    speedGauge.innerHTML = `
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="38" fill="#111" stroke="#333" stroke-width="2"/>
        <path d="M 20 70 A 35 35 0 1 1 80 70" fill="none" stroke="#444" stroke-width="4" stroke-linecap="round"/>
        <line id="speed-needle" x1="50" y1="50" x2="30" y2="60" stroke="#fff" stroke-width="2" stroke-linecap="round"
          style="transform-origin: 50px 50px; transition: transform 0.3s;"/>
        <circle cx="50" cy="50" r="4" fill="#333"/>
        <text x="50" y="88" text-anchor="middle" fill="#666" font-size="8" font-family="monospace">km/h</text>
        <text id="speed-value" x="50" y="42" text-anchor="middle" fill="#0f0" font-size="11" font-family="monospace">60</text>
      </svg>
    `;
    document.body.appendChild(speedGauge);

    // ===== Speed Control Slider =====
    window.__targetSpeed = 60; // default 60 km/h (gear=3)
    const speedCtrl = document.createElement('div');
    speedCtrl.id = 'speed-control';
    speedCtrl.innerHTML = `
      <div class="speed-label">🏎️ 时速控制</div>
      <div class="speed-display" id="speed-target-display">60 km/h</div>
      <input type="range" id="speed-slider" min="0" max="200" step="10" value="60" />
      <div class="speed-btn-row">
        <button class="speed-btn" id="speed-dec">−</button>
        <button class="speed-btn" id="speed-inc">+</button>
      </div>
      <div class="speed-hint">[ / ] 调节 ±10</div>
    `;
    document.body.appendChild(speedCtrl);

    function setTargetSpeed(v) {
      v = Math.max(0, Math.min(200, Math.round(v / 10) * 10));
      window.__targetSpeed = v;
      const slider = document.getElementById('speed-slider');
      if (slider) slider.value = v;
      const disp = document.getElementById('speed-target-display');
      if (disp) disp.textContent = v + ' km/h';
    }
    window.__setTargetSpeed = setTargetSpeed;
    window.__getTargetSpeed = () => window.__targetSpeed;

    document.getElementById('speed-slider').addEventListener('input', (e) => {
      setTargetSpeed(parseInt(e.target.value));
    });
    document.getElementById('speed-dec').addEventListener('click', () => {
      setTargetSpeed(window.__targetSpeed - 10);
    });
    document.getElementById('speed-inc').addEventListener('click', () => {
      setTargetSpeed(window.__targetSpeed + 10);
    });

    // Keyboard: [ and ] for speed control
    document.addEventListener('keydown', (e) => {
      if (e.key === '[' || e.key === '-') {
        setTargetSpeed(window.__targetSpeed - 10);
        e.preventDefault();
      } else if (e.key === ']' || e.key === '=' || e.key === '+') {
        setTargetSpeed(window.__targetSpeed + 10);
        e.preventDefault();
      }
    }, { capture: true });

    // Gauge update function
    window.__updateGauges = (gear, isSteering) => {
      const rpmMap = [0.8, 2, 3.5, 4.5, 5.5, 7, 7.5, 7.8, 7.9, 8, 8];
      const clampGear = Math.min(gear, rpmMap.length - 1);
      const rpm = isSteering ? 0.8 : rpmMap[clampGear];
      const rpmAngle = -130 + (rpm / 8) * 260;
      const rpmNeedle = document.getElementById('rpm-needle');
      if (rpmNeedle) rpmNeedle.style.transform = 'rotate(' + rpmAngle + 'deg)';
      const speed = isSteering ? 0 : gear * 20;
      const speedAngle = -130 + (speed / 200) * 260;
      const speedNeedle = document.getElementById('speed-needle');
      if (speedNeedle) speedNeedle.style.transform = 'rotate(' + speedAngle + 'deg)';
      const sv = document.getElementById('speed-value');
      if (sv) sv.textContent = speed;
    };

    // ===== WASF Key Indicator HUD =====
    const keyHud = document.createElement('div');
    keyHud.id = 'key-hud';
    keyHud.innerHTML = `
      <div class="key-row"><div class="key-box" id="key-w">W</div></div>
      <div class="key-row">
        <div class="key-box" id="key-a">A</div>
        <div class="key-box" id="key-s">S</div>
        <div class="key-box" id="key-d">D</div>
      </div>
    `;
    document.body.appendChild(keyHud);

    // ===== Mode Badge =====
    const modeBadge = document.createElement('div');
    modeBadge.id = 'mode-badge';
    modeBadge.className = 'auto';
    modeBadge.textContent = navMode ? '🤖 AI导航  [Space]' : '▶ AUTO  [Space]';
    document.body.appendChild(modeBadge);

    // --- Mode & keyboard state ---
    let autoForward = true;
    const keys = { w: false, a: false, s: false, d: false };

    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        e.stopImmediatePropagation();
        autoForward = !autoForward;
        modeBadge.className = autoForward ? 'auto' : 'manual';
        if (navMode) {
          modeBadge.textContent = autoForward
            ? '🤖 AI导航  [Space]'
            : '🎮 手动驾驶  [Space]';
        } else {
          modeBadge.textContent = autoForward
            ? '▶ AUTO  [Space]'
            : '🎮 W前进  [Space]';
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (keys.hasOwnProperty(k)) {
        keys[k] = true;
        const el = document.getElementById('key-' + k);
        if (el) el.classList.add('active');
      }
    }, { capture: true });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); return; }
      const k = e.key.toLowerCase();
      if (keys.hasOwnProperty(k)) {
        keys[k] = false;
        const el = document.getElementById('key-' + k);
        if (el) el.classList.remove('active');
      }
    }, { capture: true });

    window.__getKeys = () => ({ ...keys });
    window.__getAutoForward = () => autoForward;
    window.__driveGear = () => Math.round((window.__targetSpeed || 60) / 20);

    // ===== Distance HUD =====
    const distHud = document.createElement('div');
    distHud.id = 'distance-hud';
    distHud.innerHTML = `
      <div><span class="label">\u91cc\u7a0b </span><span class="value" id="dist-odo">0.00 km</span></div>
      <div><span class="label">\u76f4\u7ebf </span><span class="value" id="dist-line">0.00 km</span></div>
    `;
    document.body.appendChild(distHud);

    window.__updateDistance = (odo, line) => {
      const odoEl = document.getElementById('dist-odo');
      const lineEl = document.getElementById('dist-line');
      if (odoEl) odoEl.textContent = odo.toFixed(2) + ' km';
      if (lineEl) lineEl.textContent = line.toFixed(2) + ' km';
    };

    // ===== Location HUD =====
    const locHud = document.createElement('div');
    locHud.id = 'location-hud';
    locHud.innerHTML = `
      <div class="loc-addr" id="loc-addr">\u5b9a\u4f4d\u4e2d...</div>
      <div class="loc-coord" id="loc-coord">-</div>
    `;
    document.body.appendChild(locHud);

    let _geocodeTimer = 0;
    window.__updateLocation = async (lat, lng) => {
      const coordEl = document.getElementById('loc-coord');
      if (coordEl) coordEl.textContent = lat.toFixed(6) + ', ' + lng.toFixed(6);
      // Nominatim rate limit: max 1 req/sec, we throttle to every 5s
      const now = Date.now();
      if (now - _geocodeTimer < 5000) return;
      _geocodeTimer = now;
      try {
        const resp = await fetch(
          'https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng + '&zoom=16&accept-language=zh',
          { headers: { 'User-Agent': 'StreetViewDrive/1.0' } }
        );
        const data = await resp.json();
        const addrEl = document.getElementById('loc-addr');
        if (addrEl && data.display_name) {
          addrEl.textContent = '\ud83d\udccd ' + data.display_name;
        }
      } catch(e) { /* geocode failed, keep last */ }
    };

    // ===== Route Progress HUD =====
    window.__initRouteHud = (totalKm) => {
      const hud = document.createElement('div');
      hud.id = 'route-hud';
      hud.innerHTML = `
        <div class="rh-title">🗺️ 导航模式</div>
        <div class="rh-row">总距离: <span class="rh-val" id="rh-total">${totalKm} km</span></div>
        <div class="rh-row">已行驶: <span class="rh-val" id="rh-driven">0.00 km</span></div>
        <div class="rh-row">剩余: <span class="rh-val" id="rh-remain">${totalKm} km</span></div>
        <div class="rh-row">航点: <span class="rh-val" id="rh-wp">0 / 0</span></div>
        <div id="route-progress-bar"><div id="route-progress-fill"></div></div>
      `;
      document.body.appendChild(hud);
    };

    window.__updateRouteHud = (driven, remain, wpIdx, wpTotal, pct) => {
      const d = document.getElementById('rh-driven');
      const r = document.getElementById('rh-remain');
      const w = document.getElementById('rh-wp');
      const f = document.getElementById('route-progress-fill');
      if (d) d.textContent = driven.toFixed(2) + ' km';
      if (r) r.textContent = remain.toFixed(2) + ' km';
      if (w) w.textContent = wpIdx + ' / ' + wpTotal;
      if (f) f.style.width = Math.min(100, pct).toFixed(1) + '%';
    };

    // --- Sports Car Engine Sound (Combustion Synthesis) ---
    let audioCtx = null;
    let engineStarted = false;

    function startEngine() {
      if (engineStarted) return;
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      engineStarted = true;
      const sr = audioCtx.sampleRate;

      // --- Build a single combustion cycle buffer ---
      // Simulates V8 firing order: 8 combustion pulses per 2 revolutions
      function buildCycleBuffer(rpm) {
        const firesPerSec = (rpm / 60) * 4; // V8: 4 fires per revolution
        const cycleLen = sr / firesPerSec * 8; // 8 pulses per buffer
        const buf = audioCtx.createBuffer(1, Math.round(cycleLen), sr);
        const d = buf.getChannelData(0);
        const pulseSamples = Math.round(sr / firesPerSec);

        for (let p = 0; p < 8; p++) {
          const offset = p * pulseSamples;
          for (let i = 0; i < pulseSamples && (offset + i) < d.length; i++) {
            const t = i / sr;
            // Combustion: sharp attack, exponential decay noise burst
            const env = Math.exp(-t * 800) * 0.7 + Math.exp(-t * 120) * 0.3;
            // Mix: noise (combustion) + low resonance (cylinder pressure)
            const noise = (Math.random() * 2 - 1);
            const tone = Math.sin(2 * Math.PI * 85 * t) * 0.6
                       + Math.sin(2 * Math.PI * 170 * t) * 0.25
                       + Math.sin(2 * Math.PI * 55 * t) * 0.4;
            // Slight timing variation for realism
            const jitter = 1.0 + (Math.random() - 0.5) * 0.08;
            d[offset + i] = (noise * 0.55 + tone * 0.45) * env * jitter;
          }
        }
        return buf;
      }

      // Build buffers at different RPMs
      const idleBuf = buildCycleBuffer(900);
      const lowBuf = buildCycleBuffer(2500);
      const midBuf = buildCycleBuffer(4000);
      const highBuf = buildCycleBuffer(6000);
      const redBuf = buildCycleBuffer(7500);
      const gearBuffers = [idleBuf, lowBuf, lowBuf, midBuf, highBuf, redBuf]; // idx 0=idle,1=D1..5=D5

      // --- Audio Graph ---
      // Source (looped buffer) → distortion → exhaust resonance → cab filter → master
      let source = null;
      let currentBufIdx = 0;

      const master = audioCtx.createGain();
      master.gain.value = 0.35;
      master.connect(audioCtx.destination);

      // Cabinet/body resonance (low-mid boost)
      const cabFilter = audioCtx.createBiquadFilter();
      cabFilter.type = 'peaking';
      cabFilter.frequency.value = 250;
      cabFilter.Q.value = 2;
      cabFilter.gain.value = 6;
      cabFilter.connect(master);

      // Exhaust pipe resonance
      const exhaust1 = audioCtx.createBiquadFilter();
      exhaust1.type = 'bandpass';
      exhaust1.frequency.value = 120;
      exhaust1.Q.value = 3;

      const exhaust2 = audioCtx.createBiquadFilter();
      exhaust2.type = 'bandpass';
      exhaust2.frequency.value = 350;
      exhaust2.Q.value = 2;

      // Parallel exhaust resonances
      const exhaustMix = audioCtx.createGain();
      exhaustMix.gain.value = 1.0;
      exhaust1.connect(exhaustMix);
      exhaust2.connect(exhaustMix);
      exhaustMix.connect(cabFilter);

      // Direct path (bypass) for attack transients
      const directGain = audioCtx.createGain();
      directGain.gain.value = 0.3;
      directGain.connect(cabFilter);

      // Waveshaper for aggressive distortion/growl
      const distortion = audioCtx.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const x = (i / 128) - 1;
        curve[i] = (Math.PI + 3.5) * x / (Math.PI + 3.5 * Math.abs(x)); // soft clip
      }
      distortion.curve = curve;
      distortion.oversample = '2x';
      distortion.connect(exhaust1);
      distortion.connect(exhaust2);
      distortion.connect(directGain);

      // Continuous rumble layer (intake/mechanical noise)
      const rumbleBuf = audioCtx.createBuffer(1, sr * 2, sr);
      const rumbleData = rumbleBuf.getChannelData(0);
      for (let i = 0; i < rumbleData.length; i++) {
        const t = i / sr;
        rumbleData[i] = (Math.random() * 2 - 1) * 0.12
          + Math.sin(2 * Math.PI * 42 * t) * 0.08
          + Math.sin(2 * Math.PI * 84 * t) * 0.04;
      }
      const rumble = audioCtx.createBufferSource();
      rumble.buffer = rumbleBuf;
      rumble.loop = true;
      const rumbleFilter = audioCtx.createBiquadFilter();
      rumbleFilter.type = 'lowpass';
      rumbleFilter.frequency.value = 300;
      const rumbleGain = audioCtx.createGain();
      rumbleGain.gain.value = 0.4;
      rumble.connect(rumbleFilter).connect(rumbleGain).connect(master);
      rumble.start();

      function playBuffer(idx) {
        if (source) { try { source.stop(); } catch(e){} }
        source = audioCtx.createBufferSource();
        source.buffer = gearBuffers[idx];
        source.loop = true;
        source.connect(distortion);
        source.start();
        currentBufIdx = idx;
      }

      // Start at idle
      playBuffer(0);

      window.__updateEngineRPM = (gear, isSteering) => {
        if (!audioCtx || audioCtx.state === 'closed') return;
        const t = audioCtx.currentTime;
        const targetIdx = isSteering ? 0 : gear;
        // Switch buffer if gear changed
        if (targetIdx !== currentBufIdx) {
          playBuffer(targetIdx);
        }
        // Volume: louder at higher gears
        const vol = isSteering ? 0.22 : 0.28 + gear * 0.04;
        master.gain.linearRampToValueAtTime(vol, t + 0.12);
        // Exhaust resonance shifts with RPM
        const rpmFactor = isSteering ? 1 : 1 + gear * 0.3;
        exhaust1.frequency.exponentialRampToValueAtTime(100 * rpmFactor, t + 0.15);
        exhaust2.frequency.exponentialRampToValueAtTime(300 * rpmFactor, t + 0.15);
        rumbleGain.gain.linearRampToValueAtTime(isSteering ? 0.5 : 0.25 + gear * 0.06, t + 0.15);
      };

      console.log('🔊 Engine started');
    }

    // Engine sound disabled
    // document.addEventListener('pointerdown', () => startEngine(), { once: true });
    // setTimeout(() => startEngine(), 1000);
  }, IS_NAV);
  }

  // Initial injection
  await injectCarUI();


  console.log('🏎️ Space=切换 | AUTO自动前进 / W手动前进 | A左转 D右转 S后退');

  // Open CDP session for precise mouse events
  const cdp = await page.context().newCDPSession(page);

  // Focus canvas
  const vp = await page.evaluate(() => ({
    w: window.innerWidth, h: window.innerHeight
  }));
  await page.mouse.click(vp.w / 2, vp.h / 2);
  await page.waitForTimeout(500);

  const dragX = Math.round(vp.w / 2);
  const dragY = Math.round(vp.h / 4);
  const MAX_DRAG = 18; // max pixels per drag — tested safe for zero pitch drift

  // CDP precise horizontal-only drag
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

  const START_LAT = routeWaypoints ? routeWaypoints[0].lat : startLoc.lat;
  const START_LNG = routeWaypoints ? routeWaypoints[0].lng : startLoc.lng;
  let odometer = 0;
  let prevLat = START_LAT;
  let prevLng = START_LNG;

  // Navigation state
  const NAV_MODE = !!routeWaypoints;
  let wpIndex = 0;
  let arrived = false;

  // AI navigation state
  let stuckCounter = 0;
  let lastNavLat = 0;
  let lastNavLng = 0;
  let aiDecision = null;   // { heading, action, teleport_idx?, reason }
  let aiCallCount = 0;
  let lastAiCallTick = -100;
  const AI_CALL_INTERVAL = 20; // call AI every N ticks
  let posHistory = [];         // recent positions for AI context

  if (NAV_MODE) {
    // Find nearest starting waypoint
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < routeWaypoints.length; i++) {
      const d = haversine(START_LAT, START_LNG, routeWaypoints[i].lat, routeWaypoints[i].lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    wpIndex = bestIdx;
    console.log(`🤖 AI导航模式: ${routeWaypoints.length} 航点, ${routeInfo.distanceKm} km (起始航点 ${wpIndex})`);
    if (!OPENAI_API_KEY) {
      console.log('  ⚠️ 未设置 OPENAI_API_KEY，将使用简单方向计算作为后备');
    } else {
      console.log(`  ✅ AI模型: ${OPENAI_MODEL}`);
    }

    await page.evaluate((totalKm) => {
      if (window.__initRouteHud) window.__initRouteHud(totalKm);
    }, routeInfo.distanceKm);
  } else {
    console.log('🚗 自由驾驶模式');
  }

  // Main loop
  let tick = 0;

  while (true) {
    tick++;

    try {
    // Read state from browser
    const { autoFwd, keys } = await page.evaluate(() => ({
      autoFwd: window.__getAutoForward ? window.__getAutoForward() : true,
      keys: window.__getKeys ? window.__getKeys() : { w: false, a: false, s: false, d: false }
    }));

    const gear = await page.evaluate(() => {
      const spd = window.__getTargetSpeed ? window.__getTargetSpeed() : 60;
      return Math.round(spd / 20);
    });

    if (NAV_MODE && !arrived) {
      // In nav mode: autoFwd=true → AI auto-follow route, autoFwd=false → manual WASD
      if (autoFwd) {
        // ===== AI-DRIVEN AUTO NAVIGATION =====
        const url = page.url();
        const posM = url.match(/@([\d.-]+),([\d.-]+)/);
        const headM = url.match(/([\d.]+)h/);

        if (posM && headM) {
          const curLat = parseFloat(posM[1]);
          const curLng = parseFloat(posM[2]);
          const curHead = parseFloat(headM[1]);

          // === Stuck detection ===
          const moved = haversine(curLat, curLng, lastNavLat, lastNavLng) > 0.002;
          if (!moved && lastNavLat !== 0) {
            stuckCounter++;
          } else {
            stuckCounter = 0;
            lastNavLat = curLat;
            lastNavLng = curLng;
          }

          // Position history (every 5 ticks)
          if (tick % 5 === 0) {
            posHistory.push({ lat: curLat, lng: curLng, heading: curHead, tick });
            if (posHistory.length > 20) posHistory.shift();
          }

          // Advance wpIndex if close to current waypoint (150m) or passed it
          while (wpIndex < routeWaypoints.length - 1) {
            const d = haversine(curLat, curLng, routeWaypoints[wpIndex].lat, routeWaypoints[wpIndex].lng);
            if (d < 0.15) { wpIndex++; continue; }
            // Also advance if car has passed the waypoint (bearing to wp is >90° off heading)
            const brgToWp = bearing(curLat, curLng, routeWaypoints[wpIndex].lat, routeWaypoints[wpIndex].lng);
            let diff = brgToWp - curHead;
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;
            if (Math.abs(diff) > 110 && d < 0.5) { wpIndex++; } else break;
          }

          // Destination distance
          const finalDest = routeWaypoints[routeWaypoints.length - 1];
          const distToDest = haversine(curLat, curLng, finalDest.lat, finalDest.lng);

          // === Should we call AI? ===
          const shouldCallAI =
            (aiDecision === null) ||
            (tick - lastAiCallTick >= AI_CALL_INTERVAL) ||
            (stuckCounter >= 15 && tick - lastAiCallTick >= 5);

          if (shouldCallAI) {
            lastAiCallTick = tick;
            aiCallCount++;

            // Nearby waypoints for AI context
            const wpStart = Math.max(0, wpIndex - 3);
            const wpEnd = Math.min(routeWaypoints.length, wpIndex + 25);
            const nearbyWps = routeWaypoints.slice(wpStart, wpEnd).map((w, i) => ({
              idx: wpStart + i, lat: w.lat, lng: w.lng
            }));

            try {
              aiDecision = await callAI({
                curLat, curLng, curHead,
                destLat: finalDest.lat, destLng: finalDest.lng,
                destName: endLoc.name,
                distToDest,
                stuckCounter,
                wpIndex,
                wpTotal: routeWaypoints.length,
                nearbyWps,
                posHistory: posHistory.slice(-5),
                odometer
              });

              const emoji = { drive: '🚗', turn: '↩️', teleport: '🔀', arrived: '🏁' }[aiDecision.action] || '❓';
              console.log(`  🤖 AI#${aiCallCount}: ${emoji} ${aiDecision.action} h=${aiDecision.heading}° | ${aiDecision.reason}`);
            } catch (e) {
              console.log(`  ❌ AI调用失败: ${e.message}`);
              // Fallback: simple bearing toward waypoints ahead
              const fallbackIdx = Math.min(wpIndex + 5, routeWaypoints.length - 1);
              const fbWp = routeWaypoints[fallbackIdx];
              aiDecision = {
                heading: Math.round(bearing(curLat, curLng, fbWp.lat, fbWp.lng)),
                action: stuckCounter > 15 ? 'teleport' : 'drive',
                teleport_idx: stuckCounter > 15 ? Math.min(wpIndex + 8, routeWaypoints.length - 1) : undefined,
                reason: 'API失败，使用方向计算'
              };
              console.log(`  🔧 后备决策: ${aiDecision.action} h=${aiDecision.heading}° | ${aiDecision.reason}`);
            }
          }

          if (!aiDecision) { await page.waitForTimeout(200); continue; }

          // === Deterministic stuck fallback (if AI didn't teleport) ===
          if (stuckCounter > 30 && aiDecision.action !== 'teleport') {
            const tpIdx = Math.min(wpIndex + 10, routeWaypoints.length - 1);
            const tpNext = Math.min(tpIdx + 5, routeWaypoints.length - 1);
            aiDecision = {
              action: 'teleport',
              teleport_idx: tpIdx,
              heading: Math.round(bearing(routeWaypoints[tpIdx].lat, routeWaypoints[tpIdx].lng, routeWaypoints[tpNext].lat, routeWaypoints[tpNext].lng)),
              reason: '确定性回退：stuck>30'
            };
            console.log(`  🔧 stuck>30 强制传送: wp${tpIdx}`);
          }

          // === Execute AI Decision ===
          if (aiDecision.action === 'arrived') {
            arrived = true;
            console.log('🏁 AI判断已到达终点！');
            await page.evaluate(() => {
              const hud = document.getElementById('route-hud');
              if (hud) {
                const t = hud.querySelector('.rh-title');
                if (t) { t.textContent = '🏁 已到达终点！'; t.style.color = '#0f0'; }
              }
            });
            continue;
          }

          if (aiDecision.action === 'teleport' && aiDecision.teleport_idx != null) {
            const tpIdx = Math.min(Math.max(0, aiDecision.teleport_idx), routeWaypoints.length - 1);
            const tpWp = routeWaypoints[tpIdx];
            wpIndex = tpIdx;
            stuckCounter = 0;
            posHistory = [];

            console.log(`  🔀 传送: wp${tpIdx} (${tpWp.lat.toFixed(5)}, ${tpWp.lng.toFixed(5)}) h=${aiDecision.heading}°`);
            try {
              await page.goto(makeStreetViewUrl(tpWp.lat, tpWp.lng, aiDecision.heading), {
                waitUntil: 'domcontentloaded', timeout: 20000
              });
              await page.waitForTimeout(3000);
              await hideGoogleUI();
              await injectCarUI();
              await page.mouse.click(vp.w / 2, vp.h / 2);
              await page.waitForTimeout(500);
              if (routeInfo) {
                await page.evaluate((totalKm) => {
                  if (window.__initRouteHud) window.__initRouteHud(totalKm);
                }, routeInfo.distanceKm);
              }
            } catch (tpErr) {
              console.log(`  ⚠️ 传送异常: ${tpErr.message?.slice(0, 100) || tpErr}`);
              // Wait and try to recover page state
              await page.waitForTimeout(3000);
              try { await hideGoogleUI(); } catch (_) {}
              try { await injectCarUI(); } catch (_) {}
              try { await page.mouse.click(vp.w / 2, vp.h / 2); } catch (_) {}
            }
            lastNavLat = tpWp.lat;
            lastNavLng = tpWp.lng;
            aiDecision = null; // force new AI call next tick
            continue;
          }

          // === Deterministic heading correction (bearing to look-ahead waypoint) ===
          const lookIdx = Math.min(wpIndex + 5, routeWaypoints.length - 1);
          const targetBrg = Math.round(bearing(curLat, curLng, routeWaypoints[lookIdx].lat, routeWaypoints[lookIdx].lng));
          let angleDiff = targetBrg - curHead;
          if (angleDiff > 180) angleDiff -= 360;
          if (angleDiff < -180) angleDiff += 360;
          const absAngle = Math.abs(angleDiff);

          if (absAngle > 15) {
            // Nudge heading toward route bearing (FIXED drag direction)
            const dragDir = angleDiff > 0 ? -1 : 1;
            const dragPx = Math.min(MAX_DRAG, Math.max(3, Math.round(absAngle * 0.2)));
            await cdpDrag(dragX - dragDir * dragPx, dragX + dragDir * dragPx, dragY);
            await page.waitForTimeout(20);
          }

          // Always drive forward
          for (let i = 0; i < gear; i++) {
            await page.keyboard.press('ArrowUp');
            await page.waitForTimeout(15);
          }

          // Update gauges
          await page.evaluate(([g]) => {
            if (window.__updateGauges) window.__updateGauges(g, false);
          }, [gear]);

          // Update odometer
          const seg = haversine(prevLat, prevLng, curLat, curLng);
          if (seg < 0.5) odometer += seg;
          prevLat = curLat; prevLng = curLng;

          // Update HUD every 10 ticks
          if (tick % 10 === 0) {
            const totalDist = parseFloat(routeInfo.distanceKm);
            const remain = distToDest;
            const pct = Math.min(100, Math.max(0, (1 - remain / totalDist) * 100));

            await page.evaluate(([driven, remain2, wpI, wpT, pct2, lat, lng]) => {
              if (window.__updateRouteHud) window.__updateRouteHud(driven, remain2, wpI, wpT, pct2);
              if (window.__updateDistance) window.__updateDistance(driven, 0);
              if (window.__updateLocation) window.__updateLocation(lat, lng);
            }, [odometer, remain, wpIndex, routeWaypoints.length, pct, curLat, curLng]);

            const stuckTag = stuckCounter > 5 ? ` stuck:${stuckCounter}` : '';
            console.log(`  🧭 tick ${tick} | wp ${wpIndex}/${routeWaypoints.length} | ${curLat.toFixed(5)}, ${curLng.toFixed(5)} | h:${curHead.toFixed(0)}→brg${targetBrg}° Δ${angleDiff.toFixed(0)}° | odo:${odometer.toFixed(2)}km | dest:${distToDest.toFixed(1)}km${stuckTag}`);
          }
        }

        await page.waitForTimeout(100);
      } else {
        // === Manual WASD in nav mode (Space toggled off auto-nav) ===
        const turning = keys.a || keys.d;
        const moving = keys.w;

        await page.evaluate(([g, idle]) => {
          if (window.__updateGauges) window.__updateGauges(g, idle);
        }, [gear, !moving && !turning]);

        if (moving) {
          const steps = turning ? 1 : gear;
          for (let i = 0; i < steps; i++) {
            await page.keyboard.press('ArrowUp');
            await page.waitForTimeout(15);
          }
        }
        if (keys.s) await page.keyboard.press('ArrowDown');
        if (keys.a) await cdpDrag(dragX + MAX_DRAG, dragX - MAX_DRAG, dragY);
        if (keys.d) await cdpDrag(dragX - MAX_DRAG, dragX + MAX_DRAG, dragY);

        await page.waitForTimeout(moving || turning ? 100 : 200);

        // Update position & route HUD even in manual mode
        if (tick % 15 === 0) {
          const url = page.url();
          const posM = url.match(/@([\d.-]+),([\d.-]+)/);
          if (posM) {
            const curLat = parseFloat(posM[1]);
            const curLng = parseFloat(posM[2]);
            const seg = haversine(prevLat, prevLng, curLat, curLng);
            if (seg < 0.5) odometer += seg;
            prevLat = curLat; prevLng = curLng;

            const totalDist = parseFloat(routeInfo.distanceKm);
            // Real-time straight-line distance to destination
            const finalDest2 = routeWaypoints[routeWaypoints.length - 1];
            const remain = haversine(curLat, curLng, finalDest2.lat, finalDest2.lng);
            const pct = Math.min(100, Math.max(0, (1 - remain / totalDist) * 100));

            await page.evaluate(([driven, remain2, wpI, wpT, pct2, lat, lng]) => {
              if (window.__updateRouteHud) window.__updateRouteHud(driven, remain2, wpI, wpT, pct2);
              if (window.__updateDistance) window.__updateDistance(driven, 0);
              if (window.__updateLocation) window.__updateLocation(lat, lng);
            }, [odometer, remain, wpIndex, routeWaypoints.length, pct, curLat, curLng]);

            // Also check if we're near the next waypoint
            const target = routeWaypoints[wpIndex];
            const distToWp = haversine(curLat, curLng, target.lat, target.lng);
            if (distToWp < 0.15) {
              wpIndex++;
              if (wpIndex >= routeWaypoints.length) {
                arrived = true;
                console.log('🏁 已到达终点！');
              } else {
                console.log(`  ➡️ 航点 ${wpIndex}/${routeWaypoints.length}`);
              }
            }

            const keyStr = ['w','a','s','d'].filter(k => keys[k]).join('+');
            console.log(`  🎮 tick ${tick} | MANUAL | ${keyStr || 'idle'} | wp ${wpIndex}/${routeWaypoints.length} | odo:${odometer.toFixed(2)}km`);
          }
        }
      }
    } else {
      // === Free driving mode (original WASD) ===
      const turning = keys.a || keys.d;
      const moving = autoFwd || keys.w;

      // Update gauges
      await page.evaluate(([g, idle]) => {
        if (window.__updateGauges) window.__updateGauges(g, idle);
      }, [gear, !moving && !turning]);

      // Forward: auto or W (reduced speed while turning)
      if (moving) {
        const steps = turning ? 1 : gear;
        for (let i = 0; i < steps; i++) {
          await page.keyboard.press('ArrowUp');
          await page.waitForTimeout(15);
        }
      }

      // S = backward
      if (keys.s) {
        await page.keyboard.press('ArrowDown');
      }

      // A = turn left
      if (keys.a) {
        await cdpDrag(dragX + MAX_DRAG, dragX - MAX_DRAG, dragY);
      }

      // D = turn right
      if (keys.d) {
        await cdpDrag(dragX - MAX_DRAG, dragX + MAX_DRAG, dragY);
      }

      // Tick interval
      await page.waitForTimeout(moving || turning ? 100 : 200);

      // Log & distance every 30 ticks
      if (tick % 30 === 0) {
        const url = page.url();
        const m = url.match(/@([\d.-]+),([\d.-]+)/);
        const lat = m ? parseFloat(m[1]) : null;
        const lng = m ? parseFloat(m[2]) : null;
        const hm = url.match(/([\d.]+)h/);
        const tm = url.match(/([\d.]+)t/);

        if (lat && lng) {
          const seg = haversine(prevLat, prevLng, lat, lng);
          if (seg < 0.5) odometer += seg;
          prevLat = lat; prevLng = lng;

          const straightLine = haversine(START_LAT, START_LNG, lat, lng);

          await page.evaluate(([odo, line, lat2, lng2]) => {
            if (window.__updateDistance) window.__updateDistance(odo, line);
            if (window.__updateLocation) window.__updateLocation(lat2, lng2);
          }, [odometer, straightLine, lat, lng]);

          const modeStr = autoFwd ? 'AUTO' : 'W';
          const keyStr = ['a','s','d'].filter(k => keys[k]).join('+');
          console.log(`  tick ${tick} | ${modeStr}${keyStr ? '+' + keyStr : ''} | ${lat}, ${lng} | h:${hm?hm[1]:'?'} t:${tm?tm[1]:'?'} | odo:${odometer.toFixed(2)}km line:${straightLine.toFixed(2)}km`);
        }
      }
    }
    } catch (tickErr) {
      // Protect against page.evaluate / page.goto failures during navigation
      console.log(`  ⚠️ tick ${tick} 异常: ${tickErr.message?.slice(0, 120) || tickErr}`);
      await page.waitForTimeout(1000);
      // Try to re-inject UI in case page context was lost
      try { await injectCarUI(); } catch (_) {}
    }
  }
})();
