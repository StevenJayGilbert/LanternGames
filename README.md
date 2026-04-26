# LanternGames

A generic LLM-narrated text adventure engine. Players bring their own Anthropic API key (BYOK), or run locally via Ollama for free; stories are JSON files; the engine owns state and the LLM owns prose. Zork I is the first test story — proof that the engine and schema can host a real, complex adventure.

## Running locally

The game runs entirely in your browser. There's no separate backend — the dev server (Vite) just serves the static page; LLM calls go from your browser straight to either Anthropic's API (BYOK mode) or your local Ollama process (free local mode).

### Prerequisites

You need three things on your machine before the first-time setup will work. If you've never set up a Node project before, install them in this order:

#### 1. Node.js 22+ (includes npm)

The Node.js installer bundles **npm**, the package manager used for `npm install` / `npm run dev` below. There's nothing to install separately for npm.

- **macOS** — installer from [nodejs.org/download](https://nodejs.org/en/download), or `brew install node` if you use [Homebrew](https://brew.sh/).
- **Windows** — installer from [nodejs.org/download](https://nodejs.org/en/download), or `winget install OpenJS.NodeJS.LTS` from PowerShell.
- **Linux** — installer from [nodejs.org/download](https://nodejs.org/en/download), or your distro's package (e.g. `sudo apt install nodejs npm`), or [nvm](https://github.com/nvm-sh/nvm) if you want to manage multiple Node versions.

#### 2. git

- **macOS** — `xcode-select --install` (also gets you Apple's basic dev tools), or `brew install git`.
- **Windows** — [Git for Windows](https://git-scm.com/downloads) installer (it bundles Git Bash, which is handy).
- **Linux** — `sudo apt install git` (Debian/Ubuntu) or your distro equivalent.

#### 3. *(Optional)* Ollama

Only needed if you want the free local-LLM tier. Full install + setup in [docs/local-llm.md](docs/local-llm.md). Short version: download the installer from [ollama.com/download](https://ollama.com/download) for any platform, or `brew install ollama` on Mac.

### Verify everything's on PATH

Open a fresh terminal and run:

```bash
node --version    # should print v22.x.x or higher
npm --version     # should print 10.x.x or higher (bundled with Node)
git --version     # should print any recent version
```

If any of those errors with "command not found", fix that install first before continuing.

If `npm --version` errors with "command not found" but `node --version` works, your Node install is broken (sometimes happens with stripped-down homebrew/scoop taps) — reinstall using the official installer from [nodejs.org](https://nodejs.org/en/download) instead.

### First-time setup

```bash
git clone git@github.com:StevenJayGilbert/LanternGames.git
cd LanternGames/app
npm install
```

If `npm install` finishes too fast and the project doesn't run afterwards, you've hit the `NODE_ENV=production` gotcha — see [docs/dev.md](docs/dev.md#nodeenvproduction-gotcha-windows) for the fix.

### Start the game

```bash
cd app
npm run dev
```

Opens at `http://localhost:5173/` (HMR enabled — source edits reload automatically).

On the gate page, pick a provider:

- **Anthropic** — paste an API key from [console.anthropic.com](https://console.anthropic.com). ~$5 of credits covers many hours of play. Separate from Claude Pro / Max subscriptions.
- **Local (Ollama)** — make sure `OLLAMA_ORIGINS="*" ollama serve` is running first. Full install/troubleshooting in [docs/local-llm.md](docs/local-llm.md).

### Full local mode (no internet, $0/turn)

Two terminals:

```bash
# terminal 1: the LLM
OLLAMA_ORIGINS="*" ollama serve

# terminal 2: the game
cd LanternGames/app && npm run dev
```

Open `http://localhost:5173/`, pick **Local (Ollama)** on the gate page. Your traffic never leaves your machine.

### Stopping

In the dev-server terminal, press **Ctrl+C**. For orphaned dev servers (terminal closed without stopping it first), see the cleanup commands in [docs/dev.md](docs/dev.md#stopping-the-dev-server).

### Production build

```bash
cd app
npm run build       # → app/dist/
npm run preview     # serves the built bundle to verify
```

The build output in `app/dist/` is a static site — drop it on any static host (Cloudflare Pages, Netlify, GitHub Pages, etc.). No backend needed; players supply their own API key or run Ollama themselves.

## Project layout

```
app/
  src/
    engine/       — state, actions, view, render, intent signals
    llm/          — LLMClient interface + DirectAnthropicClient + OllamaClient + Narrator
    story/        — schema + validator
    stories/      — bundled story JSON (hello-adventure, zork-1)
    persistence/  — localStorage save/load
  scripts/
    extract-zork.ts   — converts zil-to-json data into our story format
docs/
  story-format.md    — schema documentation
  dev.md             — dev environment notes (NODE_ENV gotcha, etc.)
TASKS.md             — roadmap and design decisions
```

## Reference repos (needed for `npm run extract:zork`)

These are upstream sources, gitignored from this repo. Clone them at the project root:

```bash
git clone https://github.com/zork-playground/zil-to-json.git
git clone https://github.com/historicalsource/zork1.git zork1-source
```

The Zork I story bundled in `app/src/stories/zork-1.json` was already extracted; you only need these to re-run the extractor.

## Status & roadmap

See [TASKS.md](TASKS.md) for phase-by-phase status, design decisions, and the schema-additions backlog.

## License

The engine code is yours to license as you choose. The bundled Zork I content derives from MIT-licensed source code released by Microsoft in November 2025; the "Zork" trademark is **not** licensed and remains with Microsoft / Activision. Any public release should run under a different product name and credit Infocom appropriately.
