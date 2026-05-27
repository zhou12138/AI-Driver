// ========== Electron Main Process ==========
import { app, BrowserWindow, BrowserView, ipcMain, session } from 'electron';
import { shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { NavEngine } from './nav-engine.js';
import { geocode, getOSRMRoute, getOSRMRouteOptions, haversine, sampleRoute, makeStreetViewUrl, parseGoogleRouteBody } from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file
const envPath = path.join(__dirname, '..', '.env');
try {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
  console.log('✅ .env loaded');
} catch (_) {
  console.log('⚠️ No .env file found, using environment variables');
}

let mainWindow;
let svView;       // Street View BrowserView
let detailView;   // Route details BrowserView
let navEngine;
const isDev = !app.isPackaged;

// ========== Window Management ==========

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Street View Drive',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load React UI
  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5174';
    mainWindow.loadURL(devUrl);
    // Forward renderer console to main process
    mainWindow.webContents.on('console-message', (_e, level, msg) => {
      const tag = ['V','I','W','E'][level] || '?';
      console.log(`[R:${tag}] ${msg}`);
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (navEngine) navEngine.stop();
  });

  setupIPC();
}

// ========== Street View BrowserView ==========

function createStreetView(url) {
  removeRouteDetailView();

  // Remove existing view if any
  if (svView) {
    mainWindow.removeBrowserView(svView);
    try { svView.webContents.destroy(); } catch (_) {}
  }

  svView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.addBrowserView(svView);
  resizeStreetView();

  // Auto-resize when window resizes
  mainWindow.on('resize', resizeStreetView);

  svView.webContents.loadURL(url);

  return svView;
}

function resizeStreetView() {
  if (!svView || !mainWindow) return;
  const { width, height } = mainWindow.getContentBounds();
  const TOP_BAR = 52; // height of React control bar
  svView.setBounds({ x: 0, y: TOP_BAR, width, height: height - TOP_BAR });
}

function createRouteDetailView(url) {
  // Replace existing details view if any.
  if (detailView) {
    mainWindow.removeBrowserView(detailView);
    try { detailView.webContents.destroy(); } catch (_) {}
  }

  detailView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.addBrowserView(detailView);
  resizeRouteDetailView();
  mainWindow.on('resize', resizeRouteDetailView);
  detailView.webContents.loadURL(url);
  return detailView;
}

function resizeRouteDetailView() {
  if (!detailView || !mainWindow) return;
  const { width, height } = mainWindow.getContentBounds();
  const TOP_BAR = 52;
  detailView.setBounds({ x: 0, y: TOP_BAR, width, height: height - TOP_BAR });
}

function removeRouteDetailView() {
  if (detailView && mainWindow) {
    mainWindow.removeBrowserView(detailView);
    mainWindow.removeListener('resize', resizeRouteDetailView);
    try { detailView.webContents.destroy(); } catch (_) {}
    detailView = null;
  }
}

function removeStreetView() {
  if (svView && mainWindow) {
    mainWindow.removeBrowserView(svView);
    mainWindow.removeListener('resize', resizeStreetView);
    try { svView.webContents.destroy(); } catch (_) {}
    svView = null;
  }
}

// ========== Google Route via hidden BrowserWindow ==========

