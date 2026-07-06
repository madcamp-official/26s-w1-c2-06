import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'galmuri/dist/galmuri.css'
import '@fontsource/press-start-2p/400.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
