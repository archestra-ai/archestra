import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "@/test";
import { anthropicAdapterFactory } from "./anthropic";
import { archestraAdapterFactory } from "./archestra";
import { cerebrasAdapterFactory } from "./cerebras";
import { deepseekAdapterFactory } from "./deepseek";
import { groqAdapterFactory } from "./groq";
import { kimiAdapterFactory } from "./kimi";
import { mistralAdapterFactory } from "./mistral";
import { ollamaAdapterFactory } from "./ollama";
import { openaiAdapterFactory } from "./openai";
import { openrouterAdapterFactory } from "./openrouter";
import { vllmAdapterFactory } from "./vllm";
import { xaiAdapterFactory } from "./xai";

/**
 * The incident this pins: Moonshot answered a chat stream with a
 * tokens-per-day 429 whose Retry-After pointed at the daily quota reset,
 * hours away. The openai SDK honors Retry-After with no upper bound, so with
 * SDK retries enabled the request slept inside `executeStream` instead of
 * rejecting — the proxy request never resolved and the chat UI spun forever.
 * The proxy must relay the 429 immediately; retry policy belongs to callers.
 */
describe("proxy SDK clients do not retry upstream errors", () => {
  let server: Server;
  let baseUrl: string;
  let requestCount: number;

  beforeAll(async () => {
    requestCount = 0;
    server = createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(429, {
        "content-type": "application/json",
        // Daily-quota reset far in the future; an SDK that obeys this
        // header before retrying hangs the request for hours.
        "retry-after": "86400",
      });
      res.end(
        JSON.stringify({
          error: {
            message: "request reached organization TPD rate limit",
            type: "rate_limit_reached_error",
          },
        }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  test("a rate-limited streaming request rejects immediately instead of sleeping on Retry-After", {
    timeout: 5000,
  }, async () => {
    const client = kimiAdapterFactory.createClient("test-key", {
      baseUrl,
      source: "api",
    });

    const startTime = Date.now();
    await expect(
      kimiAdapterFactory.executeStream(client, {
        model: "kimi-k2.6",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    ).rejects.toMatchObject({ status: 429 });

    // Well under the 86400s Retry-After and the SDK's own backoff floor.
    expect(Date.now() - startTime).toBeLessThan(2000);
    expect(requestCount).toBe(1);
  });

  test("every OpenAI-based adapter client is constructed with retries disabled", () => {
    const factories = [
      archestraAdapterFactory,
      cerebrasAdapterFactory,
      deepseekAdapterFactory,
      groqAdapterFactory,
      kimiAdapterFactory,
      mistralAdapterFactory,
      ollamaAdapterFactory,
      openaiAdapterFactory,
      openrouterAdapterFactory,
      vllmAdapterFactory,
      xaiAdapterFactory,
    ];
    for (const factory of factories) {
      const client = factory.createClient("test-key", {
        baseUrl,
        source: "api",
      }) as { maxRetries: number };
      expect(client.maxRetries, factory.provider).toBe(0);
    }
  });

  test("the Anthropic adapter client is constructed with retries disabled", () => {
    const client = anthropicAdapterFactory.createClient("test-key", {
      baseUrl,
      source: "api",
    }) as { maxRetries: number };
    expect(client.maxRetries).toBe(0);
  });
});
