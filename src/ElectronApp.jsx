import { useState, useEffect, useRef } from 'react';

// Detect Electron environment
const isElectron = !!(window.electronAPI?.isElectron);
const api = window.electronAPI || {};

export default function ElectronApp() {
  const [mode, setMode] = useState('setup'); // setup | planning | preview | driving
  const [from, setFrom] = useState('Flagstaff, Coconino County, Arizona, United States');
  const [to, setTo] = useState('Logan County, Illinois, United States');
  const [fromGeo, setFromGeo] = useState(null);
  const [toGeo, setToGeo] = useState(null);
  const [routeInfo, setRouteInfo] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);
  const [speed, setSpeed] = useState(60);
  const [logs, setLogs] = useState([]);
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const [showingDetails, setShowingDetails] = useState(false);
  const [shouldAutoOpenDetails, setShouldAutoOpenDetails] = useState(false);
  const logRef = useRef(null);

  const routeOptions = routeInfo?.routeOptions || [];
  const selectedRoute = routeOptions.find(r => r.id === selectedRouteId) || routeOptions[0] || null;

  // Listen for nav status updates
  useEffect(() => {
    if (!isElectron) return;
    const unsub1 = api.onStatus((s) => {
      setStatus(s);
      if (s.type === 'arrived') setMode('arrived');
    });
    const unsub2 = api.onLog((msg) => {
      setLogs(prev => [msg, ...prev].slice(0, 50));
    });
    return () => { unsub1(); unsub2(); };
  }, []);

  useEffect(() => {
    // Auto-hide details when leaving preview mode.
    if (mode !== 'preview' && showingDetails && api.hideRouteDetails) {
      api.hideRouteDetails().catch(() => {});
      setShowingDetails(false);
    }
  }, [mode, showingDetails]);

  useEffect(() => {
    // Auto-open details once when route planning enters preview mode.
    if (mode !== 'preview' || !shouldAutoOpenDetails) return;
    if (!selectedRoute?.detailsUrl || !api.showRouteDetails) {
      setShouldAutoOpenDetails(false);
      return;
    }
    api.showRouteDetails(selectedRoute.detailsUrl)
      .then(() => setShowingDetails(true))
      .catch((e) => setError(`无法打开路线详情: ${e.message}`))
      .finally(() => setShouldAutoOpenDetails(false));
  }, [mode, shouldAutoOpenDetails, selectedRoute]);

  useEffect(() => {
    // When details pane is open, switching route option refreshes the embedded page.
    if (mode !== 'preview' || !showingDetails || !selectedRoute?.detailsUrl || !api.showRouteDetails) return;
    api.showRouteDetails(selectedRoute.detailsUrl).catch((e) => {
      setError(`无法切换路线详情: ${e.message}`);
    });
  }, [mode, showingDetails, selectedRoute]);

  const handleGeocode = async () => {
    if (!from.trim() || !to.trim()) {
      setError('请输入起点和终点');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const [fg, tg] = await Promise.all([
        api.geocode(from),
        api.geocode(to),
      ]);
      if (!fg) { setError(`找不到起点: ${from}`); setLoading(false); return; }
      if (!tg) { setError(`找不到终点: ${to}`); setLoading(false); return; }
      setFromGeo(fg);
      setToGeo(tg);

      // Plan route
      setMode('planning');
      console.log('📡 Calling planRoute...');
      const route = await api.planRoute({
        fromName: fg.name, fromLat: fg.lat, fromLng: fg.lng,
        toName: tg.name, toLat: tg.lat, toLng: tg.lng,
      });
      console.log('📦 planRoute returned:', route ? `${route.waypointCount} waypoints` : 'null');

      if (!route || route.error) {
        setError(route?.error || '路线规划失败');
        setShouldAutoOpenDetails(false);
        setMode('setup');
      } else {
        setRouteInfo(route);
        setSelectedRouteId(route.selectedOptionId || route.routeOptions?.[0]?.id || '');
        setShowingDetails(false);
        setShouldAutoOpenDetails(true);
        setMode('preview');
      }
    } catch (e) {
      setError(e.message);
      setShouldAutoOpenDetails(false);
      setMode('setup');
    }
    setLoading(false);
  };

  const handleSwapEndpoints = () => {
    const prevFrom = from;
    const prevTo = to;
    const prevFromGeo = fromGeo;
    const prevToGeo = toGeo;
    setFrom(prevTo);
    setTo(prevFrom);
    setFromGeo(prevToGeo);
    setToGeo(prevFromGeo);
    setError('');
  };

  const handleStartDriving = async () => {
    if (!routeInfo) return;
    const routeToUse = selectedRoute || routeInfo;
    if (showingDetails && api.hideRouteDetails) {
      await api.hideRouteDetails().catch(() => {});
      setShowingDetails(false);
    }
    setMode('driving');
    setLogs([]);
    try {
      const heading = 90; // will be calculated by engine
      await api.startNavigation({
        waypoints: routeToUse.waypoints,
        destName: toGeo.name,
        destLat: toGeo.lat,
        destLng: toGeo.lng,
        startHeading: heading,
      });
    } catch (e) {
      setError(e.message);
    }
  };

  const handleFreeDrive = async () => {
    setMode('driving');
    setLogs([]);
    const lat = fromGeo?.lat || 36.212413;
    const lng = fromGeo?.lng || 29.4832002;
    try {
      await api.freeDrive({ lat, lng, heading: 90 });
    } catch (e) {
      setError(e.message);
    }
  };

  const handleStop = async () => {
    if (api.hideRouteDetails) {
      await api.hideRouteDetails().catch(() => {});
    }
    setShowingDetails(false);
    await api.stop();
    setMode('setup');
    setStatus(null);
  };

  const handleSpeedChange = (newSpeed) => {
    setSpeed(newSpeed);
    api.setSpeed(newSpeed);
  };

  const handleOpenRouteDetails = async () => {
    if (!selectedRoute?.detailsUrl) return;
    try {
      if (showingDetails) {
        if (api.hideRouteDetails) {
          await api.hideRouteDetails();
          setShowingDetails(false);
        }
        return;
      }
      if (api.showRouteDetails) {
        await api.showRouteDetails(selectedRoute.detailsUrl);
        setShowingDetails(true);
        return;
      }
      if (api.openExternal) {
        await api.openExternal(selectedRoute.detailsUrl);
      }
    } catch (e) {
      setError(`无法打开路线详情: ${e.message}`);
    }
  };

  // Not in Electron — show fallback
  if (!isElectron) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h2 style={styles.title}>🚗 Street View Drive</h2>
          <p style={{ color: '#888' }}>
            请使用 <code>npm run electron:dev</code> 启动 Electron 应用，
            或使用 <code>node drive.mjs</code> 运行 Playwright 版本。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Top Control Bar */}
      <div style={styles.topBar}>
        <span style={styles.logo}>🚗 Street View Drive</span>

        {mode === 'setup' && (
          <div style={styles.inputRow}>
            <input
              style={styles.input}
              placeholder="起点 (如: 卡什)"
              value={from}
              onChange={e => setFrom(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleGeocode()}
            />
            <button
              style={styles.swapBtn}
              onClick={handleSwapEndpoints}
              title="交换起点和终点"
              aria-label="交换起点和终点"
            >
              ⇄
            </button>
            <input
              style={styles.input}
              placeholder="终点 (如: Antalya Airport)"
              value={to}
              onChange={e => setTo(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleGeocode()}
            />
            <button style={styles.btn} onClick={handleGeocode} disabled={loading}>
              {loading ? '⏳' : '🔍 规划路线'}
            </button>
            <button style={{ ...styles.btn, ...styles.btnSecondary }} onClick={handleFreeDrive}>
              🚗 自由驾驶
            </button>
          </div>
        )}

        {mode === 'planning' && (
          <span style={styles.statusText}>⏳ 正在规划路线...</span>
        )}

        {mode === 'preview' && routeInfo && (
          <div style={styles.inputRow}>
            <span style={styles.routeInfo}>
              📍 {selectedRoute?.source || routeInfo.source} | {selectedRoute?.distanceKm || routeInfo.distanceKm} km | {selectedRoute?.waypointCount || routeInfo.waypointCount} 航点
            </span>
            {routeOptions.length > 0 && (
              <select
                style={styles.routeSelect}
                value={selectedRoute?.id || ''}
                onChange={(e) => setSelectedRouteId(e.target.value)}
              >
                {routeOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label} | {opt.distanceKm}km | {opt.durationMin}min
                  </option>
                ))}
              </select>
            )}
            <button style={{ ...styles.btn, ...styles.btnSecondary }} onClick={handleOpenRouteDetails}>
              {showingDetails ? '✕ 关闭详情' : '🗺 详情页'}
            </button>
            <button style={{ ...styles.btn, ...styles.btnGreen }} onClick={handleStartDriving}>
              ▶ 开始导航
            </button>
            <button style={{ ...styles.btn, ...styles.btnSecondary }} onClick={() => setMode('setup')}>
              ✕ 取消
            </button>
          </div>
        )}

        {(mode === 'driving' || mode === 'arrived') && (
          <div style={styles.inputRow}>
            <span style={styles.statusText}>
              {mode === 'arrived' ? '🏁 已到达！' : '🤖 导航中'}
            </span>
            {status && (
              <span style={styles.routeInfo}>
                wp {status.wpIndex}/{status.wpTotal} | {status.odometer?.toFixed(1)} km | dest:{status.distToDest?.toFixed(1)}km
              </span>
            )}
            <div style={styles.speedControl}>
              <button style={styles.speedBtn} onClick={() => handleSpeedChange(Math.max(0, speed - 10))}>−</button>
              <span style={styles.speedValue}>{speed} km/h</span>
              <button style={styles.speedBtn} onClick={() => handleSpeedChange(Math.min(200, speed + 10))}>+</button>
            </div>
            <button style={{ ...styles.btn, ...styles.btnRed }} onClick={handleStop}>
              ■ 停止
            </button>
          </div>
        )}

        {error && <span style={styles.error}>{error}</span>}
      </div>
    </div>
  );
}

