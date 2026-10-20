import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { syncSettingsFromBackend } from './lib/api'
import './index.css'

// Load the backend's settings first (gives up after 1.5 s when the backend is offline).
syncSettingsFromBackend().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
