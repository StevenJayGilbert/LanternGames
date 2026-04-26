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

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 1024;

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
    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(req.system !== undefined && { system: req.system }),
        messages: req.messages.map(toAnthropicMessage),
        ...(req.tools && req.tools.length > 0 && { tools: req.tools.map(toAnthropicTool) }),
      });
    } catch (err: unknown) {
      throw toLLMError(err);
    }

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
