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
}

export const OPENAI_COMPAT_PRESETS: Record<OpenAICompatProvider, OpenAICompatPreset> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4-mini",
    label: "OpenAI (BYOK)",
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4.1-fast-non-reasoning",
    label: "xAI Grok (BYOK)",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3-flash",
    label: "Google Gemini (BYOK)",
  },
};
