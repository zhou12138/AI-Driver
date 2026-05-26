import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

const images = [
  '116.312188,40.04680.jpg',
  '116.312188,40.04690.jpg',
  '116.312188,40.04700.jpg',
  '116.312188,40.04710.jpg',
  '116.312188,40.04720.jpg',
  '116.312188,40.04730.jpg',
  '116.312188,40.04740.jpg',
  '116.312088,40.04760.jpg',
  '116.311988,40.04770.jpg',
  '116.311988,40.04780.jpg',
  '116.311988,40.04790.jpg',
  '116.311988,40.04800.jpg',
  '116.311988,40.04820.jpg',
  '116.311988,40.04840.jpg',
  '116.311888,40.04850.jpg',
  '116.311588,40.04860.jpg',
  '116.311388,40.04870.jpg',
  '116.311488,40.04880.jpg',
]

const TRANSITION_MS = 4000

function smootherstep(t) {
  return t * t * t * (t * (6 * t - 15) + 10)
}

function gaussianWeight(dist, sigma) {
  return Math.exp(-(dist * dist) / (2 * sigma * sigma))
}

const MIN_KMH = 1
const MAX_KMH = 80

const BLEND_MODES = [
  { key: 'sharp', label: '清晰模式', desc: '只混合2帧，画面锐利' },
  { key: 'smooth', label: '柔和模式', desc: '多帧融合，过渡更绵密' },
]

function getCoordLabel(filename) {
  const name = filename.replace('.jpg', '')
  const [lng, lat] = name.split(',')
  return `经度 ${lng}  纬度 ${lat}`
}

// Steering wheel SVG component
function SteeringWheel({ angle }) {
  return (
    <svg className="steering-wheel" viewBox="0 0 300 300" style={{ transform: `rotate(${angle}deg)` }}>
      <defs>
        <linearGradient id="rimGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6a6a6a" />
          <stop offset="40%" stopColor="#3d3d3d" />
          <stop offset="100%" stopColor="#252525" />
        </linearGradient>
        <linearGradient id="rimHighlight" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
        <radialGradient id="hubGrad" cx="50%" cy="45%" r="50%">
          <stop offset="0%" stopColor="#777" />
          <stop offset="60%" stopColor="#444" />
          <stop offset="100%" stopColor="#2a2a2a" />
        </radialGradient>
        <radialGradient id="logoGrad" cx="50%" cy="40%" r="50%">
          <stop offset="0%" stopColor="#888" />
          <stop offset="100%" stopColor="#4a4a4a" />
        </radialGradient>
        <filter id="rimShadow">
          <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="rgba(0,0,0,0.6)" />
        </filter>
      </defs>
      {/* Outer rim - thick leather-style */}
      <circle cx="150" cy="150" r="130" fill="none" stroke="url(#rimGrad)" strokeWidth="24" filter="url(#rimShadow)" />
      {/* Rim top highlight */}
      <path d="M 40 100 A 130 130 0 0 1 260 100" fill="none" stroke="url(#rimHighlight)" strokeWidth="20" strokeLinecap="round" />
      {/* Rim inner edge */}
      <circle cx="150" cy="150" r="119" fill="none" stroke="rgba(90,90,90,0.5)" strokeWidth="1.5" />
      <circle cx="150" cy="150" r="141" fill="none" stroke="rgba(100,100,100,0.35)" strokeWidth="1.5" />

      {/* Left spoke */}
      <path d="M 70 170 Q 90 160 110 155 L 110 145 Q 90 140 70 130 Z"
        fill="url(#rimGrad)" stroke="rgba(80,80,80,0.3)" strokeWidth="0.5" />
      {/* Right spoke */}
      <path d="M 230 170 Q 210 160 190 155 L 190 145 Q 210 140 230 130 Z"
        fill="url(#rimGrad)" stroke="rgba(80,80,80,0.3)" strokeWidth="0.5" />
      {/* Bottom spoke */}
      <path d="M 140 190 Q 145 210 143 245 L 157 245 Q 155 210 160 190 Z"
        fill="url(#rimGrad)" stroke="rgba(80,80,80,0.3)" strokeWidth="0.5" />

      {/* Center hub */}
      <circle cx="150" cy="150" r="42" fill="url(#hubGrad)" stroke="rgba(120,120,120,0.5)" strokeWidth="2" />
      {/* Hub bevel ring */}
      <circle cx="150" cy="150" r="38" fill="none" stroke="rgba(140,140,140,0.3)" strokeWidth="1.5" />

      {/* Center logo area */}
      <circle cx="150" cy="150" r="20" fill="url(#logoGrad)" stroke="rgba(140,140,140,0.4)" strokeWidth="1.5" />
      {/* Logo lines (abstract car emblem) */}
      <path d="M 140 150 L 150 141 L 160 150 L 150 159 Z" fill="none" stroke="rgba(220,220,220,0.6)" strokeWidth="1.5" />
      <line x1="150" y1="141" x2="150" y2="159" stroke="rgba(220,220,220,0.4)" strokeWidth="1" />
      <line x1="140" y1="150" x2="160" y2="150" stroke="rgba(220,220,220,0.4)" strokeWidth="1" />

      {/* Thumb grips on rim (left & right textured areas) */}
      <path d="M 28 120 A 130 130 0 0 1 38 95" fill="none" stroke="rgba(100,100,100,0.25)" strokeWidth="16" strokeLinecap="round" />
      <path d="M 262 95 A 130 130 0 0 1 272 120" fill="none" stroke="rgba(100,100,100,0.25)" strokeWidth="16" strokeLinecap="round" />
    </svg>
  )
}

