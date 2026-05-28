import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './contexts/AuthContext.jsx'
import { TimeTravelProvider } from './contexts/TimeTravelContext.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <TimeTravelProvider>
        <App />
      </TimeTravelProvider>
    </AuthProvider>
  </StrictMode>,
)
