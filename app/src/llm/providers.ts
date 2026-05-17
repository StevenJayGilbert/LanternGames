// Preset configuration for the OpenAI-compatible providers.
//
// OpenAI (ChatGPT), xAI (Grok), and Google Gemini all expose an OpenAI-shaped
// POST /chat/completions endpoint, so a single OpenAICompatibleClient serves
// all three — only the base URL and default model differ.
//
// Default models are the cheap/fast tier of each family (the Claude-Haiku
// analog) — adequate for narration, low per-turn cost. Slugs current as of
// May 2026; xAI's `grok-4-fast` retires 2026-05-15, hence the 4.1-fast slug.

export type OpenAICompatProvider = "openai" | "xai" | "gemini";

export interface OpenAICompatPreset {
  baseUrl: string;
  defaultModel: string;
  label: string;
  // Output-token cap field. Newer OpenAI models reject `max_tokens` and
  // require `max_completion_tokens`; xAI and Gemini still take `max_tokens`.
  maxTokensParam: "max_tokens" | "max_completion_tokens";
}

export const OPENAI_COMPAT_PRESETS: Record<OpenAICompatProvider, OpenAICompatPreset> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4-mini",
    label: "OpenAI (BYOK)",
    maxTokensParam: "max_completion_tokens",
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4.1-fast-non-reasoning",
    label: "xAI Grok (BYOK)",
    maxTokensParam: "max_tokens",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3-flash",
    label: "Google Gemini (BYOK)",
    maxTokensParam: "max_tokens",
  },
};
