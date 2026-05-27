// Preload script (must be CommonJS for Electron contextBridge)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Geocoding
  geocode: (query) => ipcRenderer.invoke('geo:code', query),

  // Route planning
  planRoute: (params) => ipcRenderer.invoke('nav:plan', params),

  // Start navigation
  startNavigation: (params) => ipcRenderer.invoke('nav:start', params),

  // Free drive
  freeDrive: (params) => ipcRenderer.invoke('nav:freeDrive', params),

  // Speed control
  setSpeed: (speed) => ipcRenderer.invoke('nav:setSpeed', speed),

  // Stop
  stop: () => ipcRenderer.invoke('nav:stop'),

  // Open route details in browser
  openExternal: (url) => ipcRenderer.invoke('sys:openExternal', url),

  // Show/hide embedded route details page in Electron BrowserView
  showRouteDetails: (url) => ipcRenderer.invoke('route:showDetails', url),
  hideRouteDetails: () => ipcRenderer.invoke('route:hideDetails'),

  // Listen for status updates from main process
  onStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('nav:status', handler);
    return () => ipcRenderer.removeListener('nav:status', handler);
  },

  // Listen for log messages
  onLog: (callback) => {
    const handler = (_event, msg) => callback(msg);
    ipcRenderer.on('nav:log', handler);
    return () => ipcRenderer.removeListener('nav:log', handler);
  },

  // Check if running in Electron
  isElectron: true,
});
