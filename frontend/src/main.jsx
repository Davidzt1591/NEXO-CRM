import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/lato/latin-400.css'
import '@fontsource/lato/latin-700.css'
import '@fontsource/lato/latin-900.css'
import './index.css'
import './components/design-system/design-system.css'
import './features/conversations/conversations.css'
import App from './App.jsx'
import { ToastProvider } from './components/design-system/NexoPrimitives.jsx'
import './lib/authSession.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider><App /></ToastProvider>
  </StrictMode>,
)
