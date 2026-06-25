import type {
  LlmMessage,
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_OUTPUT_TOKENS = 16384;

// ---------------------------------------------------------------------------
// Internal message types (chat-completions format)
// ---------------------------------------------------------------------------

type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type StreamDeltaToolCall = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type StreamChunk = {
  choices?: {
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: StreamDeltaToolCall[];
    };
    finish_reason?: string | null;
  }[];
  error?: { message?: string; code?: string | number } | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiKey(override?: string | null): string {
  const key = override?.trim() || process.env.OPENROUTER_API_KEY?.trim() || "";
  if (!key) {
    throw new Error(
      "OpenRouter API key is not configured. Set OPENROUTER_API_KEY or add a user OpenRouter key.",
    );
  }
  return key;
}

function toInitialMessages(
  systemPrompt: string,
  messages: LlmMessage[],
): ChatMessage[] {
  const result: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  for (const m of messages) {
    result.push({ role: m.role, content: m.content });
  }
  return result;
}

function toOpenRouterTools(
  tools: OpenAIToolSchema[],
): OpenAIToolSchema[] {
  // OpenRouter accepts the same tool schema as OpenAI chat completions.
  return tools;
}

function extractSseJson(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  const chunks = buffer.split(/\n\n/);
  const rest = chunks.pop() ?? "";

  for (const chunk of chunks) {
    const dataLines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    for (const data of dataLines) {
      if (!data || data === "[DONE]") continue;
      try {
        events.push(JSON.parse(data));
      } catch {
        // Incomplete events stay buffered until the next read.
      }
    }
  }

  return { events, rest };
}

function abortError(): Error {
  const err = new Error("Stream aborted.");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export async function streamOpenRouter(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const {
    model,
    systemPrompt,
    tools = [],
    callbacks = {},
    runTools,
    apiKeys,
  } = params;
  const maxIter = params.maxIterations ?? 10;
  const key = apiKey(apiKeys?.openrouter);
  const openRouterTools = toOpenRouterTools(tools);

  // Build a mutable message history for multi-turn tool use.
  const messages: ChatMessage[] = toInitialMessages(systemPrompt, params.messages);
  let fullText = "";
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: "openrouter",
    model,
  });

  try {
    for (let iter = 0; iter < maxIter; iter++) {
      throwIfAborted(params.abortSignal);

      const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          tools: openRouterTools.length ? openRouterTools : undefined,
          stream: true,
          max_tokens: MAX_OUTPUT_TOKENS,
        }),
        signal: params.abortSignal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const err = new Error(
          `OpenRouter request failed (${response.status}): ${text || response.statusText}`,
        );
        (err as { status?: number }).status = response.status;
        throw err;
      }

      if (!response.body) throw new Error("OpenRouter response had no body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Per-iteration state
      let contentAccum = "";
      // Tool call accumulators indexed by delta.index
      const toolCallMap = new Map<
        number,
        { id: string; name: string; argumentsAccum: string }
      >();
      const announcedIndices = new Set<number>();

      while (true) {
        throwIfAborted(params.abortSignal);
        const { done, value } = await reader.read();
        if (done) break;

        const decoded = decoder.decode(value, { stream: true });
        logRawLlmStream({
          provider: "openrouter",
          model,
          iteration: iter,
          label: "sse_chunk",
          payload: decoded,
        });
        rawStreamRecorder?.record({
          iteration: iter,
          label: "sse_chunk",
          payload: decoded,
        });
        buffer += decoded;
        const extracted = extractSseJson(buffer);
        buffer = extracted.rest;

        for (const raw of extracted.events as StreamChunk[]) {
          logRawLlmStream({
            provider: "openrouter",
            model,
            iteration: iter,
            label: "sse_event",
            payload: raw,
          });
          rawStreamRecorder?.record({
            iteration: iter,
            label: "sse_event",
            payload: raw,
          });

          if (raw.error) {
            const msg =
              typeof raw.error.message === "string" && raw.error.message.trim()
                ? raw.error.message.trim()
                : "OpenRouter response error.";
            throw new Error(`OpenRouter error: ${msg}`);
          }

          const delta = raw.choices?.[0]?.delta;
          if (!delta) continue;

          // Content delta
          if (typeof delta.content === "string" && delta.content) {
            contentAccum += delta.content;
            fullText += delta.content;
            callbacks.onContentDelta?.(delta.content);
          }

          // Tool call deltas — accumulated by index
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              let entry = toolCallMap.get(idx);
              if (!entry) {
                entry = { id: tc.id ?? "", name: tc.function?.name ?? "", argumentsAccum: "" };
                toolCallMap.set(idx, entry);
              }
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.argumentsAccum += tc.function.arguments;

              // Fire onToolCallStart once we know both id and name
              if (entry.id && entry.name && !announcedIndices.has(idx)) {
                announcedIndices.add(idx);
                callbacks.onToolCallStart?.({
                  id: entry.id,
                  name: entry.name,
                  input: {},
                });
              }
            }
          }
        }
      }

      throwIfAborted(params.abortSignal);

      // Build the finalized tool calls for this iteration
      const toolCalls: NormalizedToolCall[] = [];
      for (const [, entry] of toolCallMap) {
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(entry.argumentsAccum || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          input = {};
        }
        toolCalls.push({ id: entry.id, name: entry.name, input });
      }

      if (!toolCalls.length || !runTools) {
        // No tool calls — done.
        break;
      }

      // Append the assistant's tool-call turn to the message history.
      const assistantToolCalls: ChatToolCall[] = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
      messages.push({
        role: "assistant",
        content: contentAccum || null,
        tool_calls: assistantToolCalls,
      });

      // Run the tools and append results.
      const results: NormalizedToolResult[] = await runTools(toolCalls);
      throwIfAborted(params.abortSignal);
      for (const result of results) {
        messages.push({
          role: "tool",
          tool_call_id: result.tool_use_id,
          content: result.content,
        });
      }
    }

    await rawStreamRecorder?.flush("completed");
    return { fullText };
  } catch (error) {
    await rawStreamRecorder?.flush("error", error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// One-shot text completion (no streaming)
// ---------------------------------------------------------------------------

export async function completeOpenRouterText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: { openrouter?: string | null };
}): Promise<string> {
  const key = apiKey(params.apiKeys?.openrouter);
  const messages: ChatMessage[] = [];
  if (params.systemPrompt) {
    messages.push({ role: "system", content: params.systemPrompt });
  }
  messages.push({ role: "user", content: params.user });

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      messages,
      max_tokens: params.maxTokens ?? 512,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter request failed (${response.status}): ${text || response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };

  return json.choices?.[0]?.message?.content ?? "";
}
