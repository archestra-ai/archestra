import { afterEach, describe, expect, test, vi } from "vitest";
import type { Anthropic } from "@/types";
import { githubCopilotMessagesAdapterFactory as factory } from "./github-copilot-messages";

const request: Anthropic.Types.MessagesRequest = {
  model: "claude-sonnet-4.5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
  thinking: { type: "enabled", budget_tokens: 512 },
  tools: [
    {
      name: "lookup",
      description: "Look up a value",
      input_schema: { type: "object", properties: {} },
    },
  ],
};
const response: Anthropic.Types.MessagesResponse = {
  id: "msg_native",
  type: "message",
  role: "assistant",
  model: request.model,
  content: [
    { type: "thinking", thinking: "Reasoning", signature: "signed" },
    { type: "text", text: "Hello" },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 20 },
};
afterEach(() => vi.unstubAllGlobals());

function intercept(
  upstream: (input: string | URL | Request, init?: RequestInit) => Response,
) {
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("copilot_internal"))
        return Response.json({
          token: "copilot-bearer",
          expires_at: Math.floor(Date.now() / 1000) + 1800,
        });
      return upstream(input, init);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("native Copilot Messages", () => {
  test("exchanges OAuth and sends native thinking/tools with Copilot auth, retaining beta and provider identity", async () => {
    let sent: unknown;
    intercept((input, init) => {
      expect(String(input)).toBe("https://api.githubcopilot.com/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer copilot-bearer");
      expect(headers.has("x-api-key")).toBe(false);
      expect(headers.get("openai-intent")).toBe("messages-proxy");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(headers.get("anthropic-beta")).toBe(
        "interleaved-thinking-2025-05-14",
      );
      expect(headers.get("x-github-api-version")).toBeTruthy();
      sent = JSON.parse(String(init?.body));
      return Response.json(response);
    });
    const client = factory.createClient("gho_messages_native", {
      source: "api",
      defaultHeaders: {
        "x-api-key": "must-not-leak",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      },
    });
    const result = await factory.execute(client, request);
    expect(sent).toEqual({ ...request, stream: false });
    expect(result).toEqual(response);
    expect(factory.createRequestAdapter(request).provider).toBe(
      "github-copilot",
    );
    expect(factory.createResponseAdapter(result).provider).toBe(
      "github-copilot",
    );
    expect(factory.createStreamAdapter().provider).toBe("github-copilot");
    expect(
      factory.isSubscriptionCredential?.(
        "sk-ant-oat-not-an-anthropic-subscription",
      ),
    ).toBe(false);
  });

  test("preserves native SSE thinking and signature events, including unknown beta events", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          ...response,
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Reasoning" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "signed" },
      },
      { type: "future_beta_event", data: "preserved" },
      { type: "message_stop" },
    ];
    intercept(
      () =>
        new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const client = factory.createClient("gho_messages_stream", {
      source: "api",
    });
    const accepted = vi.fn();
    const stream = await factory.executeStream(client, request, accepted);
    const received = [];
    for await (const event of stream) received.push(event);
    expect(received).toEqual(events);
    expect(accepted).toHaveBeenCalledOnce();
  });
});
