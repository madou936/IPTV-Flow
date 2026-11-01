import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// No StrictMode on purpose: its double-invoked effects would spin up the
// mpegts/hls players twice in dev and fight over the <video> element.
createRoot(document.getElementById('root') as HTMLElement).render(<App />)
