// ========== Navigation Engine for Electron ==========
// Controls Street View via webContents.debugger (CDP) and executeJavaScript
import { haversine, bearing, makeStreetViewUrl } from './helpers.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'claude-haiku-4.5';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'http://localhost:4000/v1';

const AI_SYSTEM_PROMPT = `You are a GPS navigation AI for a Google Street View driving simulator.
Given the car's coordinates, heading, destination, and route waypoints, decide the next driving action.

ACTIONS:
- "drive": heading is roughly correct (within ~15°), keep moving forward
- "turn": need to change heading significantly, then move forward
- "teleport": car is stuck (>15 ticks no movement) or too far from route
- "arrived": within 0.8km of final destination

Respond ONLY with compact JSON:
{"heading":N,"action":"drive|turn|teleport|arrived","teleport_idx":N,"reason":"brief"}`;

export class NavEngine {
  constructor({ webContents, waypoints, destName, destLat, destLng, onStatus, onLog }) {
    this.wc = webContents;
    this.waypoints = waypoints;
    this.destName = destName || '';
    this.destLat = destLat || 0;
    this.destLng = destLng || 0;
    this.onStatus = onStatus || (() => {});
    this.onLog = onLog || console.log;

    this.running = false;
    this.tick = 0;
    this.wpIndex = 0;
    this.arrived = false;
    this.targetSpeed = 60;
    this.odometer = 0;
    this.prevLat = 0;
    this.prevLng = 0;
    this.stuckCounter = 0;
    this.lastNavLat = 0;
    this.lastNavLng = 0;
    this.aiDecision = null;
    this.aiCallCount = 0;
    this.lastAiCallTick = -999;
    this.AI_CALL_INTERVAL = 20;
    this.posHistory = [];
    this.MAX_DRAG = 18;
  }

  setTargetSpeed(speed) {
    this.targetSpeed = Math.max(0, Math.min(200, speed));
    // Update in Street View page too
    this.wc.executeJavaScript(`
      if (window.__setTargetSpeed) window.__setTargetSpeed(${this.targetSpeed});
    `).catch(() => {});
  }

  stop() {
    this.running = false;
  }

  async start() {
    if (!this.waypoints) {
      // Free driving mode - just let keyboard control work
      this.running = true;
      this.freeDriveLoop();
      return;
    }

    // Find nearest starting waypoint
    const url = this.wc.getURL();
    const posM = url.match(/@([\d.-]+),([\d.-]+)/);
    if (posM) {
      const startLat = parseFloat(posM[1]);
      const startLng = parseFloat(posM[2]);
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < this.waypoints.length; i++) {
        const d = haversine(startLat, startLng, this.waypoints[i].lat, this.waypoints[i].lng);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      this.wpIndex = bestIdx;
      this.prevLat = startLat;
      this.prevLng = startLng;
    }

    this.onLog(`🤖 AI导航模式: ${this.waypoints.length} 航点 (起始航点 ${this.wpIndex})`);
    this.running = true;
    this.navLoop();
  }

