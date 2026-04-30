// Local-first Ollama client. Implements LLMClient.send by translating our
// Anthropic-shaped types to Ollama's NATIVE chat endpoint (POST {baseUrl}/api/chat).
//
// Why this exists: BYOK Anthropic is the day-one tier; this is the genuine $0
// tier — the player runs `ollama serve` locally, picks a model (default
// llama3.1:8b), and plays without any API key. Per TASKS.md Phase 10.
//
// Why the native endpoint, not /v1/chat/completions:
//   The OpenAI-compat path silently caps the prompt at Ollama's default
//   num_ctx (4096 tokens). It does NOT forward `options.num_ctx` from the
//   request body — that field is not in the OpenAI-compat parameter allowlist.
//   With our ~3K-token system prompt + per-turn view JSON + sliding history,
//   the prompt routinely exceeds 4K and the tools array gets truncated off
//   the end. Result: the model "sees" the player command but has no tools
//   defined, so it prose-describes a tool call instead of emitting one.
//   The native /api/chat endpoint honors options.num_ctx properly.
//
// Translations between our Anthropic-shaped types and Ollama's format:
//   1. Multiple `tool_result` blocks in one Anthropic user message become
//      multiple {role:"tool",...} messages (one per result), in order.
//   2. Ollama's tool_call.function.arguments is an OBJECT (not a JSON string,
//      as in the OpenAI-compat path).
//   3. Ollama's tool messages don't carry tool_call_id — they're matched by
//      order. Our compound-tool-call code already emits results in the same
//      order the assistant called them, so this works.
//
// CORS note: Ollama rejects browser fetches by default. Users must run
//   OLLAMA_ORIGINS="*" ollama serve
// (or specifically the dev URL). The UI surfaces this in the setup hint.

import type {
  AssistantMessage,
  ContentBlock,
  LLMClient,
  Message,
  SendRequest,
  StopReason,
  Tool,
} from "./types";
import { LLMError } from "./types";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "llama3.1:8b";
const DEFAULT_MAX_TOKENS = 1024;
// Default to 32K context. Ollama's 4K default would silently truncate the
// narrator's 50-message sliding window + per-turn view JSON within a few turns.
const DEFAULT_NUM_CTX = 32768;

// ---------- Ollama native shapes (only what we use) ----------

interface OllamaToolCall {
  // Some Ollama versions/models include id, some don't. We tolerate both.
  id?: string;
  function: {
    name: string;
    // Native API: arguments is an object. (OpenAI-compat: it's a JSON string.)
    arguments: Record<string, unknown>;
  };
}

type OllamaMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: OllamaToolCall[] }
  // tool_name helps newer Ollama versions bind result to call when ordering
  // alone is ambiguous; older versions ignore it harmlessly.
  | { role: "tool"; content: string; tool_name?: string };

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  model: string;
  message: {
    role: "assistant";
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
}

// ---------- client ----------

export class OllamaClient implements LLMClient {
  private baseUrl: string;
  private model: string;
  private numCtx: number;

