import { useEffect, useMemo, useRef, useState } from "react";
import { Engine } from "./engine/engine";
import { currentRoomId, PLAYER_ITEM_ID } from "./engine/state";
import { renderRoomView } from "./engine/render";
import { DirectAnthropicClient } from "./llm/DirectAnthropicClient";
import { OllamaClient } from "./llm/OllamaClient";
import { OpenAICompatibleClient } from "./llm/OpenAICompatibleClient";
import { OPENAI_COMPAT_PRESETS } from "./llm/providers";
import type { LLMClient } from "./llm/types";
import { Narrator } from "./llm/narrator";
import {
  clearSession,
  loadSession,
  migrateLegacySaveToSlots,
  saveSession,
  type SaveSlot,
  type TranscriptEntry,
} from "./persistence/localSave";
import { SaveLoadDialog } from "./SaveLoadDialog";
import { DEFAULT_STORY_ID, STORIES, findStory } from "./stories";
import "./App.css";

type Provider = "anthropic" | "openai" | "xai" | "gemini" | "ollama";
// Every provider except Ollama is a BYOK (bring-your-own-key) provider.
type ByokProvider = Exclude<Provider, "ollama">;

const ALL_PROVIDERS: Provider[] = ["anthropic", "openai", "xai", "gemini", "ollama"];

// Pre-multi-provider builds stored the (Anthropic) key under this single key.
// It's migrated into the per-provider anthropic slot on first load.
const LEGACY_KEY_STORAGE = "lanterngames_api_key";
const STORY_STORAGE = "lanterngames_story_id";
const PROVIDER_STORAGE = "lanterngames_provider";
const OLLAMA_URL_STORAGE = "lanterngames_ollama_url";
const OLLAMA_MODEL_STORAGE = "lanterngames_ollama_model";
const OLLAMA_READY_STORAGE = "lanterngames_ollama_ready";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.1:8b";

// True under `vite dev` / `tauri dev`; false in production builds (`vite build`,
// i.e. the shipped desktop app). Gates dev-only affordances — the Debug
// slash-command button and the slash-command intercept.
const DEV = import.meta.env.DEV;

// Per-provider BYOK key storage — each provider keeps its own key.
function keyStorageKey(p: Provider): string {
  return `lanterngames_key_${p}`;
}

// UI copy + key-format hints per BYOK provider. Anthropic and xAI reach their
// APIs browser-direct; OpenAI and Gemini are CORS-blocked in a browser and
// only work in the desktop build — the picker hint says so.
const BYOK_META: Record<
  ByokProvider,
  { label: string; pickerHint: string; placeholder: string; consoleUrl: string; consoleLabel: string }
> = {
  anthropic: {
    label: "Anthropic (BYOK)",
    pickerHint: "Claude Haiku 4.5. Bring your own API key.",
    placeholder: "sk-ant-...",
    consoleUrl: "https://console.anthropic.com",
    consoleLabel: "console.anthropic.com",
  },
  openai: {
    label: "OpenAI / ChatGPT (BYOK)",
    pickerHint: "GPT-5.4 mini. Bring your own API key.",
    placeholder: "sk-...",
    consoleUrl: "https://platform.openai.com/api-keys",
    consoleLabel: "platform.openai.com",
  },
  xai: {
    label: "xAI Grok (BYOK)",
    pickerHint: "Grok 4.1 Fast. Bring your own API key.",
    placeholder: "xai-...",
    consoleUrl: "https://console.x.ai",
    consoleLabel: "console.x.ai",
  },
  gemini: {
    label: "Google Gemini (BYOK)",
    pickerHint: "Gemini 3 Flash. Bring your own API key.",
    placeholder: "AIza...",
    consoleUrl: "https://aistudio.google.com/apikey",
    consoleLabel: "aistudio.google.com",
  },
};

function loadProvider(): Provider {
  const stored = localStorage.getItem(PROVIDER_STORAGE);
  return ALL_PROVIDERS.includes(stored as Provider) ? (stored as Provider) : "anthropic";
}

// One-time legacy-save migration. Runs before the App component mounts so
// every loadSession/loadSlot call below sees the new key layout. Idempotent.
for (const s of STORIES) migrateLegacySaveToSlots(s.id);