const styles = {
  container: {
    width: '100%',
    height: '100vh',
    background: '#1a1a1a',
    color: '#fff',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    margin: 0,
    padding: 0,
  },
  topBar: {
    height: '52px',
    background: 'linear-gradient(180deg, #2a2a2a, #222)',
    borderBottom: '1px solid #444',
    display: 'flex',
    alignItems: 'center',
    padding: '0 16px',
    gap: '12px',
    zIndex: 100,
  },
  logo: {
    fontWeight: 'bold',
    fontSize: '14px',
    color: '#0f0',
    whiteSpace: 'nowrap',
  },
  inputRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flex: 1,
  },
  input: {
    background: '#333',
    border: '1px solid #555',
    borderRadius: '4px',
    color: '#fff',
    padding: '6px 10px',
    fontSize: '13px',
    flex: 1,
    maxWidth: '220px',
    outline: 'none',
  },
  arrow: {
    color: '#888',
    fontSize: '16px',
  },
  swapBtn: {
    background: '#2f2f2f',
    border: '1px solid #555',
    borderRadius: '4px',
    color: '#ddd',
    width: '32px',
    height: '32px',
    cursor: 'pointer',
    fontSize: '15px',
    lineHeight: '1',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btn: {
    background: '#0066cc',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    padding: '6px 14px',
    fontSize: '13px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontWeight: 'bold',
  },
  btnGreen: {
    background: '#0a7a0a',
  },
  btnRed: {
    background: '#c00',
  },
  btnSecondary: {
    background: '#555',
  },
  statusText: {
    color: '#0f0',
    fontSize: '13px',
    fontWeight: 'bold',
  },
  routeInfo: {
    color: '#aaa',
    fontSize: '12px',
    fontFamily: "'Courier New', monospace",
  },
  routeSelect: {
    background: '#2e2e2e',
    border: '1px solid #555',
    borderRadius: '4px',
    color: '#fff',
    padding: '6px 8px',
    fontSize: '12px',
    minWidth: '260px',
    outline: 'none',
  },
  error: {
    color: '#f44',
    fontSize: '12px',
    marginLeft: 'auto',
  },
  speedControl: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    background: '#333',
    borderRadius: '4px',
    padding: '2px 6px',
  },
  speedBtn: {
    background: 'none',
    border: '1px solid #666',
    borderRadius: '3px',
    color: '#fff',
    width: '24px',
    height: '24px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 'bold',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedValue: {
    color: '#0f0',
    fontFamily: "'Courier New', monospace",
    fontSize: '13px',
    minWidth: '60px',
    textAlign: 'center',
  },
  card: {
    background: '#222',
    borderRadius: '12px',
    padding: '30px',
    maxWidth: '500px',
    margin: '100px auto',
    textAlign: 'center',
  },
  title: {
    margin: '0 0 16px',
    color: '#0f0',
  },
};
