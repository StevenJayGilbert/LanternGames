# Local LLM setup (Ollama)

Run LanternGames entirely on your own machine, with no API key and no per-turn cost. The trade-off is hardware: a recent laptop with 16+ GB of RAM (or a GPU) and a few GB of disk for the model.

This is the genuine $0 tier. Anthropic BYOK stays available alongside.

## TL;DR

```bash
# 1. install Ollama from ollama.com/download
# 2. pull the recommended model
ollama pull qwen3:14b

# 3. start the server with browser CORS allowed
OLLAMA_ORIGINS="*" ollama serve

# 4. in LanternGames, pick "Local (Ollama)" on the gate page, click Start
```

If `qwen3:14b` is too heavy for your machine, use `qwen3:8b` instead — see [Hardware sizing](#hardware-sizing) below.

---

## 1. Install Ollama

Download the installer for your OS from [ollama.com/download](https://ollama.com/download):

- **macOS** — `.dmg` installer; runs as a menu-bar app and auto-starts the server
- **Windows** — `.exe` installer; runs as a system service; CLI in PowerShell
- **Linux** — `curl -fsSL https://ollama.com/install.sh | sh` (or your distro's package manager)

Verify the install:

```bash
ollama --version
```

## 2. Pull a model

LanternGames defaults to **`qwen3:14b`** because it's the rare small open-weight model that handles tool calling reliably (roughly GPT-4 parity on practical evals — see [TASKS.md Phase 10](../TASKS.md) for the research notes).

```bash
ollama pull qwen3:14b
```

This downloads ~9 GB. It'll take a few minutes on a typical home connection.

If you're tight on RAM (see sizing below), use the 8B variant:

```bash
ollama pull qwen3:8b
```

You can pull both and switch in the gate.

### Hardware sizing

| Model         | Disk  | RAM (Q4) | Speed (M2 Pro / M3 Pro) | Speed (RTX 4070+) |
|---------------|-------|----------|-------------------------|-------------------|
| `qwen3:8b`    | ~5 GB | ~10 GB   | ~50 tok/s               | ~80–100 tok/s     |
| `qwen3:14b`   | ~9 GB | ~14 GB   | ~25–35 tok/s            | ~50–70 tok/s      |

For a typical narrator turn (~300 output tokens), expect:

- `qwen3:8b`: ~6 seconds per turn
- `qwen3:14b`: ~10 seconds per turn

Slow but playable. The 14B is meaningfully better at tool calling and staying in character; pick it if your machine can handle it.

## 3. Start the server with browser access enabled

LanternGames runs in the browser, and Ollama by default rejects browser requests because of CORS. You **must** start it with the `OLLAMA_ORIGINS` env var set.

### Quick start (foreground, terminal stays open)

**macOS / Linux:**

```bash
OLLAMA_ORIGINS="*" ollama serve
```

**Windows PowerShell:**

```powershell
$env:OLLAMA_ORIGINS = "*"; ollama serve
```

**Windows Command Prompt:**

```cmd
set OLLAMA_ORIGINS=*
ollama serve
```

The server listens on `http://localhost:11434` and prints requests as they come in. Leave the terminal open while you play.

### Persistent setup (recommended for daily use)

So you don't have to remember the env var every time.

**macOS** (Ollama runs as a launchd agent):

```bash
launchctl setenv OLLAMA_ORIGINS "*"
```

Then quit and relaunch the Ollama menu-bar app.

**Linux** (systemd service):

Edit `/etc/systemd/system/ollama.service` (or wherever Ollama installed it) and add to the `[Service]` section:

```ini
Environment="OLLAMA_ORIGINS=*"
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

**Windows** (Ollama service):

Set the env var system-wide via **System Properties → Environment Variables → New System Variable**:

- Name: `OLLAMA_ORIGINS`
- Value: `*`

Restart the Ollama service from Services.msc, or sign out and back in.

### Why the wildcard?

`OLLAMA_ORIGINS="*"` allows any origin. For tightening this down to just your dev URL or deployed domain, use a comma-separated list, e.g. `OLLAMA_ORIGINS="http://localhost:5173,https://lanterngames.example"`. The wildcard is fine on a personal dev machine; lock it down before exposing your machine to a network.

## 4. Verify the server is reachable

```bash
curl http://localhost:11434/v1/models
```

You should see JSON listing the models you've pulled. If you get "connection refused", `ollama serve` isn't running. If you get an HTML error page, something else is on port 11434.

## 5. Pick "Local (Ollama)" in LanternGames

1. Open LanternGames in your browser (the dev server URL or the deployed site).
2. On the gate page, click **Local (Ollama)**.
3. Leave the server URL as `http://localhost:11434` and the model as `qwen3:14b` (or change to `qwen3:8b`, etc.).
4. Click **Start**.

The first turn will be slow (~10–30 seconds) because Ollama loads the model into RAM/VRAM the first time. Subsequent turns run at the speeds in the sizing table above.

You can switch back to Anthropic any time using the **Switch provider** button in the game header.

---

## Troubleshooting

### "Couldn't reach Ollama" on the first turn

The most common cause is the CORS env var not being set. Check:

```bash
# from the terminal that started ollama serve, or any terminal:
echo $OLLAMA_ORIGINS    # macOS/Linux
$env:OLLAMA_ORIGINS     # PowerShell
```

If empty, restart `ollama serve` with the env var (see step 3). If you set it persistently, make sure the Ollama process actually restarted after the change — for macOS that means quitting the menu-bar app fully and reopening.

Other causes:

- `ollama serve` isn't running at all. Run it in a terminal and watch for the "Listening on 127.0.0.1:11434" line.
- Your firewall is blocking localhost connections (rare, but check VPN / corporate firewall).
- The browser is hitting `https://localhost:11434` (HTTPS) instead of `http://localhost:11434`. Force HTTP in the gate's URL field.

### "Model 'qwen3:14b' not found"

You haven't pulled it yet:

```bash
ollama pull qwen3:14b
```

To check what you have:

```bash
ollama list
```

### Slow first turn (then everything's fine)

Normal. Ollama lazy-loads the model into VRAM on first request. The model stays loaded until idle for ~5 minutes (configurable via `OLLAMA_KEEP_ALIVE`).

### Slow every turn

Either the model is too big for your machine and is paging to disk, or it's running on CPU instead of GPU. Check Ollama's logs (the terminal running `ollama serve`) — it'll mention "running on CPU" if there's no GPU. Switch to `qwen3:8b` for a meaningful speed improvement on RAM-constrained machines.

### "Conversation too long for the model's context"

Hit on a long session (50+ turns). LanternGames already trims its history but a runaway session can still hit the limit. Restart the session via the **Restart** button. The 32K context default in `OllamaClient` is generous; if you legitimately need more, edit the `numCtx` parameter in [OllamaClient.ts](../app/src/llm/OllamaClient.ts).

### Tool calls fail or arguments are malformed

Small models occasionally emit invalid JSON for tool arguments. LanternGames raises an `LLMError` and surfaces the message; in practice the model self-corrects on retry — just submit your command again. If a specific command fails repeatedly, the model is struggling with it; rephrase or switch to Anthropic for that session.

### NPC voices drift / characters break out of personality

A documented gap of small models versus Claude. Qwen3 holds one persona well per session but tends to lose definition past ~30 turns when juggling several NPCs. The STYLE_INSTRUCTIONS already nudge it to re-anchor on personality each turn; if it keeps slipping, switch to a fresh session.

### "I keep getting connection errors after my computer woke from sleep"

`ollama serve` sometimes needs a kick after sleep on macOS / Windows. Quit and restart the Ollama app, or `pkill ollama && OLLAMA_ORIGINS="*" ollama serve`.

---

## Other models

LanternGames sends standard OpenAI-format tool calls, so any model in Ollama's library that supports tool use should work — though most do it less reliably than Qwen3. If you want to experiment, change the model name in the gate form (you don't need to redeploy). Worth trying:

- **`llama3.1:8b`** — solid baseline; tool use is OK but more literal than Qwen3
- **`mistral-nemo:12b`** — good prose, tool use is hit-or-miss
- **`qwen3:30b-a3b`** (MoE) — faster than dense 14B at similar quality if you have 32+ GB RAM

Avoid models that don't list tool support on Ollama's library page; they'll either ignore the `tools` array or hallucinate calls.

---

## Cost comparison (rough)

| Provider          | First-turn latency | Per-turn cost      | Quality           |
|-------------------|--------------------|--------------------|-------------------|
| Anthropic (Claude Haiku) | ~2 s        | ~$0.005–0.02       | Excellent         |
| Anthropic (Claude Sonnet)| ~3 s        | ~$0.02–0.08        | Best              |
| Ollama qwen3:14b  | ~10 s              | $0                 | Good              |
| Ollama qwen3:8b   | ~6 s               | $0                 | Acceptable        |

Use Ollama for free unlimited play; switch to Anthropic for a polished session or when the local model frustrates.