// One-time: migrate the pre-multi-provider single API-key entry into the
// per-provider anthropic slot. Idempotent.
{
  const legacy = localStorage.getItem(LEGACY_KEY_STORAGE);
  if (legacy && !localStorage.getItem(keyStorageKey("anthropic"))) {
    localStorage.setItem(keyStorageKey("anthropic"), legacy);
  }
}

// TranscriptEntry + EntryKind types are imported from localSave so the save
// shape and the in-memory shape stay aligned automatically.

function App() {
  const [storyId, setStoryId] = useState<string>(() => {
    const saved = localStorage.getItem(STORY_STORAGE);
    return findStory(saved)?.id ?? DEFAULT_STORY_ID;
  });
  const story = useMemo(() => findStory(storyId) ?? STORIES[0], [storyId]);

  const [provider, setProvider] = useState<Provider>(loadProvider);
  // The API key for the currently selected provider. Reloaded on provider
  // change so each BYOK provider keeps its own key.
  const [apiKey, setApiKey] = useState<string>(
    () => localStorage.getItem(keyStorageKey(loadProvider())) ?? "",
  );
  const [keyDraft, setKeyDraft] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState<string>(
    () => localStorage.getItem(OLLAMA_URL_STORAGE) ?? DEFAULT_OLLAMA_URL,
  );
  const [ollamaModel, setOllamaModel] = useState<string>(
    () => localStorage.getItem(OLLAMA_MODEL_STORAGE) ?? DEFAULT_OLLAMA_MODEL,
  );
  // Drafts for the gate form. Initialized from persisted values so a user
  // returning after clicking "Reset config" sees their last URL/model.
  const [ollamaUrlDraft, setOllamaUrlDraft] = useState<string>(
    () => localStorage.getItem(OLLAMA_URL_STORAGE) ?? DEFAULT_OLLAMA_URL,
  );
  const [ollamaModelDraft, setOllamaModelDraft] = useState<string>(
    () => localStorage.getItem(OLLAMA_MODEL_STORAGE) ?? DEFAULT_OLLAMA_MODEL,
  );
  // The Ollama gate is "passed" once the user clicks Start at least once.
  // Without this flag, defaults would auto-pass the gate which prevents the
  // first-time user from seeing the URL/model setup hint.
  const [ollamaReady, setOllamaReady] = useState<boolean>(
    () => localStorage.getItem(OLLAMA_READY_STORAGE) === "true",
  );
  // Initial engine: restore quick-save if any. Otherwise fresh.
  const [engine, setEngine] = useState(() => {
    const saved = loadSession(story.id, "quick");
    return new Engine(story, saved?.engineState);
  });
  const [narrator, setNarrator] = useState<Narrator | null>(null);

  const [transcript, setTranscript] = useState<TranscriptEntry[]>(() => {
    const saved = loadSession(story.id, "quick");
    if (saved && saved.transcript.length > 0) return saved.transcript;
    return buildIntro(engine, !!saved);
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Set while a turn is paused on a rate-limit retry, so the loading indicator
  // can tell the player the turn is waiting and will continue on its own.
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(
    () => loadSession(story.id, "quick")?.inputHistory ?? [],
  );
  const [historyIndex, setHistoryIndex] = useState(-1);
  // Dev debug mode: when on, slash commands (/tp, /give, /help) are intercepted
  // before reaching the narrator. Persisted across reloads. Off by default.
  const [debugMode, setDebugMode] = useState<boolean>(
    () => localStorage.getItem("lanterngames_debug") === "true",
  );
  // The narrator picker, opened on demand via the "Model" header button as a
  // cancelable config screen. configSnapshot holds the pre-open config so
  // closeModelConfig can restore it if the player backs out.
  const [modelConfigOpen, setModelConfigOpen] = useState(false);
  const [configSnapshot, setConfigSnapshot] = useState<{
    provider: Provider;
    apiKey: string;
    ollamaUrl: string;
    ollamaModel: string;
    ollamaReady: boolean;
  } | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Persist story choice.
  useEffect(() => {
    localStorage.setItem(STORY_STORAGE, storyId);
  }, [storyId]);

  // Recreate engine + transcript when the story changes. Restore quick-save
  // for that story if available — including transcript and input history.
  useEffect(() => {
    const saved = loadSession(story.id, "quick");
    const fresh = new Engine(story, saved?.engineState);
    setEngine(fresh);
    setTranscript(
      saved && saved.transcript.length > 0
        ? saved.transcript
        : buildIntro(fresh, !!saved),
    );
    setHistory(saved?.inputHistory ?? []);
    setHistoryIndex(-1);
    setInput("");
    // narrator effect below picks up the new engine
  }, [story]);

  // The gate is "passed" when:
  //  - BYOK provider: the user has supplied an API key
  //  - Ollama: the user has clicked Start at least once (defaults always work,
  //    but we want first-timers to see the setup hint and choose a model).
  const ready =
    provider === "ollama" ? ollamaReady && !!ollamaUrl && !!ollamaModel : !!apiKey;

  // Build a Narrator whenever the provider config or engine changes. Restore
  // saved conversation history if available for this story.
  useEffect(() => {
    if (!ready) {
      setNarrator(null);
      return;
    }
    const saved = loadSession(engine.story.id, "quick");
    let client: LLMClient;
    if (provider === "ollama") {
      client = new OllamaClient({ baseUrl: ollamaUrl, model: ollamaModel });
    } else if (provider === "anthropic") {
      client = new DirectAnthropicClient({ apiKey });
    } else {
      const preset = OPENAI_COMPAT_PRESETS[provider];
      client = new OpenAICompatibleClient({
        apiKey,
        baseUrl: preset.baseUrl,
        model: preset.defaultModel,
        providerLabel: preset.label,
        maxTokensParam: preset.maxTokensParam,
      });
    }
    setNarrator(
      new Narrator({
        engine,
        client,
        ...(saved?.narratorHistory && { initialHistory: saved.narratorHistory }),
      }),
    );
  }, [ready, provider, apiKey, ollamaUrl, ollamaModel, engine]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, loading]);

  useEffect(() => {
    if (ready && !loading) inputRef.current?.focus();
  }, [ready, loading]);

  const handleProviderChange = (next: Provider) => {
    setProvider(next);
    localStorage.setItem(PROVIDER_STORAGE, next);
    // Load the newly selected provider's saved key (if any) into both the live
    // key and the draft — so switching to a provider you've used before
    // pre-fills its key and Start is immediately enabled. First run has no
    // saved keys, so the draft is just cleared.
    if (next !== "ollama") {
      const savedKey = localStorage.getItem(keyStorageKey(next)) ?? "";
      setApiKey(savedKey);
      setKeyDraft(savedKey);
    } else {
      setKeyDraft("");
    }
  };

  const startGame = () => {
    if (provider !== "ollama") {
      const trimmed = keyDraft.trim();
      if (!trimmed) return;
      localStorage.setItem(keyStorageKey(provider), trimmed);
      setApiKey(trimmed);
      setKeyDraft("");
    } else {
      const url = ollamaUrlDraft.trim().replace(/\/$/, "");
      const model = ollamaModelDraft.trim();
      if (!url || !model) return;
      localStorage.setItem(OLLAMA_URL_STORAGE, url);
      localStorage.setItem(OLLAMA_MODEL_STORAGE, model);
      localStorage.setItem(OLLAMA_READY_STORAGE, "true");
      setOllamaUrl(url);
      setOllamaModel(model);
      setOllamaReady(true);
    }
    // Confirming a selection closes the config screen (no-op on first run).
    setModelConfigOpen(false);
  };

  // Open the narrator picker as a cancelable config screen. Snapshots the
  // current config so closeModelConfig can restore it if the player backs out,
  // and syncs the draft fields to the current values.
  const openModelConfig = () => {
    setConfigSnapshot({ provider, apiKey, ollamaUrl, ollamaModel, ollamaReady });
    setKeyDraft(provider !== "ollama" ? apiKey : "");
    setOllamaUrlDraft(ollamaUrl);
    setOllamaModelDraft(ollamaModel);
    setModelConfigOpen(true);
  };

  // Cancel path — restore the snapshot (React state plus the PROVIDER_STORAGE
  // entry that radio changes mutate) and close the screen unchanged.
  const closeModelConfig = () => {
    if (configSnapshot) {
      setProvider(configSnapshot.provider);
      localStorage.setItem(PROVIDER_STORAGE, configSnapshot.provider);
      setApiKey(configSnapshot.apiKey);
      setOllamaUrl(configSnapshot.ollamaUrl);
      setOllamaModel(configSnapshot.ollamaModel);
      setOllamaReady(configSnapshot.ollamaReady);
    }
    setModelConfigOpen(false);
  };

  const submit = async () => {
    const text = input.trim();
    if (!text || loading || !narrator) return;

    // Build the next transcript and input history synchronously so the save
    // call (after the LLM round-trip) sees the same values React's setters
    // are about to commit.
    const playerEntry: TranscriptEntry = { kind: "player", text };
    const transcriptAfterInput = [...transcript, playerEntry];
    const nextHistory = history[history.length - 1] === text ? history : [...history, text];

    setInput("");
    setHistory(nextHistory);
    setHistoryIndex(-1);
    setTranscript(transcriptAfterInput);

    // Dev debug intercept — when debug mode is on, slash commands bypass the
    // narrator entirely. Mutates engine state directly (no triggers fire) and
    // appends a system message to the transcript. Off by default; safely no-op
    // if the toggle is off (commands fall through to normal narration).
    if (DEV && debugMode && text.startsWith("/")) {
      const result = handleDebugCommand(text, engine);
      // State-mutating commands invalidate the narrator's cached conversation
      // history (the LLM's prior tool_result views describe the OLD world).
      // Reset the narrator so the next turn starts fresh with the new state
      // in the BEFORE-view block of the user message. Pure read commands
      // (/help, /room, /find) leave history alone.
      const cmd = text.trim().split(/\s+/)[0].toLowerCase();
      const mutating =
        cmd === "/tp" ||
        cmd === "/take" ||
        cmd === "/put" ||
        cmd === "/flag" ||
        cmd === "/state";
      if (mutating) narrator.reset();
      const transcriptAfterDebug: TranscriptEntry[] = [
        ...transcriptAfterInput,
        { kind: "system", text: result },
      ];
      setTranscript(transcriptAfterDebug);
      saveSession({
        storyId: engine.story.id,
        slot: "quick",
        engineState: engine.state,
        narratorHistory: narrator.getHistory(),
        transcript: transcriptAfterDebug,
        inputHistory: nextHistory,
      });
      return;
    }

    setLoading(true);
    try {
      const turn = await narrator.narrate(text, {
        onRetry: ({ attempt, waitSeconds }) =>
          setRetryStatus(
            `Rate limit reached — pausing ${waitSeconds}s, then trying again (attempt ${attempt})…`,
          ),
      });
      // Total failure (no engineResult) → surface only the error entry. The
      // narrator's turn.text wraps the same message in "[error: ...]"; pushing
      // both produces a duplicate. Partial failure (engine succeeded but
      // narration round-trip failed) keeps the narration entry so the player
      // sees that something happened in-game.
      const entries: TranscriptEntry[] =
        turn.error && !turn.engineResult
          ? [{ kind: "error", text: turn.error }]
          : [{ kind: "narration", text: turn.text }];
      const transcriptAfterTurn = [...transcriptAfterInput, ...entries];
      setTranscript(transcriptAfterTurn);
      // Persist after every successful turn. If the LLM round-trip failed
      // (turn.error set), narrator already rolled back its history — so we
      // also skip the save to avoid persisting a partial state where the
      // transcript shows a turn that has no narrator-history backing.
      if (!turn.error) {
        saveSession({
          storyId: engine.story.id,
          slot: "quick",
          engineState: engine.state,
          narratorHistory: narrator.getHistory(),
          transcript: transcriptAfterTurn,
          inputHistory: nextHistory,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTranscript((t) => [...t, { kind: "error", text: message }]);
    } finally {
      setLoading(false);
      setRetryStatus(null);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const next = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInput(history[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex === -1) return;
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(-1);
        setInput("");
      } else {
        setHistoryIndex(next);
        setInput(history[next]);
      }
    }
  };

  // Quick-save is the only slot wiped on "New game" — manual slots are
  // milestone snapshots the user opted to preserve, so leave them alone.
  const restart = () => {
    clearSession(story.id, "quick");
    const fresh = new Engine(story);
    setEngine(fresh);
    setTranscript(buildIntro(fresh, false));
    setHistory([]);
    setHistoryIndex(-1);
    setInput("");
    narrator?.reset();
    inputRef.current?.focus();
  };

  // ----- Save / Load dialog state + slot handlers -----
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  // Bumped after each save/load/clear so the dialog re-reads slot summaries
  // without coupling persistence details to the dialog's render.
  const [slotsRefreshKey, setSlotsRefreshKey] = useState(0);
  const refreshSlots = () => setSlotsRefreshKey((n) => n + 1);

  const handleSaveSlot = (slot: SaveSlot) => {
    if (!narrator) return;
    saveSession({
      storyId: story.id,
      slot,
      engineState: engine.state,
      narratorHistory: narrator.getHistory(),
      transcript,
      inputHistory: history,
    });
    refreshSlots();
  };

  // Loading a slot replaces engine state + transcript + input history + the
  // narrator's conversation history. The slot's data is also mirrored into
  // quick-save BEFORE setEngine is called, because setEngine triggers the
  // narrator-creation useEffect which loads narratorHistory from quick.
  // Without this mirror, a load would alive-engine the player but resurrect
  // the narrator with whatever stale history (often a dead-state run) was
  // last in quick, so the LLM keeps narrating the previous outcome.
  // Mirroring also matches the documented "loading a manual slot forks play;
  // quick tracks the new branch from the next turn onward" semantic — the
  // branch starts now, with the slot's data as turn-zero.
  const handleLoadSlot = (slot: SaveSlot) => {
    const saved = loadSession(story.id, slot);
    if (!saved) return;
    if (slot !== "quick") {
      saveSession({
        storyId: story.id,
        slot: "quick",
        engineState: saved.engineState,
        narratorHistory: saved.narratorHistory,
        transcript: saved.transcript,
        inputHistory: saved.inputHistory,
      });
    }
    const fresh = new Engine(story, saved.engineState);
    setEngine(fresh);
    setTranscript(
      saved.transcript.length > 0 ? saved.transcript : buildIntro(fresh, true),
    );
    setHistory(saved.inputHistory);
    setHistoryIndex(-1);
    setInput("");
    narrator?.replaceHistory(saved.narratorHistory);
    setSaveDialogOpen(false);
    refreshSlots();
  };

  const handleClearSlot = (slot: SaveSlot) => {
    clearSession(story.id, slot);
    refreshSlots();
  };

  const handleNewGame = () => {
    restart();
    setSaveDialogOpen(false);
    refreshSlots();
  };

  const handleStoryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setStoryId(e.target.value);
  };

  const finished = engine.state.finished;

  // ----- Provider / config gate -----
  // Shown when there's no usable config (first run) OR the player opened the
  // "Model" config screen on demand.
  if (!ready || modelConfigOpen) {
    const startDisabled =
      provider === "ollama"
        ? !ollamaUrlDraft.trim() || !ollamaModelDraft.trim()
        : !keyDraft.trim();
    return (
      <main className="game">
        <header className="game-header">
          <div>
            <h1>{story.title}</h1>
            <p className="byline">by {story.author}</p>
          </div>
        </header>
        <section className="card">
          <h2 className="card-title">Choose a narrator</h2>
          <div className="provider-picker">
            {(Object.keys(BYOK_META) as ByokProvider[]).map((p) => (
              <label
                key={p}
                className={`provider-option${provider === p ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="provider"
                  value={p}
                  checked={provider === p}
                  onChange={() => handleProviderChange(p)}
                />
                <div>
                  <strong>{BYOK_META[p].label}</strong>
                  <p className="hint">{BYOK_META[p].pickerHint}</p>
                </div>
              </label>
            ))}
            <label className={`provider-option${provider === "ollama" ? " selected" : ""}`}>
              <input
                type="radio"
                name="provider"
                value="ollama"
                checked={provider === "ollama"}
                onChange={() => handleProviderChange("ollama")}
              />
              <div>
                <strong>Local (Ollama)</strong>
                <p className="hint">
                  Free, runs entirely on your machine. Requires{" "}
                  <code>ollama serve</code> and a pulled model — recommended{" "}
                  <code>llama3.1:8b</code> (or <code>qwen2.5:14b</code> for higher quality).
                </p>
              </div>
            </label>
          </div>

          {provider !== "ollama" ? (
            <>
              <p className="hint">
                {provider === "anthropic" && (
                  <>
                    <strong>This is separate from a Claude Pro / Max subscription</strong> —
                    consumer subscriptions do not include API access.{" "}
                  </>
                )}
                Get a key at{" "}
                <a
                  href={BYOK_META[provider].consoleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {BYOK_META[provider].consoleLabel}
                </a>
                . The key is stored only on this device and sent directly to the provider.
              </p>
              <form
                className="key-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  startGame();
                }}
              >
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder={BYOK_META[provider].placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                />
                <button type="submit" disabled={startDisabled}>
                  Start
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="hint">
                Make sure Ollama is running and you've pulled the model:
                <br />
                <code>OLLAMA_ORIGINS="*" ollama serve</code> (the origins flag lets the app
                reach Ollama)
                <br />
                <code>ollama pull llama3.1:8b</code>
              </p>
              <form
                className="key-form ollama-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  startGame();
                }}
              >
                <label className="field">
                  <span>Server URL</span>
                  <input
                    type="text"
                    value={ollamaUrlDraft}
                    onChange={(e) => setOllamaUrlDraft(e.target.value)}
                    placeholder={DEFAULT_OLLAMA_URL}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  <span>Model</span>
                  <input
                    type="text"
                    value={ollamaModelDraft}
                    onChange={(e) => setOllamaModelDraft(e.target.value)}
                    placeholder={DEFAULT_OLLAMA_MODEL}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <button type="submit" disabled={startDisabled}>
                  Start
                </button>
              </form>
            </>
          )}
          {modelConfigOpen && (
            <div>
              <button type="button" className="restart" onClick={closeModelConfig}>
                Close
              </button>
            </div>
          )}
        </section>
      </main>
    );
  }

  // ----- Game console -----
  return (
    <main className="game">
      <header className="game-header">
        <div className="title-block">
          <h1>{story.title}</h1>
          <p className="byline">by {story.author}</p>
        </div>
        <div className="header-actions">
          <label className="story-picker">
            <span className="story-picker-label">Story</span>
            <select value={storyId} onChange={handleStoryChange} disabled={loading}>
              {STORIES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="restart"
            onClick={() => setSaveDialogOpen(true)}
            disabled={loading}
          >
            Save / Load
          </button>
          {DEV && (
            <button
              type="button"
              className={`restart${debugMode ? " active" : ""}`}
              onClick={() => {
                const next = !debugMode;
                setDebugMode(next);
                localStorage.setItem("lanterngames_debug", String(next));
              }}
              title={debugMode ? "Debug ON — slash commands intercepted (/help)" : "Enable debug slash commands"}
            >
              {debugMode ? "Debug ●" : "Debug ○"}
            </button>
          )}
          <button type="button" className="restart" onClick={openModelConfig} disabled={loading}>
            Model
          </button>
        </div>
      </header>

      <div className="transcript" ref={transcriptRef}>
        {transcript.map((entry, i) => (
          <div key={i} className={`entry entry-${entry.kind}`}>
            {entry.kind === "player" ? <span className="prompt">&gt; </span> : null}
            <pre>{entry.text}</pre>
          </div>
        ))}
        {loading && (
          <div className="entry entry-system">
            <pre>{retryStatus ?? "thinking…"}</pre>
          </div>
        )}
      </div>


      <form
        className="input-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="prompt">&gt;</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={
            finished
              ? "Game over — press Restart to play again"
              : loading
              ? "Waiting for the narrator…"
              : "Type a command…"
          }
          autoComplete="off"
          spellCheck={false}
          disabled={!!finished || loading}
        />
      </form>

      {saveDialogOpen && (
        <SaveLoadDialog
          story={story}
          refreshKey={slotsRefreshKey}
          onClose={() => setSaveDialogOpen(false)}
          onSaveSlot={handleSaveSlot}
          onLoadSlot={handleLoadSlot}
          onClearSlot={handleClearSlot}
          onNewGame={handleNewGame}
        />
      )}
    </main>
  );
}

// Dev debug commands. Intercepted in submit() before reaching the narrator
// when debugMode is on. Mutates engine.state directly — no triggers fire,
// no LLM round-trip. Returns a plain string for the system transcript entry.
function handleDebugCommand(text: string, engine: Engine): string {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case "/help":
      return [
        "[DEBUG] Available commands:",
        "  /tp <roomId>                  — teleport to a room",
        "  /take <itemId>                — take an item into your inventory",
        "  /put <itemId> <to>            — move an item to a room id, item id, or player/nowhere",
        "  /flag <key> <val>             — set a flag (val: true/false/<number>/<string>)",
        "  /state <itemId> <key> <val>   — set per-item state (e.g. /state cyclops unconscious true)",
        "  /flag-state <key>             — show one flag's value",
        "  /item-state <itemId>          — show one item's location + state",
        "  /room                         — show your current room id",
        "  /find <substr>                — search for room/item ids matching the substring",
        "  /help                         — this help",
        "",
        "Note: /tp /take /put /flag /state reset the narrator's conversation history",
        "so the LLM doesn't keep narrating from stale views. The transcript stays;",
        "only the LLM's internal context is cleared. /room /find /flag-state",
        "/item-state /help are read-only and leave history alone.",
      ].join("\n");

    case "/room":
      return `[DEBUG] You are at: ${currentRoomId(engine.state, engine.story) ?? "(unknown)"}`;

    case "/flag-state": {
      const key = args[0];
      if (!key) return "[DEBUG] Usage: /flag-state <key>";
      return key in engine.state.flags
        ? `[DEBUG] ${key} = ${JSON.stringify(engine.state.flags[key])}`
        : `[DEBUG] ${key} = (unset)`;
    }

    case "/item-state": {
      const itemId = args[0];
      if (!itemId) return "[DEBUG] Usage: /item-state <itemId>";
      const item = engine.story.items.find((i) => i.id === itemId);
      if (!item) return `[DEBUG] No such item: "${itemId}". Try /find ${itemId}`;
      const loc = engine.state.itemLocations[itemId] ?? "(unplaced)";
      const st = engine.state.itemStates[itemId];
      const stStr = st && Object.keys(st).length > 0 ? JSON.stringify(st) : "(no state)";
      return `[DEBUG] ${itemId} @ ${loc}\n  state: ${stStr}`;
    }

    case "/tp": {
      const roomId = args[0];
      if (!roomId) return "[DEBUG] Usage: /tp <roomId>";
      const room = engine.story.rooms.find((r) => r.id === roomId);
      if (!room) return `[DEBUG] No such room: "${roomId}". Try /find ${roomId}`;
      engine.state = {
        ...engine.state,
        itemLocations: { ...engine.state.itemLocations, [PLAYER_ITEM_ID]: roomId },
      };
      return `[DEBUG] Teleported to ${roomId} (${room.name}).`;
    }

    case "/take": {
      const itemId = args[0];
      if (!itemId) return "[DEBUG] Usage: /take <itemId>";
      const item = engine.story.items.find((i) => i.id === itemId);
      if (!item) return `[DEBUG] No such item: "${itemId}". Try /find ${itemId}`;
      engine.state = {
        ...engine.state,
        itemLocations: { ...engine.state.itemLocations, [itemId]: PLAYER_ITEM_ID },
      };
      return `[DEBUG] Added ${itemId} (${item.name}) to inventory.`;
    }

    case "/put": {
      const itemId = args[0];
      const to = args[1];
      if (!itemId || !to) return "[DEBUG] Usage: /put <itemId> <to>  (to: roomId, itemId, player, nowhere)";
      const item = engine.story.items.find((i) => i.id === itemId);
      if (!item) return `[DEBUG] No such item: "${itemId}". Try /find ${itemId}`;
      // Resolve destination: special locations, room id, or item id (container).
      let resolvedTo = to;
      let label = to;
      if (to === "inventory" || to === "player") {
        resolvedTo = PLAYER_ITEM_ID;
        label = "player inventory";
      } else if (to === "nowhere") {
        // valid as-is
      } else {
        const room = engine.story.rooms.find((r) => r.id === to);
        const target = engine.story.items.find((i) => i.id === to);
        if (room) {
          label = `${to} (${room.name})`;
        } else if (target) {
          label = `${to} (${target.name})`;
        } else {
          return `[DEBUG] No such room or item: "${to}". Try /find ${to}`;
        }
      }
      engine.state = {
        ...engine.state,
        itemLocations: { ...engine.state.itemLocations, [itemId]: resolvedTo },
      };
      return `[DEBUG] Moved ${itemId} (${item.name}) → ${label}.`;
    }

    case "/flag": {
      const key = args[0];
      const valStr = args.slice(1).join(" ");
      if (!key || valStr === "") {
        return "[DEBUG] Usage: /flag <key> <true|false|<number>|<string>>";
      }
      let val: string | number | boolean;
      if (valStr === "true") val = true;
      else if (valStr === "false") val = false;
      else if (/^-?\d+(\.\d+)?$/.test(valStr)) val = Number(valStr);
      else val = valStr;
      engine.state = {
        ...engine.state,
        flags: { ...engine.state.flags, [key]: val },
      };
      return `[DEBUG] Set flag ${key} = ${JSON.stringify(val)}`;
    }

    case "/state": {
      const itemId = args[0];
      const key = args[1];
      const valStr = args.slice(2).join(" ");
      if (!itemId || !key || valStr === "") {
        return "[DEBUG] Usage: /state <itemId> <key> <true|false|<number>|<string>>";
      }
      const item = engine.story.items.find((i) => i.id === itemId);
      if (!item) return `[DEBUG] No such item: "${itemId}". Try /find ${itemId}`;
      let val: string | number | boolean;
      if (valStr === "true") val = true;
      else if (valStr === "false") val = false;
      else if (/^-?\d+(\.\d+)?$/.test(valStr)) val = Number(valStr);
      else val = valStr;
      const prevItemState = engine.state.itemStates[itemId] ?? {};
      const wasNew = key in prevItemState ? "" : " (new key)";
      engine.state = {
        ...engine.state,
        itemStates: {
          ...engine.state.itemStates,
          [itemId]: { ...prevItemState, [key]: val },
        },
      };
      return `[DEBUG] Set ${itemId}.${key} = ${JSON.stringify(val)}${wasNew}`;
    }

    case "/find": {
      const q = (args[0] ?? "").toLowerCase();
      if (!q) return "[DEBUG] Usage: /find <substring>";
      const rooms = engine.story.rooms
        .filter((r) => r.id.toLowerCase().includes(q))
        .map((r) => r.id);
      const items = engine.story.items
        .filter((i) => i.id.toLowerCase().includes(q))
        .map((i) => i.id);
      const trim = (arr: string[]) =>
        arr.length > 25 ? arr.slice(0, 25).join(", ") + ` … (+${arr.length - 25} more)` : arr.join(", ");
      return [
        `[DEBUG] Search "${q}":`,
        `  rooms (${rooms.length}): ${trim(rooms) || "(none)"}`,
        `  items (${items.length}): ${trim(items) || "(none)"}`,
      ].join("\n");
    }

    default:
      return `[DEBUG] Unknown command: ${cmd}. Try /help.`;
  }
}

function buildIntro(engine: Engine, resumed: boolean): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  if (resumed) {
    out.push({ kind: "system", text: "[Resuming saved game.]" });
  } else if (engine.story.intro) {
    out.push({ kind: "intro", text: engine.story.intro });
  }
  out.push({ kind: "narration", text: renderRoomView(engine.getView()) });
  return out;
}

export default App;
