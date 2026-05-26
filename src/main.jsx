import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ElectronApp from './ElectronApp.jsx'

const isElectron = !!(window.electronAPI?.isElectron)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isElectron ? <ElectronApp /> : <App />}
  </StrictMode>,
)
