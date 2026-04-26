// Local-first Ollama client. Implements LLMClient.send by translating our
// Anthropic-shaped types to Ollama's OpenAI-compatible chat endpoint
// (POST {baseUrl}/v1/chat/completions).
//
// Why this exists: BYOK Anthropic is the day-one tier; this is the genuine $0
// tier — the player runs `ollama serve` locally, picks a model (default
// qwen3:14b), and plays without any API key. Per TASKS.md Phase 10.
//
// Two load-bearing translations, plus one footgun:
//   1. Anthropic batches multiple `tool_result` blocks into ONE user message;
//      OpenAI requires each one as its own `{role:"tool",...}` message. We split.
//   2. OpenAI tool-call arguments arrive as a JSON STRING (not an object) —
//      JSON.parse with try/catch (small models occasionally emit malformed JSON).
//   3. Ollama defaults `num_ctx` to 4K and silently truncates — we set 32768
//      explicitly. This is the #1 documented Ollama footgun.
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
const DEFAULT_MODEL = "qwen3:14b";
const DEFAULT_MAX_TOKENS = 1024;
// Default to 32K context. Ollama's 4K default would silently truncate the
// narrator's 50-message sliding window + per-turn view JSON within a few turns.
const DEFAULT_NUM_CTX = 32768;

// ---------- OpenAI-compat shapes (only what we use) ----------

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIChatResponse {
  choices: Array<{
    finish_reason: string | null;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
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
    const messages: OpenAIMessage[] = [];
    if (req.system !== undefined) {
      messages.push({ role: "system", content: req.system });
    }
    for (const m of req.messages) {
      messages.push(...toOpenAIMessages(m));
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      // num_ctx must be in the model `options` block per Ollama's API; the
      // OpenAI-compat path forwards it through.
      options: { num_ctx: this.numCtx },
      // Disable Qwen3 reasoning chains. They double-quadruple latency without
      // adding value for narrator turns; harmless for non-thinking models.
      think: false,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(toOpenAITool);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
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

    let parsed: OpenAIChatResponse;
    try {
      parsed = (await response.json()) as OpenAIChatResponse;
    } catch (err: unknown) {
      throw new LLMError(
        `Ollama returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        "unknown",
      );
    }

    const choice = parsed.choices?.[0];
    if (!choice) {
      throw new LLMError("Ollama response had no choices.", "unknown");
    }

    return {
      role: "assistant",
      content: fromOpenAIMessage(choice.message),
      stopReason: mapFinishReason(choice.finish_reason),
    };
  }
}

// ---------- mapping: outgoing ----------

// Translate ONE of our Messages into ONE OR MORE OpenAI messages. The split is
// load-bearing: if the message has tool_result blocks, each becomes its own
// {role:"tool",...} message in OpenAI's format. Text blocks merge into a single
// content string. Tool_use blocks (assistant only) become tool_calls.
function toOpenAIMessages(m: Message): OpenAIMessage[] {
  if (typeof m.content === "string") {
    if (m.role === "user") return [{ role: "user", content: m.content }];
    return [{ role: "assistant", content: m.content }];
  }

  const out: OpenAIMessage[] = [];
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of m.content) {
    switch (block.type) {
      case "text":
        textParts.push(block.text);
        break;
      case "tool_use":
        // Only valid on assistant messages. If the engine ever sent these on a
        // user message it'd be a logic bug, not something to silently swallow.
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
        // Each tool_result becomes its own role:tool message. Emit any pending
        // text first so message ordering matches what the assistant saw.
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

  // Flush any remaining text + tool_calls into a final message.
  if (m.role === "assistant" && (textParts.length > 0 || toolCalls.length > 0)) {
    const msg: OpenAIMessage = {
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

function toOpenAITool(t: Tool): OpenAITool {
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

function fromOpenAIMessage(msg: OpenAIChatResponse["choices"][number]["message"]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (msg.content && msg.content.length > 0) {
    blocks.push({ type: "text", text: stripThinkTags(msg.content) });
  }
  for (const call of msg.tool_calls ?? []) {
    let input: Record<string, unknown>;
    try {
      input = call.function.arguments
        ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
        : {};
    } catch (err: unknown) {
      throw new LLMError(
        `Model returned malformed JSON for tool '${call.function.name}': ${
          err instanceof Error ? err.message : String(err)
        }`,
        "unknown",
      );
    }
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input,
    });
  }
  return blocks;
}

// Some Qwen3 variants leak <think>...</think> blocks into content even when
// `think:false` is set. Strip them so the player doesn't see reasoning chains.
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case null:
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
