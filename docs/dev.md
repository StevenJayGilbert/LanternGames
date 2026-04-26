# Dev environment

Notes for running and debugging the project locally. Companion to [TASKS.md](../TASKS.md) (the roadmap) and [story-format.md](story-format.md) (the data format).

## Common commands

All run from `app/`:

```bash
npm run dev       # start dev server (port 5173 by default)
npm run build     # type-check + production bundle into app/dist/
npm run preview   # serve the production bundle locally
npm run lint      # ESLint
```

## Starting the dev server

```bash
cd app
npm run dev
```

Then open the URL it prints (default `http://localhost:5173/`). HMR is enabled, so edits to source files reload the page automatically.

## Stopping the dev server

In the terminal that's running it: press **Ctrl+C**.

If you don't have access to that terminal — for example the server was started by Claude in a background task, or a previous session orphaned the process — use one of these:

**Targeted (recommended):** kill only the process holding the Vite port.
```powershell
Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```
Replace `5173` with whichever port the server actually bound to.

**Nuclear:** kill every Node process. Use only if you don't have other Node apps running.
```powershell
Get-Process node | Stop-Process -Force
```

After cleanup, `npm run dev` again to restart on a clean port.

## Restarting cleanly

The fastest reliable sequence when something's misbehaving:

```powershell
Get-NetTCPConnection -LocalPort 5173,5174,5175 -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
cd app
npm run dev
```

The first line clears the ports Vite will try in order; the next two restart from a known state.

## Port quirks

Vite picks the first free port starting at 5173 and bumping by one. If you see the URL change to 5174, 5175, etc., it's because something (often an orphaned process from an earlier run) is still holding the lower-numbered port. The cleanup commands above sort it out.

## NODE_ENV=production gotcha (Windows)

This machine has `NODE_ENV=production` set somewhere in the process tree (not in user/system env vars — it's set by something in the VSCode/Claude Code launch chain). It causes two problems:

1. **`npm install` silently skips `devDependencies`** — you get an unusable project. Workaround: always install with `NODE_ENV=development npm install ...`, or add new packages with `npm install --save-dev --include=dev <pkg>`.
2. **Vite's React Fast Refresh runtime fails to initialize** — the page renders blank with a `$RefreshSig$ is not defined` error in the console. Already worked around by `cross-env` in the `dev` script: `cross-env NODE_ENV=development vite`.

`npm run dev` and `npm run build` are correct as-shipped. The only thing to remember is the `npm install` case when adding new packages.

## Type checking

Standalone, without building:

```bash
cd app
./node_modules/.bin/tsc -b --pretty
```

Silent output means everything passes.

## Project layout

```
app/
  src/
    llm/                  # LLMClient interface + DirectAnthropicClient
    story/                # Story format types + runtime validator
    stories/              # Bundled story JSON files (toy story, eventually Zork)
    App.tsx, main.tsx     # Top-level UI
  public/                 # Static assets served at /
  package.json
docs/
  dev.md                  # this file
  story-format.md         # story schema documentation
zil-to-json/              # cloned reference: pre-converted Infocom JSON
zork1-source/             # cloned reference: original Zork I ZIL source
TASKS.md                  # roadmap and decisions log
```

## Browser dev console

Phase 2's runtime validator logs to the browser console at app boot. To see it:

1. Open the dev server URL
2. Press **F12** to open DevTools
3. Switch to the **Console** tab
4. Look for `[story] hello-adventure ✓ valid` (or error lines if a story is malformed)

The console is also where any client-side `console.error`s, network failures, or React warnings will surface.