  constructor(opts: { baseUrl?: string; model?: string; numCtx?: number }) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.numCtx = opts.numCtx ?? DEFAULT_NUM_CTX;
  }

  async send(req: SendRequest): Promise<AssistantMessage> {
    const messages: OllamaMessage[] = [];
    if (req.system !== undefined) {
      messages.push({ role: "system", content: req.system });
    }
    // Track tool_use_id → tool name so we can populate tool_name on subsequent
    // tool result messages (helpful for newer Ollama versions).
    const toolNameById = new Map<string, string>();
    for (const m of req.messages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === "tool_use") toolNameById.set(block.id, block.name);
        }
      }
      messages.push(...toOllamaMessages(m, toolNameById));
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      options: {
        num_ctx: this.numCtx,
        num_predict: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
      // Disable thinking on models that support it (Qwen3, etc.). On the
      // native endpoint this flag is honored. Harmless on non-thinking models.
      think: false,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(toOllamaTool);
    }
    // toolChoice (Anthropic-style "any" / "tool") is not yet plumbed to
    // Ollama's native API. Ollama's tool support varies by model; some
    // accept a top-level `tool_choice` and others don't. For now we accept
    // the field on SendRequest and silently ignore it here. The narrator's
    // wait-fallback path catches the resulting text-only responses, so
    // gameplay still works — it just lacks the structural "must call a
    // tool" guarantee that Anthropic provides.
    void req.toolChoice;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      throw toNetworkError(err);
    }

    if (!response.ok) {
      throw await toHttpError(response, this.model);
    }

    let parsed: OllamaChatResponse;
    try {
      parsed = (await response.json()) as OllamaChatResponse;
    } catch (err: unknown) {
      throw new LLMError(
        `Ollama returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        "unknown",
      );
    }

    if (!parsed.message) {
      throw new LLMError("Ollama response had no message.", "unknown");
    }

    return {
      role: "assistant",
      content: fromOllamaMessage(parsed.message),
      stopReason: mapDoneReason(parsed.done_reason),
    };
  }
}

// ---------- mapping: outgoing ----------

// Translate ONE of our Messages into ONE OR MORE Ollama messages. The split is
// load-bearing: if the message has tool_result blocks, each becomes its own
// {role:"tool",...} message. Text blocks merge into a single content string.
// Tool_use blocks (assistant only) become tool_calls.
function toOllamaMessages(
  m: Message,
  toolNameById: Map<string, string>,
): OllamaMessage[] {
  if (typeof m.content === "string") {
    if (m.role === "user") return [{ role: "user", content: m.content }];
    return [{ role: "assistant", content: m.content }];
  }

  const out: OllamaMessage[] = [];
  const textParts: string[] = [];
  const toolCalls: OllamaToolCall[] = [];

  for (const block of m.content) {
    switch (block.type) {
      case "text":
        textParts.push(block.text);
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id,
          function: {
            name: block.name,
            arguments: (block.input ?? {}) as Record<string, unknown>,
          },
        });
        break;
      case "tool_result":
        // Each tool_result becomes its own role:tool message. Emit any pending
        // text first so message ordering matches what the assistant saw.
        if (textParts.length > 0) {
          out.push({ role: "user", content: textParts.join("\n") });
          textParts.length = 0;
        }
        out.push({
          role: "tool",
          content: block.is_error ? `[error] ${block.content}` : block.content,
          ...(toolNameById.get(block.tool_use_id) && {
            tool_name: toolNameById.get(block.tool_use_id),
          }),
        });
        break;
    }
  }

  // Flush any remaining text + tool_calls into a final message.
  if (m.role === "assistant" && (textParts.length > 0 || toolCalls.length > 0)) {
    const msg: OllamaMessage = {
      role: "assistant",
      content: textParts.join("\n"),
      ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    };
    out.push(msg);
  } else if (m.role === "user" && textParts.length > 0) {
    out.push({ role: "user", content: textParts.join("\n") });
  }

  return out;
}

function toOllamaTool(t: Tool): OllamaTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  };
}

// ---------- mapping: incoming ----------

function fromOllamaMessage(msg: OllamaChatResponse["message"]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let leftoverText = "";

  const ollamaParsedToolCalls = (msg.tool_calls ?? []).length > 0;
  if (msg.content && msg.content.length > 0) {
    const cleaned = stripThinkTags(msg.content);
    if (ollamaParsedToolCalls) {
      // Ollama already extracted tool_calls — don't re-extract from content
      // or we'd execute the same tool twice. Just strip any orphan tags.
      leftoverText = cleaned.replace(/<\/?tool_call>/gi, "").trim();
    } else {
      // Salvage tool calls the model emitted as raw text (Qwen2.5 + some
      // Llama variants emit `<tool_call>{...}</tool_call>` literally when
      // Ollama's parser fails to recognize them).
      const { extracted, remaining } = extractInlineToolCalls(cleaned);
      for (const call of extracted) blocks.push(call);
      leftoverText = remaining;
    }
  }

  for (const [i, call] of (msg.tool_calls ?? []).entries()) {
    blocks.push({
      type: "tool_use",
      // Some Ollama versions don't include id; synthesize one so the narrator's
      // tool_use → tool_result pairing stays consistent.
      id: call.id ?? `ollama-call-${Date.now()}-${i}`,
      name: call.function.name,
      input: (call.function.arguments ?? {}) as Record<string, unknown>,
    });
  }

  // Only emit a text block if we have meaningful prose left after extraction.
  // If we parsed a tool call out of the content, the leftover narration is
  // usually just stray whitespace, fragments, or token noise — drop it to
  // avoid showing the player garbage like "侴" or a dangling closing tag.
  if (leftoverText.length > 0) {
    if (blocks.length === 0 || isMeaningfulText(leftoverText)) {
      blocks.push({ type: "text", text: leftoverText });
    }
  }
  return blocks;
}

// Some Qwen3 variants leak <think>...</think> blocks into content even when
// `think:false` is set. Strip them so the player doesn't see reasoning chains.
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// Salvage tool calls embedded as raw text in the assistant content. Returns
// any parsed tool_use blocks plus whatever text remains after extraction.
//
// Patterns seen in practice:
//   1. <tool_call>{"name":"go","arguments":{"direction":"east"}}</tool_call>
//   2. </tool_call> with the opening tag missing (Ollama partially parsed)
//   3. Bare {"name":"...","arguments":{...}} JSON with no wrapping tags
//
// We try (1) first (most reliable), then sweep for stragglers matching (3).
let synthIdCounter = 0;
function extractInlineToolCalls(text: string): {
  extracted: Extract<ContentBlock, { type: "tool_use" }>[];
  remaining: string;
} {
  const extracted: Extract<ContentBlock, { type: "tool_use" }>[] = [];
  let remaining = text;

  // Pattern 1: <tool_call>...</tool_call> blocks.
  remaining = remaining.replace(/<tool_call>([\s\S]*?)<\/tool_call>/gi, (_, body: string) => {
    const call = parseToolCallJson(body);
    if (call) extracted.push(call);
    return "";
  });

  // Pattern 2: orphan </tool_call> with JSON before it (opening tag was eaten).
  remaining = remaining.replace(/(\{[\s\S]*?\})\s*<\/tool_call>/gi, (_, body: string) => {
    const call = parseToolCallJson(body);
    if (call) extracted.push(call);
    return "";
  });

  // Pattern 3: bare JSON object with name + arguments fields. Only triggers
  // if the JSON object spans most of the content (avoid grabbing JSON the
  // model legitimately quoted in narration).
  if (extracted.length === 0) {
    const trimmed = remaining.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const call = parseToolCallJson(trimmed);
      if (call) {
        extracted.push(call);
        remaining = "";
      }
    }
  }

  // Drop any orphan opening/closing tags left over.
  remaining = remaining.replace(/<\/?tool_call>/gi, "").trim();
  return { extracted, remaining };
}

function parseToolCallJson(jsonText: string): Extract<ContentBlock, { type: "tool_use" }> | null {
  try {
    const parsed = JSON.parse(jsonText.trim()) as { name?: unknown; arguments?: unknown };
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

// True if the text looks like real narration, not stray punctuation or
// single-character token leakage. Used to decide whether to surface leftover
// content alongside successfully-parsed tool calls.
function isMeaningfulText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  // Require at least one word of three+ ASCII letters to count as prose.
  return /[A-Za-z]{3,}/.test(trimmed);
}

function mapDoneReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case undefined:
      return "end_turn";
    default:
      return reason;
  }
}

// ---------- error mapping ----------

function toNetworkError(err: unknown): LLMError {
  const message = err instanceof Error ? err.message : String(err);
  // Browsers throw TypeError for CORS rejections AND for unreachable hosts.
  // The CORS hint is the more common authoring mistake.
  return new LLMError(
    `Couldn't reach Ollama: ${message}. Is \`ollama serve\` running? For browser access you also need \`OLLAMA_ORIGINS="*" ollama serve\` (or the specific dev origin).`,
    "network",
    true,
  );
}

async function toHttpError(response: Response, model: string): Promise<LLMError> {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    // ignore — we'll fall back to status-only messages
  }
  const status = response.status;

  if (status === 404) {
    // Ollama returns 404 when the model isn't pulled.
    return new LLMError(
      `Model '${model}' not found on Ollama. Run \`ollama pull ${model}\` and try again.`,
      "unknown",
    );
  }
  if (status === 400 && /context|too long|too many tokens/i.test(bodyText)) {
    return new LLMError(
      "Conversation too long for the model's context window. Try restarting the session.",
      "context_length",
    );
  }
  if (status >= 500) {
    return new LLMError(
      `Ollama server error (${status}): ${bodyText.slice(0, 200) || "no detail"}`,
      "overloaded",
      true,
    );
  }
  return new LLMError(
    `Ollama HTTP ${status}: ${bodyText.slice(0, 200) || response.statusText || "no detail"}`,
    "unknown",
  );
}
