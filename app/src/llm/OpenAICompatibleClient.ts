// OpenAI-compatible chat client. Implements LLMClient.send for any provider
// exposing an OpenAI-shaped POST /chat/completions endpoint — currently
// OpenAI (ChatGPT), xAI (Grok), and Google Gemini (its OpenAI-compat
// endpoint). One client, parameterized by base URL + model (see providers.ts).
//
// Raw fetch, no `openai` SDK — deliberate: the SDK injects x-stainless-*
// headers that trigger CORS preflight failures from a browser. The desktop
// (Tauri) build routes through getFetch() → the Rust HTTP plugin, which is
// not a browser context and bypasses CORS for every provider.
//
// Prompt caching is automatic on all three providers — no request flags. The
// narrator already front-loads the static system prompt + tools, which is all
// prefix caching needs; we just surface usage.prompt_tokens_details.cached_
// tokens in the debug log.
//
// Translations between our Anthropic-shaped types and OpenAI's format, with
// two differences from OllamaClient:
//   1. tool_call.function.arguments is a JSON STRING (Ollama: an object).
//   2. tool results are {role:"tool", tool_call_id, content} — matched by id,
//      not by order.

import type {
  AssistantMessage,
  ContentBlock,
  LLMClient,
  Message,
  SendRequest,
  StopReason,
  Tool,
  ToolChoice,
} from "./types";
import { LLMError } from "./types";
import { getFetch } from "./transport";
import { debugLog } from "../debug";

const DEFAULT_MAX_TOKENS = 1024;

// ---------- OpenAI chat shapes (only what we use) ----------

interface OAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    // OpenAI-compat: arguments is a JSON string. (Ollama native: an object.)
    arguments: string;
  };
}

type OAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OAIResponse {
  choices?: Array<{
    message?: { role: "assistant"; content?: string | null; tool_calls?: OAIToolCall[] };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

// ---------- client ----------

export class OpenAICompatibleClient implements LLMClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private providerLabel: string;
  // The output-token cap field name. Newer OpenAI models reject the legacy
  // `max_tokens` and require `max_completion_tokens`; xAI and Gemini's
  // OpenAI-compat endpoint still take `max_tokens`. Set per provider preset.
  private maxTokensParam: string;
  // A stable per-session id. xAI uses x-grok-conv-id to raise prefix-cache
  // hit rate; other providers ignore the header harmlessly.
  private convId: string;

  constructor(opts: {
    apiKey: string;
    baseUrl: string;
    model: string;
    providerLabel?: string;
    maxTokensParam?: string;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.model = opts.model;
    this.providerLabel = opts.providerLabel ?? "OpenAI-compatible";
    this.maxTokensParam = opts.maxTokensParam ?? "max_tokens";
    this.convId = crypto.randomUUID();
  }

  async send(req: SendRequest): Promise<AssistantMessage> {
    const messages: OAIMessage[] = [];
    if (req.system !== undefined) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push(...toOAIMessages(m));

    const body: Record<string, unknown> = {
      model: this.model,
      [this.maxTokensParam]: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
    };
    if (req.tools && req.tools.length > 0) body.tools = req.tools.map(toOAITool);
    if (req.toolChoice) body.tool_choice = toOAIToolChoice(req.toolChoice);

    const fetchImpl = getFetch();
    let response: Response;
    try {
      response = await fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "x-grok-conv-id": this.convId,
        },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      throw toNetworkError(err, this.providerLabel);
    }

    if (!response.ok) {
      throw await toHttpError(response, this.providerLabel, this.model);
    }

    let parsed: OAIResponse;
    try {
      parsed = (await response.json()) as OAIResponse;
    } catch (err: unknown) {
      throw new LLMError(
        `${this.providerLabel} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        "unknown",
      );
    }

    const choice = parsed.choices?.[0];
    if (!choice?.message) {
      throw new LLMError(`${this.providerLabel} response had no message.`, "unknown");
    }

    // Surface token + cache usage so the debug overlay shows caching working.
    // cached_tokens are prefix-cache hits, billed at a steep discount on all
    // three providers. Gated by debug.config.json → provider.
    if (parsed.usage) {
      debugLog(
        "provider",
        `[${this.providerLabel} usage]`,
        JSON.stringify({
          in: parsed.usage.prompt_tokens,
          cache_read: parsed.usage.prompt_tokens_details?.cached_tokens,
          out: parsed.usage.completion_tokens,
        }),
      );
    }

    return {
      role: "assistant",
      content: fromOAIMessage(choice.message),
      stopReason: mapFinishReason(choice.finish_reason),
    };
  }
}

// ---------- mapping: outgoing ----------

// Translate ONE of our Messages into ONE OR MORE OpenAI messages. A message
// with tool_result blocks splits: each result becomes its own {role:"tool"}
// message (matched to its call by tool_call_id). Text blocks merge into one
// content string; tool_use blocks (assistant only) become tool_calls.
export function toOAIMessages(m: Message): OAIMessage[] {
  if (typeof m.content === "string") {
    return [{ role: m.role, content: m.content } as OAIMessage];
  }

  const out: OAIMessage[] = [];
  const textParts: string[] = [];
  const toolCalls: OAIToolCall[] = [];

  for (const block of m.content) {
    switch (block.type) {
      case "text":
        textParts.push(block.text);
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
        break;
      case "tool_result":
        // Emit any pending text first so message ordering matches what the
        // assistant saw, then the tool result as its own message.
        if (textParts.length > 0) {
          out.push({ role: "user", content: textParts.join("\n") });
          textParts.length = 0;
        }
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.is_error ? `[error] ${block.content}` : block.content,
        });
        break;
    }
  }

  if (m.role === "assistant" && (textParts.length > 0 || toolCalls.length > 0)) {
    out.push({
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("\n") : null,
      ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    });
  } else if (m.role === "user" && textParts.length > 0) {
    out.push({ role: "user", content: textParts.join("\n") });
  }

  return out;
}

export function toOAITool(t: Tool): OAITool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  };
}

// "any" → "required": the model must call a tool. "tool" → a named function.
export function toOAIToolChoice(tc: ToolChoice): unknown {
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: tc.name } };
  }
}

// ---------- mapping: incoming ----------

export function fromOAIMessage(msg: {
  content?: string | null;
  tool_calls?: OAIToolCall[];
}): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const hasStructuredCalls = (msg.tool_calls ?? []).length > 0;
  const text = (msg.content ?? "").trim();

  if (text.length > 0 && !hasStructuredCalls) {
    // OpenAI/xAI/Gemini reliably emit structured tool_calls; the inline
    // salvage only triggers when a model returned the call as raw JSON text
    // instead (a rare quirk). Otherwise the text is genuine narration.
    const salvaged = salvageInlineToolCall(text);
    if (salvaged) {
      blocks.push(salvaged);
      return blocks;
    }
    blocks.push({ type: "text", text });
  } else if (text.length > 0) {
    blocks.push({ type: "text", text });
  }

  for (const call of msg.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    });
  }

  return blocks;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// If the whole content is a single JSON object carrying name + arguments,
// treat it as a tool call the model failed to emit structurally.
let synthIdCounter = 0;
function salvageInlineToolCall(text: string): Extract<ContentBlock, { type: "tool_use" }> | null {
  const trimmed = text.replace(/<\/?tool_call>/gi, "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { name?: unknown; arguments?: unknown };
    if (typeof parsed.name !== "string" || parsed.name.length === 0) return null;
    const args =
      parsed.arguments && typeof parsed.arguments === "object"
        ? (parsed.arguments as Record<string, unknown>)
        : {};
    synthIdCounter += 1;
    return {
      type: "tool_use",
      id: `inline-call-${Date.now()}-${synthIdCounter}`,
      name: parsed.name,
      input: args,
    };
  } catch {
    return null;
  }
}

export function mapFinishReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case undefined:
      return "end_turn";
    default:
      return reason;
  }
}

// ---------- error mapping ----------

function toNetworkError(err: unknown, providerLabel: string): LLMError {
  const message = err instanceof Error ? err.message : String(err);
  // Browsers throw TypeError for CORS rejections AND unreachable hosts.
  return new LLMError(
    `Couldn't reach ${providerLabel}: ${message}. Note: OpenAI and Gemini block browser-direct calls — they work in the desktop build.`,
    "network",
    true,
  );
}

async function toHttpError(
  response: Response,
  providerLabel: string,
  model: string,
): Promise<LLMError> {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    // fall back to status-only messaging
  }
  const status = response.status;

  if (status === 401 || status === 403) {
    return new LLMError(
      `${providerLabel} rejected the API key. Check that it's correct and still active.`,
      "invalid_key",
    );
  }
  if (status === 404) {
    return new LLMError(
      `${providerLabel}: model '${model}' not found. Check the model name.`,
      "unknown",
    );
  }
  if (status === 429) {
    if (/quota|credit|billing|insufficient/i.test(bodyText)) {
      return new LLMError(
        `${providerLabel}: out of credits or quota. Check your account billing.`,
        "insufficient_credits",
      );
    }
    // Honor Retry-After when the provider sends it (seconds form; OpenAI uses
    // seconds). An HTTP-date form parses to NaN — left undefined, backoff used.
    const retryAfterRaw = response.headers.get("retry-after");
    const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
    const retryAfterMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : undefined;
    return new LLMError(
      `${providerLabel} rate limited. Wait a moment and retry.`,
      "rate_limit",
      true,
      retryAfterMs,
    );
  }
  if (status === 400 && /context|too long|maximum.*token/i.test(bodyText)) {
    return new LLMError(
      "Conversation too long for the model's context window. Try restarting the session.",
      "context_length",
    );
  }
  if (status >= 500) {
    return new LLMError(
      `${providerLabel} server error (${status}): ${bodyText.slice(0, 200) || "no detail"}`,
      "overloaded",
      true,
    );
  }
  return new LLMError(
    `${providerLabel} HTTP ${status}: ${bodyText.slice(0, 200) || response.statusText || "no detail"}`,
    "unknown",
  );
}
