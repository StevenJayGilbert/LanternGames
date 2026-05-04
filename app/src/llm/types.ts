// LLMClient abstraction.
//
// Used by the narrator (and any future LLM consumer) so we don't pin the
// project to a single provider. Day-one impl is DirectAnthropicClient (BYOK
// browser-direct). Future implementations: HostedProxyClient (Phase 11) and
// OllamaClient (Phase 10).
//
// Non-streaming for now. Streaming can be added as a separate method when we
// want progressive UI; the tool-use round-trip is much cleaner without it.

export type Role = "user" | "assistant";

// A content block in a message. Mirrors Anthropic's structure because it's the
// most expressive of the major providers; OpenAI/Ollama adapters can compress
// to their formats.
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: Role;
  // String is shorthand for [{ type: "text", text }]. Use blocks when the
  // message includes tool_use or tool_result.
  content: string | ContentBlock[];
}

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  // If set, the LLM client adds a cache breakpoint at this tool. Used to
  // partition the tools[] array into cache-stable vs. cache-volatile tiers
  // (built-ins + always-on customs cache permanently; conditional per-turn
  // customs only cache while their set is byte-stable).
  cacheBreakpoint?: boolean;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "pause_turn"
  | string;

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  stopReason: StopReason;
}

// Tool selection control. Mirrors Anthropic's `tool_choice`.
//   - "auto" (default): model decides whether to call a tool.
//   - "any": model MUST call exactly one tool from the provided set.
//   - { type: "tool", name }: model MUST call this specific tool.
// Used by the narrator to force tool calls on Phase 1 of each turn so the
// engine state always advances (no more text-only "I don't think you can do
// that" hallucinated refusals from the LLM).
export type ToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export interface SendRequest {
  system?: string;          // single system message (Anthropic-style; OpenAI adapters wrap it)
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;       // default 1024
  toolChoice?: ToolChoice;  // default "auto" — see ToolChoice above
}

export interface LLMClient {
  send(req: SendRequest): Promise<AssistantMessage>;
}

export type LLMErrorKind =
  | "invalid_key"
  | "rate_limit"
  | "network"
  | "overloaded"
  | "context_length"
  | "insufficient_credits"
  | "unknown";

export class LLMError extends Error {
  kind: LLMErrorKind;
  retryable: boolean;

  constructor(message: string, kind: LLMErrorKind, retryable: boolean = false) {
    super(message);
    this.name = "LLMError";
    this.kind = kind;
    this.retryable = retryable;
  }
}
