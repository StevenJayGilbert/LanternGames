import { useEffect, useMemo, useRef, useState } from "react";
import { Engine } from "./engine/engine";
import { renderRoomView } from "./engine/render";
import { DirectAnthropicClient } from "./llm/DirectAnthropicClient";
import { OllamaClient } from "./llm/OllamaClient";
import type { LLMClient } from "./llm/types";
import { Narrator } from "./llm/narrator";
import {
  clearSession,
  loadSession,
  saveSession,
  type TranscriptEntry,
} from "./persistence/localSave";
import { DEFAULT_STORY_ID, STORIES, findStory } from "./stories";
import "./App.css";

type Provider = "anthropic" | "ollama";

const KEY_STORAGE = "lanterngames_api_key";
const STORY_STORAGE = "lanterngames_story_id";
const PROVIDER_STORAGE = "lanterngames_provider";
const OLLAMA_URL_STORAGE = "lanterngames_ollama_url";
const OLLAMA_MODEL_STORAGE = "lanterngames_ollama_model";
const OLLAMA_READY_STORAGE = "lanterngames_ollama_ready";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.1:8b";

function loadProvider(): Provider {
  const stored = localStorage.getItem(PROVIDER_STORAGE);
  return stored === "ollama" ? "ollama" : "anthropic";
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
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(KEY_STORAGE) ?? "");
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
  // Initial engine: restore saved state if any. Otherwise fresh.
  const [engine, setEngine] = useState(() => {
    const saved = loadSession(story.id);
    return new Engine(story, saved?.engineState);
  });
  const [narrator, setNarrator] = useState<Narrator | null>(null);

  const [transcript, setTranscript] = useState<TranscriptEntry[]>(() => {
    const saved = loadSession(story.id);
    if (saved && saved.transcript.length > 0) return saved.transcript;
    return buildIntro(engine, !!saved);
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<string[]>(
    () => loadSession(story.id)?.inputHistory ?? [],
  );
  const [historyIndex, setHistoryIndex] = useState(-1);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Persist story choice.
  useEffect(() => {
    localStorage.setItem(STORY_STORAGE, storyId);
  }, [storyId]);

  // Recreate engine + transcript when the story changes. Restore saved state
  // for that story if available — including transcript and input history.
  useEffect(() => {
    const saved = loadSession(story.id);
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
  //  - Anthropic: the user has supplied an API key
  //  - Ollama: the user has clicked Start at least once (defaults always work,
  //    but we want first-timers to see the setup hint and choose a model).
  const ready =
    provider === "anthropic" ? !!apiKey : ollamaReady && !!ollamaUrl && !!ollamaModel;

  // Build a Narrator whenever the provider config or engine changes. Restore
  // saved conversation history if available for this story.
  useEffect(() => {
    if (!ready) {
      setNarrator(null);
      return;
    }
    const saved = loadSession(engine.story.id);
    const client: LLMClient =
      provider === "ollama"
        ? new OllamaClient({ baseUrl: ollamaUrl, model: ollamaModel })
        : new DirectAnthropicClient({ apiKey });
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
  };

  const startGame = () => {
    if (provider === "anthropic") {
      const trimmed = keyDraft.trim();
      if (!trimmed) return;
      localStorage.setItem(KEY_STORAGE, trimmed);
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
  };

  const resetConfig = () => {
    if (provider === "anthropic") {
      localStorage.removeItem(KEY_STORAGE);
      setApiKey("");
    } else {
      localStorage.removeItem(OLLAMA_READY_STORAGE);
      setOllamaReady(false);
    }
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
    setLoading(true);

    try {
      const turn = await narrator.narrate(text);
      const entries: TranscriptEntry[] = [{ kind: "narration", text: turn.text }];
      if (turn.error && !turn.engineResult) {
        entries.push({ kind: "error", text: turn.error });
      }
      const transcriptAfterTurn = [...transcriptAfterInput, ...entries];
      setTranscript(transcriptAfterTurn);
      // Persist after every successful turn. If the LLM round-trip failed
      // (turn.error set), narrator already rolled back its history — so we
      // also skip the save to avoid persisting a partial state where the
      // transcript shows a turn that has no narrator-history backing.
      if (!turn.error) {
        saveSession({
          storyId: engine.story.id,
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

  const restart = () => {
    clearSession(story.id);
    const fresh = new Engine(story);
    setEngine(fresh);
    setTranscript(buildIntro(fresh, false));
    setHistory([]);
    setHistoryIndex(-1);
    setInput("");
    inputRef.current?.focus();
  };

  const handleStoryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setStoryId(e.target.value);
  };

  const finished = engine.state.finished;

  // ----- Provider / config gate -----
  if (!ready) {
    const startDisabled =
      provider === "anthropic"
        ? !keyDraft.trim()
        : !ollamaUrlDraft.trim() || !ollamaModelDraft.trim();
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
            <label className={`provider-option${provider === "anthropic" ? " selected" : ""}`}>
              <input
                type="radio"
                name="provider"
                value="anthropic"
                checked={provider === "anthropic"}
                onChange={() => handleProviderChange("anthropic")}
              />
              <div>
                <strong>Anthropic (BYOK)</strong>
                <p className="hint">
                  Fast, polished narration via Claude. Bring your own API key — about $0.01–0.05
                  per turn. The key stays in your browser.
                </p>
              </div>
            </label>
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

          {provider === "anthropic" ? (
            <>
              <p className="hint">
                <strong>This is separate from a Claude Pro / Max subscription</strong> — consumer
                subscriptions do not include API access. Get a key at{" "}
                <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer">
                  console.anthropic.com
                </a>
                . ~$5 of credits covers many hours of play. The key is stored only in your browser
                (localStorage) and sent directly to Anthropic.
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
                  placeholder="sk-ant-..."
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
                <code>OLLAMA_ORIGINS="*" ollama serve</code> (the origins flag is required for
                browser access)
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
          <button type="button" className="restart" onClick={restart} disabled={loading}>
            Restart
          </button>
          <button type="button" className="restart" onClick={resetConfig} disabled={loading}>
            {provider === "anthropic" ? "Clear key" : "Switch provider"}
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
            <pre>thinking…</pre>
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
    </main>
  );
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
