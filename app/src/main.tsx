import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { isTauri } from '@tauri-apps/api/core'
import { info as logInfo, warn as logWarn, error as logError } from '@tauri-apps/plugin-log'
import './index.css'
import App from './App.tsx'
import helloAdventure from './stories/hello-adventure.json'
import { validateStory } from './story/validate'
import { runEngineSmoke } from './engine/_smoke'

// In the Tauri desktop build, mirror console output into the Rust log plugin
// so every diagnostic also lands in the on-disk log file (OS log dir). A
// tester who hits a bug can just send that file — no DevTools needed.
if (isTauri()) {
  const fmt = (args: unknown[]) =>
    args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const forward = (
    name: 'log' | 'info' | 'warn' | 'error',
    logger: (m: string) => Promise<void>,
  ) => {
    const original = console[name].bind(console)
    console[name] = (...args: unknown[]) => {
      original(...args)
      void logger(fmt(args))
    }
  }
  forward('log', logInfo)
  forward('info', logInfo)
  forward('warn', logWarn)
  forward('error', logError)
}

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
