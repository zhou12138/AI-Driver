# AI Driver — Google Street View 自动驾驶模拟器

在 Google Street View 中体验 AI 驾驶！输入起点和终点，AI 自动规划路线并沿街景行驶。

![demo](src/assets/hero.png)

## 功能

- **AI + 确定性混合导航** — 双层路线矫正架构（详见下方）
- **自由驾驶** — WASD 手动控制，随意漫游 Street View
- **HUD 仪表盘** — 转速/速度仪表、速度滑块、WASD 按键指示、里程显示
- **双引擎路线** — 优先 Google Maps 路线，回退 OSRM
- **中文地名支持** — 输入「卡什」「安塔利亚机场」即可

## AI 如何辅助矫正路线

导航引擎采用 **确定性航向 + LLM 决策** 的双层混合架构，而非单纯依赖 AI：

```
每个 tick (~100ms)
│
├── 第一层：确定性航向修正 (每 tick 执行)
│   ├── 根据当前坐标 & 前方第 N 个航点，计算目标方位角 (bearing)
│   ├── 与当前朝向比较，得到偏差角 Δ
│   └── Δ > 15° → CDP 模拟鼠标拖拽转向 (拖拽像素 ∝ 偏差角)
│
└── 第二层：AI 战略决策 (每 20 ticks 调用一次 LLM)
    ├── 输入：当前坐标、朝向、目标、航点列表、卡住计数
    ├── AI 返回 JSON：{ action, heading, reason }
    │   ├── "drive"    → 方向大致正确，继续前进
    │   ├── "turn"     → 需要大幅转向
    │   ├── "teleport" → 卡住或偏离路线，跳转到某航点
    │   └── "arrived"  → 已到达终点
    └── 传送时：loadURL 新坐标 → 自动重新注入 HUD
```

### 为什么需要两层？

| 场景 | 仅靠确定性 | 仅靠 AI | 混合方案 |
|------|-----------|---------|---------|
| 直路微调 | ✅ 足够 | ❌ 延迟高、浪费 token | ✅ 确定性层处理 |
| 复杂路口 | ❌ 可能选错岔路 | ✅ 理解路况 | ✅ AI 修正航向 |
| 卡在死胡同 | ❌ 无法脱困 | ✅ 决定传送 | ✅ AI 决定传送目标 |
| API 不可用 | ✅ 仍能行驶 | ❌ 完全瘫痪 | ✅ 降级到纯确定性 |

### 关键参数

- **AI 调用间隔**：每 20 tick（~2 秒）调用一次，卡住时缩短到每 5 tick
- **航向修正阈值**：偏差 > 15° 才触发 CDP 拖拽转向
- **拖拽像素上限**：18px（避免单次转向过猛）
- **卡住检测**：连续 15+ tick 移动 < 2m → 标记 stuck，30+ tick → 强制传送
- **降级策略**：API 失败时自动回退到纯方位角计算，不中断行驶

## 架构

```
Electron (main process)
├── main.js          — 窗口管理、IPC、Google 路线抓取
├── nav-engine.js    — AI + 确定性混合导航引擎
├── helpers.js       — 地理工具 (geocode / OSRM / haversine)
└── preload.cjs      — contextBridge IPC 桥接

React (renderer)
├── ElectronApp.jsx  — Electron 版 UI (路线输入 / 速度控制 / 状态)
├── App.jsx          — 浏览器版 UI
└── main.jsx         — 入口 (自动检测 Electron 环境)

独立脚本
└── drive.mjs        — Playwright 版驾驶脚本 (无需 Electron)
```

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置 API
cp .env.example .env
# 编辑 .env，填入你的 LLM API Key

# 3. 启动 Electron 应用
npm run electron:dev
```

## 环境变量 (.env)

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENAI_API_KEY` | LLM API Key | — |
| `OPENAI_MODEL` | 模型名称 | `claude-haiku-4.5` |
| `OPENAI_BASE_URL` | API 端点 | `http://localhost:4000/v1` |

支持任何 OpenAI 兼容 API（LiteLLM、OpenRouter 等）。

## Playwright 版 (无 Electron)

```bash
node drive.mjs "费特希耶" "卡什"
```

使用 Playwright 启动浏览器，全自动驾驶。

## 操作

| 按键 | 功能 |
|------|------|
| `W` | 前进 |
| `A` / `D` | 左转 / 右转 |
| `S` | 后退 |
| `[` / `]` | 减速 / 加速 ±10 km/h |

## 技术栈

- **Electron 35** + **React 19** + **Vite 8**
- **CDP** (Chrome DevTools Protocol) 控制 Street View 视角
- **OSRM** / **Google Maps** 路线规划
- **Nominatim** 地理编码
- **LLM** (OpenAI 兼容) AI 驾驶决策

## License

MIT
