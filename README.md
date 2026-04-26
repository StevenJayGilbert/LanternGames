# LanternGames

A generic LLM-narrated text adventure engine. Players bring their own Anthropic API key (BYOK), or run locally via Ollama for free; stories are JSON files; the engine owns state and the LLM owns prose. Zork I is the first test story — proof that the engine and schema can host a real, complex adventure.

## Quickstart

```bash
cd app
npm install        # if NODE_ENV=production is set globally, prefix with: NODE_ENV=development
npm run dev        # http://localhost:5173/
```

Paste an Anthropic API key when prompted, pick a story, play. Get a key at [console.anthropic.com](https://console.anthropic.com) — it's separate from a Claude Pro/Max subscription.

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
