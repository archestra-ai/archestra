/**
 * Shared plumbing for the OpenAPPA e2e specs: the WireMock stub builders for
 * the scripted Anthropic provider turns, the guardrails policy and tool
 * lookups, and the chat UI message-stream reader. Scenario-specific pieces —
 * the offer-id templates, the installed policies, and each spec's stack
 * setup/teardown — stay in the specs.
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { getE2eRequestUrl, UI_BASE_URL, WIREMOCK_BASE_URL } from "../../consts";
import { expect } from "../api-fixtures";

export type GuardrailsPolicy = { revision: number; content: string };
export type StreamEvent = Record<string, unknown>;
export type ToolInput = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};
export type ToolOutput = { toolCallId: string; output: unknown };
export type SseEvent = { event: string; data: Record<string, unknown> };

/** Mirrors the `makeApiRequest` fixture's signature, as `utils/chat-ui.ts` does. */
export type MakeApiRequest = (args: {
  request: APIRequestContext;
  method: "get" | "post" | "put" | "patch" | "delete";
  urlSuffix: string;
  data?: unknown;
  ignoreStatusCheck?: boolean;
}) => Promise<APIResponse>;

// === WireMock stub builders ================================================

/**
 * A stub on POST /anthropic/v1/messages. `templates` maps a placeholder
 * written into the tool input to the Handlebars expression it is swapped for
 * after serialization — writing the expression straight into the input would
 * bury it under two rounds of JSON escaping (the SSE event, then the
 * `input_json_delta` payload), and WireMock renders the body as plain text.
 */
export function anthropicMapping(params: {
  priority: number;
  bodyPatterns: Record<string, unknown>[];
  events: SseEvent[];
  templates?: Record<string, string>;
}): Record<string, unknown> {
  let body = anthropicSse(params.events);
  for (const [placeholder, expression] of Object.entries(
    params.templates ?? {},
  )) {
    body = body.split(placeholder).join(expression);
  }
  const templated = params.templates !== undefined;
  return {
    priority: params.priority,
    request: {
      method: "POST",
      urlPath: "/anthropic/v1/messages",
      bodyPatterns: params.bodyPatterns,
    },
    response: {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
      ...(templated ? { transformers: ["response-template"] } : {}),
      body,
    },
  };
}

/** Negative body match. `(?s)` so a body carrying a newline still matches. */
export function absent(needle: string): Record<string, unknown> {
  return { doesNotMatch: `(?s).*${needle}.*` };
}

/** One assistant message proposing `calls.length` tool calls, one content block each. */
export function toolUseEvents(
  messageId: string,
  calls: Array<{
    callId: string;
    toolName: string;
    input: Record<string, unknown>;
  }>,
): SseEvent[] {
  const events: SseEvent[] = [messageStart(messageId)];
  calls.forEach((call, index) => {
    events.push(
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: call.callId,
            name: call.toolName,
            input: {},
          },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(call.input),
          },
        },
      },
      {
        event: "content_block_stop",
        data: { type: "content_block_stop", index },
      },
    );
  });
  events.push(messageDelta("tool_use"), {
    event: "message_stop",
    data: { type: "message_stop" },
  });
  return events;
}

/** One assistant message carrying a plain-text answer. */
export function textAnswerEvents(messageId: string, text: string): SseEvent[] {
  return [
    messageStart(messageId),
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    messageDelta("end_turn"),
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

export function messageStart(id: string): SseEvent {
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-3-5-sonnet-20241022",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
  };
}

export function messageDelta(stopReason: string): SseEvent {
  return {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 15 },
    },
  };
}

export function anthropicSse(events: SseEvent[]): string {
  return events
    .map(
      ({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
}

export async function addWireMockMapping(
  request: APIRequestContext,
  mapping: Record<string, unknown>,
): Promise<string> {
  const response = await request.post(`${WIREMOCK_BASE_URL}/__admin/mappings`, {
    data: mapping,
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

// === Policy, tool, and stream plumbing =====================================

export async function readPolicy(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
): Promise<GuardrailsPolicy> {
  const response = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/guardrails-policy",
  });
  return (await response.json()) as GuardrailsPolicy;
}

export async function writePolicy(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  data: { content: string; expectedRevision: number },
): Promise<void> {
  await makeApiRequest({
    request,
    method: "put",
    urlSuffix: "/api/guardrails-policy",
    data,
  });
}

export async function findToolId(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const response = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: `/api/tools/with-assignments?search=${encodeURIComponent(name)}`,
  });
  const { data } = (await response.json()) as {
    data: { id: string; name: string }[];
  };
  const tool = data.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool ${name} is not registered on this stack`);
  return tool.id;
}

/**
 * Posts one user turn and returns every chunk of the UI message stream.
 *
 * Chat runs the agentic loop server-side, so this single request spans all
 * scripted provider turns and the tool executions between them.
 */
export async function runChatTurn(
  request: APIRequestContext,
  params: { conversationId: string; prompt: string },
): Promise<StreamEvent[]> {
  const response = await request.post(getE2eRequestUrl("/api/chat"), {
    headers: { "Content-Type": "application/json", Origin: UI_BASE_URL },
    timeout: 120_000,
    data: {
      id: params.conversationId,
      trigger: "submit-message",
      messages: [
        {
          id: randomUUID(),
          role: "user",
          parts: [{ type: "text", text: params.prompt }],
        },
      ],
    },
  });
  const raw = await response.text();
  expect(response.ok(), `chat stream failed: ${response.status()} ${raw}`).toBe(
    true,
  );
  const events = parseUiMessageStream(raw);
  const errors = events.filter((event) => event.type === "error");
  expect(
    errors,
    `chat stream reported an error: ${JSON.stringify(errors)}`,
  ).toEqual([]);
  return events;
}

export function parseUiMessageStream(raw: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload) as StreamEvent);
    } catch {
      // Keep-alives and other non-JSON frames are not part of the contract.
    }
  }
  return events;
}

export function collect<T>(events: StreamEvent[], type: string): T[] {
  return events.filter((event) => event.type === type) as T[];
}

export function outputFor(outputs: ToolOutput[], toolCallId: string): unknown {
  const match = outputs.find((output) => output.toolCallId === toolCallId);
  if (match === undefined)
    throw new Error(`No tool output was streamed for ${toolCallId}`);
  return match.output;
}

/** A tool result reaches the stream as text or as MCP content blocks. */
export function textOf(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

export function asObject(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * The offer the ruling names.
 *
 * Tolerant of the two shapes the ruling can arrive in on this side: raw text,
 * or re-serialized MCP content blocks where the quotes carry backslashes.
 */
export function readOfferId(ruling: string): string {
  const match = /execute_remedy_plan\(offer_id:\s*\\*"([0-9a-f]+)/.exec(ruling);
  if (!match)
    throw new Error(`The ruling named no offer_id:\n${ruling.slice(0, 2000)}`);
  return match[1];
}

export function assistantText(events: StreamEvent[]): string {
  return events
    .filter((event) => event.type === "text-delta")
    .map((event) => String(event.delta ?? event.text ?? ""))
    .join("");
}