async function getGoogleRoute(startName, endName) {
  return new Promise((resolve) => {
    let routeBody = null;
    const routeWin = new BrowserWindow({
      width: 1200, height: 800,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    // Intercept Google Maps directions response
    routeWin.webContents.session.webRequest.onCompleted(
      { urls: ['*://*.google.com/maps/preview/directions*'] },
      (details) => {
        // We need the response body - use debugger
      }
    );

    // Use CDP to get response body
    routeWin.webContents.debugger.attach('1.3');
    const responseMap = new Map();

    routeWin.webContents.debugger.on('message', (event, method, params) => {
      if (method === 'Network.responseReceived') {
        if (params.response.url.includes('/maps/preview/directions')) {
          responseMap.set(params.requestId, params.response);
        }
      }
      if (method === 'Network.loadingFinished') {
        const resp = responseMap.get(params.requestId);
        if (resp) {
          routeWin.webContents.debugger.sendCommand('Network.getResponseBody', {
            requestId: params.requestId
          }).then(({ body }) => {
            routeBody = body;
          }).catch(() => {});
        }
      }
    });

    routeWin.webContents.debugger.sendCommand('Network.enable');

    const dirUrl = `https://www.google.com/maps/dir/${encodeURIComponent(startName)}/${encodeURIComponent(endName)}`;
    console.log('  🌐 正在从 Google Maps 获取路线...');

    routeWin.webContents.loadURL(dirUrl);

    // Wait for route data
    let attempts = 0;
    const checkInterval = setInterval(async () => {
      attempts++;
      if (routeBody || attempts > 10) {
        clearInterval(checkInterval);

        let result = null;
        if (routeBody) {
          try {
            // Get display distance from page
            const pageText = await routeWin.webContents.executeJavaScript('document.body.innerText');
            const distMatch = pageText.match(/(\d+(?:\.\d+)?)\s*km/);
            const timeMatch = pageText.match(/(\d+)\s*hr\s*(\d+)\s*min|(\d+)\s*min/);
            let displayDistKm = distMatch ? parseFloat(distMatch[1]) : null;
            let displayDurMin = timeMatch
              ? (timeMatch[1] ? parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]) : parseInt(timeMatch[3]))
              : null;

            const best = parseGoogleRouteBody(routeBody, displayDistKm);
            if (best) {
              result = {
                coords: best.coords,
                distanceKm: (displayDistKm || best.distKm).toFixed(1),
                durationMin: displayDurMin || Math.round(best.distKm / 60 * 60),
              };
            }
          } catch (e) {
            console.log('  ⚠️ Google 路线解析失败:', e.message);
          }
        }

        try { routeWin.webContents.debugger.detach(); } catch (_) {}
        try { routeWin.close(); } catch (_) {}
        resolve(result);
      }
    }, 1000);
  });
}

// ========== IPC Handlers ==========