function App() {
  const [progress, setProgress] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speedKmh, setSpeedKmh] = useState(10)
  const [blendMode, setBlendMode] = useState('sharp')
  const rafRef = useRef(null)
  const lastTimeRef = useRef(null)
  const progressRef = useRef(0)
  const trackRef = useRef(null)
  const speedTrackRef = useRef(null)
  const speedDragging = useRef(false)
  const [steerAngle, setSteerAngle] = useState(0)
  const wheelDragging = useRef(false)
  const wheelStartX = useRef(0)
  const wheelStartAngle = useRef(0)

  const MAX_STEER = 45  // max steering angle in degrees
  const PAN_PER_DEGREE = 1.2  // percent of image width shift per degree

  const maxProgress = images.length - 1

  // Steering: combine drag angle with subtle idle oscillation
  const idleOsc = wheelDragging.current ? 0 : (Math.sin(progress * 1.8) * 4 + Math.sin(progress * 3.1) * 2)
  const wheelAngle = steerAngle + idleOsc
  const panOffset = -steerAngle * PAN_PER_DEGREE  // image shift %

  const animate = useCallback((timestamp) => {
    if (lastTimeRef.current === null) {
      lastTimeRef.current = timestamp
    }
    const delta = timestamp - lastTimeRef.current
    lastTimeRef.current = timestamp

    // 10m per image, speedKmh km/h → stepPerMs = speedKmh / 36000
    const stepPerMs = speedKmh / 36000

    let next = progressRef.current + delta * stepPerMs
    if (next >= maxProgress) {
      next = 0
    }
    progressRef.current = next
    setProgress(next)

    rafRef.current = requestAnimationFrame(animate)
  }, [speedKmh, maxProgress])

  useEffect(() => {
    if (playing) {
      lastTimeRef.current = null
      rafRef.current = requestAnimationFrame(animate)
    } else {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [playing, animate])

  const handleTrackClick = (e) => {
    const rect = trackRef.current.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const newProgress = ratio * maxProgress
    progressRef.current = newProgress
    setProgress(newProgress)
    lastTimeRef.current = null
  }

  const updateSpeedFromX = (clientX) => {
    const rect = speedTrackRef.current.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    setSpeedKmh(Math.round(MIN_KMH + ratio * (MAX_KMH - MIN_KMH)))
    lastTimeRef.current = null
  }

  const handleSpeedTrackDown = (e) => {
    speedDragging.current = true
    updateSpeedFromX(e.clientX)
  }

  useEffect(() => {
    const handleMove = (e) => {
      if (speedDragging.current) updateSpeedFromX(e.clientX)
      if (wheelDragging.current) {
        const dx = e.clientX - wheelStartX.current
        const newAngle = Math.max(-MAX_STEER, Math.min(MAX_STEER, wheelStartAngle.current + dx * 0.4))
        setSteerAngle(newAngle)
      }
    }
    const handleUp = () => {
      speedDragging.current = false
      if (wheelDragging.current) {
        wheelDragging.current = false
        // Spring back to center
        setSteerAngle(0)
      }
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [])

  // --- Render layers based on blend mode ---
  const baseIndex = Math.floor(progress)
  const nextIndex = Math.min(baseIndex + 1, images.length - 1)
  const rawBlend = progress - baseIndex
  const blend = smootherstep(rawBlend)

  const imgStyle = { transform: `translateX(${panOffset}%)` }
  let layerElements
  if (blendMode === 'sharp') {
    // Sharp: only 2 frames, bottom at full opacity
    layerElements = (
      <>
        {baseIndex !== nextIndex && (
          <div className="layer" style={{ opacity: 1, zIndex: 0 }}>
            <img src={`/${images[nextIndex]}`} alt="" style={imgStyle} />
          </div>
        )}
        <div className="layer" style={{ opacity: 1 - blend, zIndex: 1 }}>
          <img src={`/${images[baseIndex]}`} alt="" style={imgStyle} />
        </div>
      </>
    )
  } else {
    // Smooth: gaussian multi-frame blending
    const sigma = 0.4 + (speedKmh / 80) * 0.35
    const layers = []
    let totalWeight = 0
    for (let i = 0; i < images.length; i++) {
      const dist = Math.abs(progress - i)
      if (dist < sigma * 3) {
        const w = gaussianWeight(dist, sigma)
        layers.push({ index: i, weight: w })
        totalWeight += w
      }
    }
    layers.forEach(l => { l.opacity = l.weight / totalWeight })
    layerElements = layers.map((l, i) => (
      <div key={l.index} className="layer" style={{ opacity: l.opacity, zIndex: i }}>
        <img src={`/${images[l.index]}`} alt="" style={imgStyle} />
      </div>
    ))
  }

  const labelIndex = blend < 0.5 ? baseIndex : nextIndex
  const coordText = getCoordLabel(images[labelIndex])

  return (
    <div className="viewer">
      {/* Street view images */}
      <div className="perspective-stage">
        {layerElements}
      </div>

      {/* === Cockpit overlay === */}
      <div className="cockpit">
        {/* Windshield frame: A-pillars + roof + bottom */}
        <div className="pillar pillar-left" />
        <div className="pillar pillar-right" />
        <div className="cockpit-roof" />
        <div className="cockpit-hood" />
        {/* Rearview mirror */}
        <div className="rearview-mirror">
          <div className="mirror-glass" />
        </div>
        {/* Windshield vignette */}
        <div className="vignette" />
      </div>

      {/* Dashboard area */}
      <div className="dashboard-area">
        <div
          className="wheel-wrapper"
          onMouseDown={(e) => {
            wheelDragging.current = true
            wheelStartX.current = e.clientX
            wheelStartAngle.current = steerAngle
            e.preventDefault()
          }}
          style={{ cursor: wheelDragging.current ? 'grabbing' : 'grab' }}
        >
          <SteeringWheel angle={wheelAngle} />
          <div className="wheel-speed" style={{ transform: `rotate(${-wheelAngle}deg)` }}>
            <span className="wheel-speed-value">{speedKmh}</span>
            <span className="wheel-speed-unit">KM/H</span>
          </div>
        </div>
      </div>

      {/* HUD info */}
      <div className="hud-top">
        <div className="title">街景 180° 驾驶漫游</div>
        <div className="coord-label">{coordText}</div>
      </div>

      {/* Controls panel */}
      <div className="controls-panel">
        {/* Blend mode toggle */}
        <div className="blend-toggle">
          {BLEND_MODES.map(m => (
            <button
              key={m.key}
              className={`blend-btn ${blendMode === m.key ? 'active' : ''}`}
              onClick={() => setBlendMode(m.key)}
              title={m.desc}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Progress bar */}
        <div className="progress-track" ref={trackRef} onClick={handleTrackClick}>
          <div className="progress-fill" style={{ width: `${(progress / maxProgress) * 100}%` }} />
          <div className="progress-dots">
            {images.map((_, i) => (
              <span
                key={i}
                className={`progress-dot ${i <= Math.round(progress) ? 'active' : ''}`}
              />
            ))}
          </div>
        </div>

        {/* Bottom row: play + speed slider */}
        <div className="controls-row">
          <button className="play-btn" onClick={() => setPlaying(p => !p)}>
            {playing ? '❚❚' : '▶'}
          </button>
          <span className="speed-label">🏎️</span>
          <div className="speed-track" ref={speedTrackRef} onMouseDown={handleSpeedTrackDown}>
            <div className="speed-fill" style={{ width: `${((speedKmh - MIN_KMH) / (MAX_KMH - MIN_KMH)) * 100}%` }} />
            <div className="speed-thumb" style={{ left: `${((speedKmh - MIN_KMH) / (MAX_KMH - MIN_KMH)) * 100}%` }} />
          </div>
          <span className="speed-label-text">{speedKmh} km/h</span>
        </div>
      </div>
    </div>
  )
}

export default App
