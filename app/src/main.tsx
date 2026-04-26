import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import helloAdventure from './stories/hello-adventure.json'
import { validateStory } from './story/validate'
import { runEngineSmoke } from './engine/_smoke'

// Phase 2 smoke check: confirm the toy story passes runtime validation.
// Phase 3 smoke check: play through Hello Adventure end-to-end.
// Logs to dev console; does not block app boot.
{
  const result = validateStory(helloAdventure)
  if (result.ok) {
    console.info('[story] hello-adventure ✓ valid')
    runEngineSmoke()
  } else {
    console.error('[story] hello-adventure failed validation:')
    for (const e of result.errors) console.error(`  ${e.path}: ${e.message}`)
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
