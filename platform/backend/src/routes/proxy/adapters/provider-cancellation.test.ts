import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LLMProvider } from "@/types";
import {
  anthropicAdapterFactory,
  archestraAdapterFactory,
  bedrockAdapterFactory,
  cerebrasAdapterFactory,
  cohereAdapterFactory,
  deepseekAdapterFactory,
  geminiAdapterFactory,
  geminiEmbeddingsAdapterFactory,
  groqAdapterFactory,
  kimiAdapterFactory,
  kimiCodeAdapterFactory,
  minimaxAdapterFactory,
  mistralAdapterFactory,
  ollamaAdapterFactory,
  openAiResponsesAdapterFactory,
  openaiAdapterFactory,
  openrouterAdapterFactory,
  perplexityAdapterFactory,
  perplexityResponsesAdapterFactory,
  vllmAdapterFactory,
  xaiAdapterFactory,
  zhipuaiAdapterFactory,
} from "./index";

const chatRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "Count slowly" }],
};
const cases: Array<{
  adapter: Pick<
    LLMProvider<never, unknown, unknown, unknown, unknown>,
    | "provider"
    | "interactionType"
    | "createClient"
    | "execute"
    | "executeStream"
  >;
  request: object;
  streams?: boolean;
}> = [
  ...[
    archestraAdapterFactory,
    cerebrasAdapterFactory,
    deepseekAdapterFactory,
    groqAdapterFactory,
    kimiAdapterFactory,
    kimiCodeAdapterFactory,
    minimaxAdapterFactory,
    mistralAdapterFactory,
    ollamaAdapterFactory,
    openaiAdapterFactory,
    openrouterAdapterFactory,
    perplexityAdapterFactory,
    vllmAdapterFactory,
    xaiAdapterFactory,
    zhipuaiAdapterFactory,
  ].map((adapter) => ({ adapter, request: chatRequest })),
  {
    adapter: anthropicAdapterFactory,
    request: { ...chatRequest, max_tokens: 100 },
  },
  {
    adapter: openAiResponsesAdapterFactory,
    request: { model: "test-model", input: "Count slowly" },
  },
  {
    adapter: perplexityResponsesAdapterFactory,
    request: { model: "test-model", input: "Count slowly" },
  },
  {
    adapter: geminiAdapterFactory,
    request: {
      _model: "test-model",
      contents: [{ role: "user", parts: [{ text: "Count slowly" }] }],
    },
  },
  {
    adapter: geminiEmbeddingsAdapterFactory,
    request: { model: "test-model", input: "Count slowly" },
    streams: false,
  },
  { adapter: cohereAdapterFactory, request: chatRequest },
  {
    adapter: bedrockAdapterFactory,
    request: {
      modelId: "test-model",
      messages: [{ role: "user", content: [{ text: "Count slowly" }] }],
    },
  },
];

// Real SDKs and TCP; no provider credentials or model generation. The upstream
// deliberately stalls so cancellation must interrupt both headers and body I/O.
describe("provider transport cancellation", () => {
  let upstream: Server | undefined;
  let response: ServerResponse | undefined;
  let pending: Promise<unknown> | undefined;
  afterEach(async () => {
    response?.destroy();
    upstream?.closeAllConnections();
    await new Promise<void>((resolve) =>
      upstream ? upstream.close(() => resolve()) : resolve(),
    );
    await pending;
    upstream = undefined;
    response = undefined;
    pending = undefined;
  });

  for (const { adapter, request, streams = true } of cases) {
    for (const stream of streams ? [false, true] : [false]) {
      test(`${adapter.interactionType} cancels ${stream ? "stream body" : "pending response"}`, async () => {
        const controller = new AbortController();
        let closed = false;
        let requests = 0;
        let received!: () => void;
        const requestReceived = new Promise<void>((resolve) => {
          received = resolve;
        });
        upstream = createServer((req, res) => {
          requests++;
          response = res;
          req.resume();
          req.on("end", () => {
            res.on("close", () => {
              closed = true;
            });
            if (stream) {
              res.writeHead(200, {
                "content-type":
                  adapter.provider === "bedrock"
                    ? "application/vnd.amazon.eventstream"
                    : "text/event-stream",
              });
              res.flushHeaders();
            }
            received();
          });
        });
        await new Promise<void>((resolve, reject) => {
          upstream?.once("error", reject);
          upstream?.listen(0, "127.0.0.1", resolve);
        });
        const address = upstream.address();
        if (!address || typeof address === "string")
          throw new Error("Expected TCP address");
        const client = adapter.createClient("synthetic-key", {
          baseUrl: `http://127.0.0.1:${address.port}`,
          source: "api",
          abortSignal: controller.signal,
        });
        let settled = false;
        pending = (async () => {
          if (stream) {
            const events = await adapter.executeStream(
              client,
              request as never,
            );
            for await (const _event of events) {
              /* consume until aborted */
            }
          } else {
            await adapter.execute(client, request as never);
          }
        })()
          .catch((error: unknown) => error)
          .finally(() => {
            settled = true;
          });
        await Promise.race([
          requestReceived,
          pending.then(() => {
            throw new Error(
              "Provider call settled before reaching the controlled upstream",
            );
          }),
        ]);
        expect(settled).toBe(false);
        controller.abort();
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1500 });
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1500 });
        expect(requests).toBe(1);
      });
    }
  }
});