function setupIPC() {
  // Geocode a location
  ipcMain.handle('geo:code', async (_event, query) => {
    return await geocode(query);
  });

  // Plan a route
  ipcMain.handle('nav:plan', async (_event, { fromName, fromLat, fromLng, toName, toLat, toLng }) => {
    console.log(`📋 路线规划: "${fromName}" → "${toName}"`);

    // Check straight-line distance
    const straightDist = haversine(fromLat, fromLng, toLat, toLng);
    if (straightDist > 5000) {
      return { error: `直线距离 ${straightDist.toFixed(0)} km 过大，请检查地名` };
    }

    // Try Google first and fetch OSRM alternatives for route options
    const [googleRoute, osrmOptions] = await Promise.all([
      getGoogleRoute(fromName, toName),
      getOSRMRouteOptions(fromLat, fromLng, toLat, toLng, 3).catch(() => []),
    ]);

    let routeData = googleRoute;
    let source = 'Google Maps';
    if (!routeData && osrmOptions.length > 0) {
      console.log('  ⚠️ Google 失败，使用 OSRM...');
      routeData = {
        coords: osrmOptions[0].coords,
        distanceKm: osrmOptions[0].distanceKm,
        durationMin: osrmOptions[0].durationMin,
      };
      source = 'OSRM';
    }

    if (!routeData) {
      // Final fallback to old single OSRM path if alternatives endpoint fails
      routeData = await getOSRMRoute(fromLat, fromLng, toLat, toLng);
      source = 'OSRM';
    }

    if (!routeData) {
      return { error: '无法获取路线' };
    }

    const waypoints = sampleRoute(routeData.coords, 0.05);
    console.log(`  ✅ ${source}: ${routeData.distanceKm} km, ${waypoints.length} 航点`);

    const routeOptions = [];
    if (googleRoute) {
      const googleWaypoints = sampleRoute(googleRoute.coords, 0.05);
      routeOptions.push({
        id: 'google-primary',
        source: 'Google Maps',
        label: 'Google 推荐路线',
        distanceKm: Number(googleRoute.distanceKm),
        durationMin: googleRoute.durationMin,
        waypointCount: googleWaypoints.length,
        waypoints: googleWaypoints,
        detailsUrl: `https://www.google.com/maps/dir/${encodeURIComponent(fromName)}/${encodeURIComponent(toName)}`,
      });
    }
    for (const opt of osrmOptions) {
      const optWaypoints = sampleRoute(opt.coords, 0.05);
      routeOptions.push({
        id: opt.id,
        source: opt.source,
        label: opt.label,
        distanceKm: opt.distanceKm,
        durationMin: opt.durationMin,
        waypointCount: optWaypoints.length,
        waypoints: optWaypoints,
        detailsUrl: `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${fromLat}%2C${fromLng}%3B${toLat}%2C${toLng}`,
      });
    }

    const selectedOptionId = routeOptions.length > 0 ? routeOptions[0].id : 'default';
    const result = {
      source,
      distanceKm: routeData.distanceKm,
      durationMin: routeData.durationMin,
      waypointCount: waypoints.length,
      waypoints,
      startLat: waypoints[0].lat,
      startLng: waypoints[0].lng,
      selectedOptionId,
      routeOptions,
    };
    console.log('  📤 IPC 返回路线数据...');
    return result;
  });

  ipcMain.handle('sys:openExternal', async (_event, url) => {
    if (!url || typeof url !== 'string') return { ok: false };
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('route:showDetails', async (_event, url) => {
    if (!url || typeof url !== 'string') return { ok: false };
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    createRouteDetailView(url);
    return { ok: true };
  });

  ipcMain.handle('route:hideDetails', async () => {
    removeRouteDetailView();
    return { ok: true };
  });

  // Start driving
  ipcMain.handle('nav:start', async (_event, { waypoints, destName, destLat, destLng, startHeading }) => {
    removeRouteDetailView();

    // Create Street View
    const url = makeStreetViewUrl(waypoints[0].lat, waypoints[0].lng, startHeading || 90);
    createStreetView(url);

    // Wait for Street View to load
    await new Promise(resolve => {
      svView.webContents.once('did-finish-load', resolve);
    });
    await sleep(2000);

    // Hide Google UI
    await svView.webContents.executeJavaScript(HIDE_GOOGLE_UI_SCRIPT);
    await sleep(500);

    // Inject car UI
    await svView.webContents.executeJavaScript(getInjectUIScript(true));
    await sleep(500);

    // Attach CDP debugger
    try { svView.webContents.debugger.attach('1.3'); } catch (_) {}

    // Create navigation engine
    navEngine = new NavEngine({
      webContents: svView.webContents,
      waypoints,
      destName,
      destLat,
      destLng,
      injectUIScript: getInjectUIScript(true),
      hideUIScript: HIDE_GOOGLE_UI_SCRIPT,
      onStatus: (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('nav:status', status);
        }
      },
      onLog: (msg) => {
        console.log(msg);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('nav:log', msg);
        }
      },
    });

    navEngine.start();
    return { ok: true };
  });

  // Free drive mode (no route)
  ipcMain.handle('nav:freeDrive', async (_event, { lat, lng, heading }) => {
    removeRouteDetailView();

    const url = makeStreetViewUrl(lat, lng, heading || 90);
    createStreetView(url);

    await new Promise(resolve => {
      svView.webContents.once('did-finish-load', resolve);
    });
    await sleep(2000);

    await svView.webContents.executeJavaScript(HIDE_GOOGLE_UI_SCRIPT);
    await svView.webContents.executeJavaScript(getInjectUIScript(false));

    try { svView.webContents.debugger.attach('1.3'); } catch (_) {}

    // Simple WASD driving (no route)
    navEngine = new NavEngine({
      webContents: svView.webContents,
      waypoints: null,
      injectUIScript: getInjectUIScript(false),
      hideUIScript: HIDE_GOOGLE_UI_SCRIPT,
      onStatus: (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('nav:status', status);
        }
      },
      onLog: console.log,
    });

    navEngine.start();
    return { ok: true };
  });

  // Speed control
  ipcMain.handle('nav:setSpeed', (_event, speed) => {
    if (navEngine) navEngine.setTargetSpeed(speed);
  });

  // Stop navigation
  ipcMain.handle('nav:stop', () => {
    if (navEngine) navEngine.stop();
    removeRouteDetailView();
    removeStreetView();
    return { ok: true };
  });
}

// ========== Utility ==========

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const HIDE_GOOGLE_UI_SCRIPT = `
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
`;

// Inline the inject UI script (extracted to separate file for readability)
function getInjectUIScript(navMode) {
  return `(${injectCarUIFn.toString()})(${navMode})`;
}

