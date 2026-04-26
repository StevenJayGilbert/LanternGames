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

export interface SendRequest {
  system?: string;          // single system message (Anthropic-style; OpenAI adapters wrap it)
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;       // default 1024
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
