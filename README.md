# AI Driver — Google Street View 自动驾驶模拟器

在 Google Street View 中体验 AI 驾驶！输入起点和终点，AI 自动规划路线并沿街景行驶。

![demo](src/assets/hero.png)

## 功能

- **AI 导航** — LLM 实时分析路况，决策转向 / 前进 / 传送
- **确定性航向修正** — 每 tick 根据航点方位自动微调方向
- **自由驾驶** — WASD 手动控制，随意漫游 Street View
- **HUD 仪表盘** — 转速/速度仪表、速度滑块、WASD 按键指示、里程显示
- **双引擎路线** — 优先 Google Maps 路线，回退 OSRM
- **中文地名支持** — 输入「卡什」「安塔利亚机场」即可

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