  // ========== CDP Mouse Drag ==========
  async cdpDrag(fromX, toX, y) {
    const dbg = this.wc.debugger;
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(fromX + (toX - fromX) * (i / steps));
      const type = i === 0 ? 'mousePressed' : (i === steps ? 'mouseReleased' : 'mouseMoved');
      await dbg.sendCommand('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', buttons: 1,
      });
    }
  }

  // ========== Keyboard Input ==========
  async pressKey(key) {
    this.wc.sendInputEvent({ type: 'keyDown', keyCode: key });
    await sleep(5);
    this.wc.sendInputEvent({ type: 'keyUp', keyCode: key });
  }

  // ========== Get viewport size ==========
  async getViewport() {
    const bounds = this.wc.getOwnerBrowserWindow?.()?.getContentBounds?.();
    if (bounds) return { w: bounds.width, h: bounds.height };
    // Fallback: read from page
    const size = await this.wc.executeJavaScript('[window.innerWidth, window.innerHeight]');
    return { w: size[0], h: size[1] };
  }

  // ========== AI Call ==========
  async callAI(ctx) {
    const wpList = ctx.nearbyWps.map(w =>
      `  [${w.idx}] ${w.lat.toFixed(6)}, ${w.lng.toFixed(6)}`
    ).join('\n');

    const userMsg = `Position: ${ctx.curLat.toFixed(6)}, ${ctx.curLng.toFixed(6)} heading=${ctx.curHead.toFixed(0)}°
Destination: ${this.destName} (${this.destLat.toFixed(4)}, ${this.destLng.toFixed(4)}) straight-line=${ctx.distToDest.toFixed(1)}km
Current wpIndex: ${ctx.wpIndex}/${this.waypoints.length}
Stuck ticks: ${this.stuckCounter}
Odometer: ${this.odometer.toFixed(2)}km`;

    const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.1,
        max_tokens: 150,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenAI API ${resp.status}: ${errText.substring(0, 200)}`);
    }

    const data = await resp.json();
    const content = data.choices[0].message.content.trim();
    const jsonStr = content.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
    const result = JSON.parse(jsonStr);

    if (typeof result.heading !== 'number') result.heading = ctx.curHead;
    if (!['drive', 'turn', 'teleport', 'arrived'].includes(result.action)) result.action = 'drive';
    result.heading = ((result.heading % 360) + 360) % 360;
    return result;
  }

  // ========== Main Navigation Loop ==========
  async navLoop() {
    const vp = await this.getViewport();
    const dragX = vp.w / 2;
    const dragY = vp.h / 4;

    while (this.running && !this.arrived) {
      this.tick++;

      try {
        const url = this.wc.getURL();
        const posM = url.match(/@([\d.-]+),([\d.-]+)/);
        const headM = url.match(/([\d.]+)h/);

        if (!posM || !headM) {
          await sleep(200);
          continue;
        }

        const curLat = parseFloat(posM[1]);
        const curLng = parseFloat(posM[2]);
        const curHead = parseFloat(headM[1]);
        const gear = Math.round(this.targetSpeed / 20);

        // Stuck detection
        const moved = haversine(curLat, curLng, this.lastNavLat, this.lastNavLng) > 0.002;
        if (!moved && this.lastNavLat !== 0) {
          this.stuckCounter++;
        } else {
          this.stuckCounter = 0;
          this.lastNavLat = curLat;
          this.lastNavLng = curLng;
        }

        // Waypoint advancement
        const target = this.waypoints[this.wpIndex];
        const distToWp = haversine(curLat, curLng, target.lat, target.lng);
        if (distToWp < 0.15) {
          this.wpIndex++;
          if (this.wpIndex >= this.waypoints.length) {
            this.arrived = true;
            this.onLog('🏁 已到达终点！');
            this.onStatus({ type: 'arrived', odometer: this.odometer });
            break;
          }
        } else if (distToWp < 0.5) {
          const headingToWp = bearing(curLat, curLng, target.lat, target.lng);
          let diff = headingToWp - curHead;
          if (diff > 180) diff -= 360;
          if (diff < -180) diff += 360;
          if (Math.abs(diff) > 110) {
            this.wpIndex++;
            if (this.wpIndex >= this.waypoints.length) {
              this.arrived = true;
              this.onLog('🏁 已到达终点！');
              break;
            }
          }
        }

        // Destination distance check (arrived detection)
        const finalDest = this.waypoints[this.waypoints.length - 1];
        const distToDest = haversine(curLat, curLng, finalDest.lat, finalDest.lng);
        if (distToDest < 0.8 && this.wpIndex >= this.waypoints.length - 10) {
          this.arrived = true;
          this.onLog('🏁 已到达终点！');
          this.onStatus({ type: 'arrived', odometer: this.odometer });
          break;
        }

        // AI call (throttled)
        const shouldCallAI = (this.tick - this.lastAiCallTick >= this.AI_CALL_INTERVAL)
          || (this.stuckCounter >= 15 && this.tick - this.lastAiCallTick >= 5)
          || this.tick === 1;

        if (shouldCallAI && OPENAI_API_KEY) {
          this.lastAiCallTick = this.tick;
          const nearbyWps = [];
          for (let i = Math.max(0, this.wpIndex - 2); i < Math.min(this.waypoints.length, this.wpIndex + 15); i++) {
            nearbyWps.push({ idx: i, ...this.waypoints[i] });
          }

          try {
            this.aiDecision = await this.callAI({
              curLat, curLng, curHead,
              destLat: this.destLat, destLng: this.destLng,
              distToDest, wpIndex: this.wpIndex,
              nearbyWps,
            });
            this.aiCallCount++;
            const actionEmoji = { drive: '🚗', turn: '↩️', teleport: '🔀', arrived: '🏁' };
            this.onLog(`  🤖 AI#${this.aiCallCount}: ${actionEmoji[this.aiDecision.action] || '❓'} ${this.aiDecision.action} h=${this.aiDecision.heading}° | ${this.aiDecision.reason}`);
          } catch (aiErr) {
            // Fallback to deterministic
            const lookIdx = Math.min(this.wpIndex + 5, this.waypoints.length - 1);
            const fallbackBrg = Math.round(bearing(curLat, curLng, this.waypoints[lookIdx].lat, this.waypoints[lookIdx].lng));
            const fallbackAction = this.stuckCounter > 15 ? 'teleport' : 'drive';
            this.aiDecision = { heading: fallbackBrg, action: fallbackAction, reason: 'API失败，使用方向计算' };
            this.onLog(`  🔧 后备决策: ${fallbackAction} h=${fallbackBrg}° | ${this.aiDecision.reason}`);
          }
        }

        // Deterministic stuck fallback
        if (this.stuckCounter > 30 && (!this.aiDecision || this.aiDecision.action !== 'teleport')) {
          const tpIdx = Math.min(this.wpIndex + 10, this.waypoints.length - 1);
          this.aiDecision = { heading: curHead, action: 'teleport', teleport_idx: tpIdx, reason: '强制传送(stuck>30)' };
        }

        // Handle teleport
        if (this.aiDecision && this.aiDecision.action === 'teleport') {
          let tpIdx = this.aiDecision.teleport_idx || Math.min(this.wpIndex + 8, this.waypoints.length - 1);
          tpIdx = Math.max(0, Math.min(tpIdx, this.waypoints.length - 1));
          const tpWp = this.waypoints[tpIdx];
          this.onLog(`  🔀 传送: wp${tpIdx} (${tpWp.lat.toFixed(5)}, ${tpWp.lng.toFixed(5)}) h=${this.aiDecision.heading}°`);

          try {
            const tpUrl = makeStreetViewUrl(tpWp.lat, tpWp.lng, this.aiDecision.heading);
            await this.wc.loadURL(tpUrl);
            await sleep(3000);
            // Re-inject UI and hide Google chrome
            await this.wc.executeJavaScript(`
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
            `);
          } catch (tpErr) {
            this.onLog(`  ⚠️ 传送异常: ${tpErr.message?.slice(0, 100)}`);
          }
          this.lastNavLat = tpWp.lat;
          this.lastNavLng = tpWp.lng;
          this.stuckCounter = 0;
          if (tpIdx > this.wpIndex) this.wpIndex = tpIdx;
          this.aiDecision = null;
          continue;
        }

        // Deterministic heading correction
        const lookIdx = Math.min(this.wpIndex + 5, this.waypoints.length - 1);
        const targetBrg = Math.round(bearing(curLat, curLng, this.waypoints[lookIdx].lat, this.waypoints[lookIdx].lng));
        let angleDiff = targetBrg - curHead;
        if (angleDiff > 180) angleDiff -= 360;
        if (angleDiff < -180) angleDiff += 360;
        const absAngle = Math.abs(angleDiff);

        if (absAngle > 15) {
          const dragDir = angleDiff > 0 ? -1 : 1;
          const dragPx = Math.min(this.MAX_DRAG, Math.max(3, Math.round(absAngle * 0.2)));
          await this.cdpDrag(dragX - dragDir * dragPx, dragX + dragDir * dragPx, dragY);
          await sleep(20);
        }

        // Drive forward
        for (let i = 0; i < gear; i++) {
          await this.pressKey('Up');
          await sleep(15);
        }

        // Update gauges
        await this.wc.executeJavaScript(`
          if (window.__updateGauges) window.__updateGauges(${gear}, false);
        `).catch(() => {});

        // Update odometer
        const seg = haversine(this.prevLat, this.prevLng, curLat, curLng);
        if (seg < 0.5) this.odometer += seg;
        this.prevLat = curLat;
        this.prevLng = curLng;

        // Log & status update every 10 ticks
        if (this.tick % 10 === 0) {
          const remain = haversine(curLat, curLng, finalDest.lat, finalDest.lng);
          const stuckTag = this.stuckCounter > 5 ? ` stuck:${this.stuckCounter}` : '';
          this.onLog(`  🧭 tick ${this.tick} | wp ${this.wpIndex}/${this.waypoints.length} | h:${curHead.toFixed(0)}→brg${targetBrg}° Δ${angleDiff.toFixed(0)}° | odo:${this.odometer.toFixed(2)}km | dest:${remain.toFixed(1)}km${stuckTag}`);

          this.onStatus({
            type: 'progress',
            tick: this.tick,
            wpIndex: this.wpIndex,
            wpTotal: this.waypoints.length,
            lat: curLat,
            lng: curLng,
            heading: curHead,
            targetBrg,
            odometer: this.odometer,
            distToDest: remain,
            stuckCounter: this.stuckCounter,
            speed: this.targetSpeed,
          });

          // Update page HUD
          await this.wc.executeJavaScript(`
            if (window.__updateDistance) window.__updateDistance(${this.odometer});
            if (window.__addNavLog) window.__addNavLog('wp ${this.wpIndex}/${this.waypoints.length} | h:${curHead.toFixed(0)}→${targetBrg}° | ${this.odometer.toFixed(2)}km');
          `).catch(() => {});
        }

      } catch (err) {
        if (err.message?.includes('destroyed') || err.message?.includes('closed')) {
          this.onLog('  ⚠️ 页面已关闭');
          this.running = false;
          break;
        }
        this.onLog(`  ⚠️ tick ${this.tick} 异常: ${err.message?.slice(0, 100)}`);
      }

      await sleep(100);
    }

    this.onLog(`🏁 导航结束 | 总里程: ${this.odometer.toFixed(2)}km | AI调用: ${this.aiCallCount}次`);
  }

  // ========== Free Drive Loop ==========
  async freeDriveLoop() {
    while (this.running) {
      this.tick++;
      try {
        const keys = await this.wc.executeJavaScript(
          'window.__getKeys ? window.__getKeys() : { w: false, a: false, s: false, d: false }'
        );
        const gear = Math.round(this.targetSpeed / 20);
        const turning = keys.a || keys.d;
        const moving = keys.w;

        await this.wc.executeJavaScript(`
          if (window.__updateGauges) window.__updateGauges(${gear}, ${!moving && !turning});
        `).catch(() => {});

        if (moving) {
          const steps = turning ? 1 : gear;
          for (let i = 0; i < steps; i++) {
            await this.pressKey('Up');
            await sleep(15);
          }
        }
        if (keys.s) await this.pressKey('Down');

        if (keys.a || keys.d) {
          const vp = await this.getViewport();
          const dragX = vp.w / 2;
          const dragY = vp.h / 4;
          if (keys.a) await this.cdpDrag(dragX + this.MAX_DRAG, dragX - this.MAX_DRAG, dragY);
          if (keys.d) await this.cdpDrag(dragX - this.MAX_DRAG, dragX + this.MAX_DRAG, dragY);
        }
      } catch (err) {
        if (err.message?.includes('destroyed') || err.message?.includes('closed')) {
          this.running = false;
          break;
        }
      }

      await sleep(moving || turning ? 100 : 200);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