// This function runs in the BrowserView context (Street View page)
function injectCarUIFn(navMode) {
  if (document.getElementById('dashboard')) return; // already injected

  const style = document.createElement('style');
  style.textContent = `
    #dashboard {
      position: fixed; bottom: 0; left: 0; right: 0; height: 280px;
      z-index: 99991; pointer-events: none; background: transparent;
    }
    #rpm-gauge {
      position: fixed; bottom: 100px; left: 50%; margin-left: -200px;
      width: 80px; height: 80px; z-index: 99999; pointer-events: none;
    }
    #speed-gauge {
      position: fixed; bottom: 100px; left: 50%; margin-left: 120px;
      width: 80px; height: 80px; z-index: 99999; pointer-events: none;
    }
    #speed-control {
      position: fixed; right: 30px; bottom: 120px;
      z-index: 99999; display: flex; flex-direction: column;
      align-items: center; gap: 6px; pointer-events: auto;
    }
    #speed-control .speed-label {
      color: #0f0; font-family: 'Courier New', monospace; font-size: 13px;
      text-shadow: 0 0 6px rgba(0,255,0,0.5); letter-spacing: 1px;
    }
    #speed-control .speed-display {
      color: #fff; font-family: 'Courier New', monospace; font-size: 22px;
      font-weight: bold; text-shadow: 0 0 8px rgba(255,255,255,0.4);
      min-width: 80px; text-align: center;
    }
    #speed-slider {
      -webkit-appearance: none; width: 160px; height: 6px; border-radius: 3px;
      background: linear-gradient(90deg, #0a0 0%, #ff0 50%, #f00 100%);
      outline: none; cursor: pointer;
    }
    #speed-slider::-webkit-slider-thumb {
      -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%;
      background: #fff; border: 2px solid #0f0;
      box-shadow: 0 0 8px rgba(0,255,0,0.6); cursor: pointer;
    }
    #speed-control .speed-btn-row { display: flex; gap: 8px; }
    #speed-control .speed-btn {
      width: 32px; height: 28px; border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.3); background: rgba(0,0,0,0.6);
      color: #fff; font-family: 'Courier New', monospace; font-size: 16px;
      font-weight: bold; cursor: pointer; text-align: center; line-height: 26px;
    }
    #speed-control .speed-btn:hover { background: rgba(0,180,0,0.4); border-color: #0f0; }
    #speed-control .speed-hint {
      color: #666; font-family: 'Courier New', monospace; font-size: 9px; text-align: center;
    }
    #distance-hud {
      position: fixed; top: 10px; right: 20px;
      z-index: 99999; pointer-events: none;
      font-family: 'Courier New', monospace; font-size: 14px; color: #0f0;
      background: rgba(0,0,0,0.6); padding: 8px 14px; border-radius: 8px;
      border: 1px solid rgba(0,255,0,0.2);
    }
    #nav-log {
      position: fixed; top: 10px; left: 20px; max-width: 400px;
      z-index: 99999; pointer-events: none;
      font-family: 'Courier New', monospace; font-size: 11px; color: #0f0;
      background: rgba(0,0,0,0.7); padding: 8px; border-radius: 6px;
      border: 1px solid rgba(0,255,0,0.15); max-height: 200px; overflow: hidden;
    }
    #mode-badge {
      position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
      z-index: 99999; pointer-events: none;
      font-family: 'Courier New', monospace; font-size: 14px; font-weight: bold;
      padding: 6px 18px; border-radius: 20px;
      background: rgba(0,100,255,0.7); color: #fff; border: 1px solid rgba(100,180,255,0.5);
    }
    #mode-badge.auto {
      background: rgba(0,100,255,0.72);
      border-color: rgba(100,180,255,0.6);
    }
    #mode-badge.manual {
      background: rgba(0,150,60,0.72);
      border-color: rgba(80,240,140,0.65);
    }
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
  `;
  document.head.appendChild(style);

  // Dashboard
  const dashboard = document.createElement('div');
  dashboard.id = 'dashboard';
  dashboard.innerHTML = '<div id="dash-surface"></div>';
  document.body.appendChild(dashboard);

  // RPM Gauge
  const rpmGauge = document.createElement('div');
  rpmGauge.id = 'rpm-gauge';
  rpmGauge.innerHTML = `<svg viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="38" fill="#111" stroke="#333" stroke-width="2"/>
    <path d="M 20 70 A 35 35 0 1 1 80 70" fill="none" stroke="#444" stroke-width="4" stroke-linecap="round"/>
    <path d="M 65 25 A 35 35 0 0 1 80 70" fill="none" stroke="#c00" stroke-width="4" stroke-linecap="round"/>
    <line id="rpm-needle" x1="50" y1="50" x2="30" y2="60" stroke="#f00" stroke-width="2" stroke-linecap="round"
      style="transform-origin: 50px 50px; transition: transform 0.3s;"/>
    <circle cx="50" cy="50" r="4" fill="#333"/>
    <text x="50" y="88" text-anchor="middle" fill="#666" font-size="8" font-family="monospace">RPM</text>
    <text x="50" y="42" text-anchor="middle" fill="#888" font-size="7" font-family="monospace">×1000</text>
  </svg>`;
  document.body.appendChild(rpmGauge);

  // Speed Gauge
  const speedGauge = document.createElement('div');
  speedGauge.id = 'speed-gauge';
  speedGauge.innerHTML = `<svg viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="38" fill="#111" stroke="#333" stroke-width="2"/>
    <path d="M 20 70 A 35 35 0 1 1 80 70" fill="none" stroke="#444" stroke-width="4" stroke-linecap="round"/>
    <line id="speed-needle" x1="50" y1="50" x2="30" y2="60" stroke="#fff" stroke-width="2" stroke-linecap="round"
      style="transform-origin: 50px 50px; transition: transform 0.3s;"/>
    <circle cx="50" cy="50" r="4" fill="#333"/>
    <text x="50" y="88" text-anchor="middle" fill="#666" font-size="8" font-family="monospace">km/h</text>
    <text id="speed-value" x="50" y="42" text-anchor="middle" fill="#0f0" font-size="11" font-family="monospace">60</text>
  </svg>`;
  document.body.appendChild(speedGauge);

  // Speed Control Slider
  window.__targetSpeed = 60;
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

  document.getElementById('speed-slider').addEventListener('input', e => setTargetSpeed(parseInt(e.target.value)));
  document.getElementById('speed-dec').addEventListener('click', () => setTargetSpeed(window.__targetSpeed - 10));
  document.getElementById('speed-inc').addEventListener('click', () => setTargetSpeed(window.__targetSpeed + 10));

  document.addEventListener('keydown', e => {
    if (e.key === '[' || e.key === '-') { setTargetSpeed(window.__targetSpeed - 10); e.preventDefault(); }
    else if (e.key === ']' || e.key === '=' || e.key === '+') { setTargetSpeed(window.__targetSpeed + 10); e.preventDefault(); }
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

  // WASD Key HUD
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

  // Mode badge
  const modeBadge = document.createElement('div');
  modeBadge.id = 'mode-badge';
  modeBadge.textContent = navMode ? '🤖 AI导航' : '🚗 自由驾驶';
  document.body.appendChild(modeBadge);

  // Nav log
  const navLog = document.createElement('div');
  navLog.id = 'nav-log';
  navLog.textContent = '';
  document.body.appendChild(navLog);

  window.__addNavLog = (msg) => {
    const el = document.getElementById('nav-log');
    if (!el) return;
    el.textContent = msg + '\\n' + el.textContent.split('\\n').slice(0, 8).join('\\n');
  };

  // Distance HUD
  const distHud = document.createElement('div');
  distHud.id = 'distance-hud';
  distHud.innerHTML = '<div>里程 <span id="dist-odo">0.00 km</span></div>';
  document.body.appendChild(distHud);

  window.__updateDistance = (odo) => {
    const el = document.getElementById('dist-odo');
    if (el) el.textContent = odo.toFixed(2) + ' km';
  };

  // Keyboard state tracking
  let autoForward = true;
  const keys = { w: false, a: false, s: false, d: false };
  document.addEventListener('keydown', e => {
    if (e.code === 'Space') {
      e.preventDefault();
      e.stopImmediatePropagation();
      autoForward = !autoForward;
      const badge = document.getElementById('mode-badge');
      if (badge) {
        badge.className = autoForward ? 'auto' : 'manual';
        if (navMode) {
          badge.textContent = autoForward ? '🤖 AI导航  [Space]' : '🎮 手动驾驶  [Space]';
        } else {
          badge.textContent = autoForward ? '▶ AUTO  [Space]' : '🎮 W前进  [Space]';
        }
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
  document.addEventListener('keyup', e => {
    if (e.code === 'Space') {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const k = e.key.toLowerCase();
    if (keys.hasOwnProperty(k)) {
      keys[k] = false;
      const el = document.getElementById('key-' + k);
      if (el) el.classList.remove('active');
    }
  }, { capture: true });

  modeBadge.className = 'auto';
  modeBadge.textContent = navMode ? '🤖 AI导航  [Space]' : '▶ AUTO  [Space]';

  window.__getKeys = () => ({ ...keys });
  window.__getAutoForward = () => autoForward;
  window.__driveGear = () => Math.round((window.__targetSpeed || 60) / 20);
}

// ========== App Lifecycle ==========

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (navEngine) navEngine.stop();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
