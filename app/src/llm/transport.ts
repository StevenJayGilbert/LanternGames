// Fetch transport for LLM provider calls.
//
// In a plain browser, provider APIs are reached with window.fetch — subject
// to each provider's CORS policy (Anthropic and xAI allow browser-direct
// calls; OpenAI and Gemini do not). In the Tauri desktop build, calls are
// routed through @tauri-apps/plugin-http, whose fetch runs in Rust — not a
// browser context — and therefore bypasses CORS entirely, so every provider
// works there.
//
// getFetch() is the single seam every LLM client calls.

import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export { isTauri };

// The fetch implementation LLM clients should use for provider calls.
export function getFetch(): typeof fetch {
  if (isTauri()) {
    return tauriFetch as typeof fetch;
  }
  return window.fetch.bind(window);
}
