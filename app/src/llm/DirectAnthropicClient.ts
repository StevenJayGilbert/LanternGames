// BYOK browser-direct Anthropic client. Implements LLMClient.send by mapping
// our provider-neutral types onto the Anthropic SDK.
//
// `dangerouslyAllowBrowser` is intentional — the user knowingly supplies their
// own key, which goes from their browser straight to api.anthropic.com.
// Project decision (TASKS.md): BYOK is the permanent free tier.

import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantMessage,
  ContentBlock,
  LLMClient,
  Message,
  SendRequest,
  Tool,
} from "./types";
import { LLMError } from "./types";
import { debugLog, isDebugEnabled } from "../debug";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 1024;
// Debug-mode text blocks the model emits when the "thinking" flag is on
// begin with one of these markers (per the system-prompt instruction
// injected by the narrator). The client labels them in the console; the
// narrator strips them from player-facing narration.
const REASONING_PREFIX = "[reasoning]";
const VALIDATION_PREFIX = "[validation]";

export class DirectAnthropicClient implements LLMClient {
  private client: Anthropic;
  private model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      dangerouslyAllowBrowser: true,
    });
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  async send(req: SendRequest): Promise<AssistantMessage> {
    // Two cache breakpoints, well under the 4-per-request limit:
    //   1. End of the system prompt — render order is tools → system → messages,
    //      so this caches BOTH tools and system together. They're frozen for the
    //      whole game session (story-scoped), so this entry survives every turn.
    //   2. Top-level cache_control auto-places on the last cacheable block (the
    //      latest user message). This caches the growing conversation prefix so
    //      each turn reads the prior turn's history at ~10% of full input cost.
    //
    // Without this, a typical mid-session turn pays full price on ~5K static
    // tokens (system + tools) plus the entire growing message history. With it,
    // the first request writes the cache (~1.25× cost on the prefix), and every
    // subsequent request within ~5min reads it (~10% cost). Per-turn cost drops
    // from ~$0.05 to ~$0.01 on Haiku 4.5 in extended sessions.
    const systemBlocks: Anthropic.TextBlockParam[] | undefined =
      req.system !== undefined
        ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
        : undefined;

    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        cache_control: { type: "ephemeral" },
        ...(systemBlocks && { system: systemBlocks }),
        messages: req.messages.map(toAnthropicMessage),
        ...(req.tools && req.tools.length > 0 && { tools: req.tools.map(toAnthropicTool) }),
        // tool_choice is a per-request flag (not part of the cached prefix), so
        // forcing tool calls on Phase 1 has zero token cost. Anthropic's API
        // accepts {type: "auto" | "any" | "tool"} with the same shape we use.
        ...(req.toolChoice && { tool_choice: req.toolChoice }),
      });
    } catch (err: unknown) {
      throw toLLMError(err);
    }

    // Surface text blocks to the console when the thinking flag is on. The
    // narrator's system-prompt suffix asks the model to emit "[reasoning]"
    // and "[validation]" text blocks alongside each tool call. Labels each
    // block by which marker it leads with so the user can read the trace
    // and the rule-compliance audit at a glance. Logs ALL text blocks even
    // when they don't follow the format, so we can see what's actually there.
    if (isDebugEnabled("thinking")) {
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      if (textBlocks.length === 0) {
        debugLog("thinking", "[Reasoning] (no text blocks in response)");
      } else {
        for (const block of textBlocks) {
          const trimmed = block.text.trim();
          const lower = trimmed.toLowerCase();
          let tag = "[Text block]";
          if (lower.startsWith(REASONING_PREFIX)) tag = "[Reasoning]";
          else if (lower.startsWith(VALIDATION_PREFIX)) tag = "[Validation]";
          debugLog("thinking", tag, trimmed);
        }
      }
    }

    // Surface cache hit/miss so we can verify caching is working. cache_read =
    // cheap reads, cache_creation = first-write (1.25× cost), input_tokens =
    // uncached remainder (full price). Gated by debug.config.json → anthropic.
    debugLog(
      "anthropic",
      "[Anthropic usage]",
      JSON.stringify({
        in: response.usage.input_tokens,
        cache_read: response.usage.cache_read_input_tokens,
        cache_create: response.usage.cache_creation_input_tokens,
        out: response.usage.output_tokens,
      }),
    );

    return {
      role: "assistant",
      content: response.content.map(fromAnthropicBlock),
      stopReason: response.stop_reason ?? "end_turn",
    };
  }
}

// ---------- mapping ----------

function toAnthropicMessage(m: Message): Anthropic.MessageParam {
  if (typeof m.content === "string") {
    return { role: m.role, content: m.content };
  }
  return {
    role: m.role,
    content: m.content.map(toAnthropicBlock),
  };
}

function toAnthropicBlock(b: ContentBlock): Anthropic.ContentBlockParam {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: b.content,
        ...(b.is_error !== undefined && { is_error: b.is_error }),
      };
  }
}

function fromAnthropicBlock(b: Anthropic.ContentBlock): ContentBlock {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_use") {
    return {
      type: "tool_use",
      id: b.id,
      name: b.name,
      input: (b.input ?? {}) as Record<string, unknown>,
    };
  }
  // Anthropic responses don't include tool_result blocks in assistant output,
  // but treat unknown types as a passthrough text block to avoid crashing.
  return { type: "text", text: `(unsupported content block: ${b.type})` };
}

function toAnthropicTool(t: Tool): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
    ...(t.cacheBreakpoint && { cache_control: { type: "ephemeral" } }),
  };
}

function toLLMError(err: unknown): LLMError {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401) {
      return new LLMError(
        "Invalid API key. Check that it starts with 'sk-ant-' and is still active.",
        "invalid_key",
      );
    }
    if (err.status === 429) {
      return new LLMError(
        "Rate limited by Anthropic. Wait a moment and try again.",
        "rate_limit",
        true,
      );
    }
    if (err.status === 529) {
      return new LLMError(
        "Anthropic API is overloaded. Try again in a moment.",
        "overloaded",
        true,
      );
    }
    if (err.status === 400 && /context|too long/i.test(err.message)) {
      return new LLMError("Conversation too long for the model's context.", "context_length");
    }
    return new LLMError(err.message, "unknown");
  }
  if (err instanceof Anthropic.APIConnectionError || err instanceof TypeError) {
    return new LLMError("Network error. Check your connection.", "network", true);
  }
  if (err instanceof Error) {
    return new LLMError(err.message, "unknown");
  }
  return new LLMError(String(err), "unknown");
}
