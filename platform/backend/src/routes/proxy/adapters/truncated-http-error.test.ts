import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { afterEach, describe, expect, test } from "vitest";
import { BedrockClient } from "@/clients/bedrock-client";
import { isRetryableUpstreamConnectionFailure } from "../llm-proxy-helpers";
import {
  openUpstreamWithRetry,
  withFirstChunk,
} from "../upstream-connection-retry";
import { cohereAdapterFactory } from "./cohere";
import { minimaxAdapterFactory } from "./minimax";
import { zhipuaiAdapterFactory } from "./zhipuai";

const generationPaths: Array<{
  name: string;
  open: (baseUrl: string) => Promise<unknown>;
}> = [
  ...(["converse", "converseStream", "invoke", "invokeStream"] as const).map(
    (method) => ({
      name: `bedrock ${method}`,
      open: (baseUrl: string) => {
        const client = new BedrockClient({
          baseUrl,
          region: "us-east-1",
          apiKey: "test-key",
        });
        return client[method]("test-model", {});
      },
    }),
  ),
  ...[
    cohereAdapterFactory,
    minimaxAdapterFactory,
    zhipuaiAdapterFactory,
  ].flatMap((factory) =>
    [false, true].map((streaming) => ({
      name: `${factory.provider} ${streaming ? "streaming" : "non-streaming"}`,
      open: async (baseUrl: string) => {
        const client = factory.createClient("test-key", {
          baseUrl,
          source: "api",
        });
        const request = { model: "test-model", messages: [] };
        return streaming
          ? withFirstChunk<unknown>(
              await factory.executeStream(client, request),
            )
          : factory.execute(client, request);
      },
    })),
  ),
];

describe("provider HTTP errors with unreadable bodies", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  describe.each(generationPaths)("$name", ({ open }) => {
    test.each([
      429, 500,
    ])("preserves HTTP %i and does not retry a truncated error body", async (status) => {
      let requests = 0;
      server = createServer((_request, response) => {
        requests++;
        response.writeHead(status, {
          "content-type": "application/json",
          "content-length": "1000",
          "retry-after": "30",
        });
        response.write('{"message":"partial');
        // Let native fetch receive the HTTP status before truncating the body.
        setTimeout(() => response.destroy(), 25);
      });
      await new Promise<void>((resolve) => {
        server?.listen(0, "127.0.0.1", resolve);
      });
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const error = await openUpstreamWithRetry({
        open: () => open(baseUrl),
        isRetryable: isRetryableUpstreamConnectionFailure,
        shouldContinue: () => true,
        delaysMs: [0, 0],
      }).then(
        () => {
          throw new Error("Expected the provider request to fail");
        },
        (error: unknown) => error,
      );

      expect(error).toBeInstanceOf(Error);
      const httpError = error as Error & {
        status?: number;
        statusCode?: number;
      };
      expect(httpError.status ?? httpError.statusCode).toBe(status);
      expect(isRetryableUpstreamConnectionFailure(error)).toBe(false);
      expect(requests).toBe(1);
    });
  });

  test("does not retry a first Bedrock exception event whose message names a connection reset", async () => {
    const codec = new EventStreamCodec(
      (input) => new TextDecoder().decode(input),
      (input) => new TextEncoder().encode(input),
    );
    const frame = codec.encode({
      headers: {
        ":message-type": { type: "string", value: "exception" },
        ":exception-type": {
          type: "string",
          value: "modelStreamErrorException",
        },
      },
      body: new TextEncoder().encode(
        JSON.stringify({ message: "connection reset" }),
      ),
    });
    let requests = 0;
    server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, {
        "content-type": "application/vnd.amazon.eventstream",
      });
      response.end(frame);
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const client = new BedrockClient({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      region: "us-east-1",
      apiKey: "test-key",
    });
    await expect(
      openUpstreamWithRetry({
        open: async () =>
          withFirstChunk(await client.invokeStream("test-model", {})),
        isRetryable: isRetryableUpstreamConnectionFailure,
        shouldContinue: () => true,
        delaysMs: [0, 0],
      }),
    ).rejects.toMatchObject({
      error: { type: "modelStreamErrorException" },
    });
    expect(requests).toBe(1);
  });
});
