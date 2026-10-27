import { createServer } from "node:http";
import OpenAI from "openai";
import { describe, expect, test } from "vitest";
import { createFastifyInstance } from "@/fastify-instance";
import { OpenAi } from "@/types";
import {
  EmbeddingWireResponseSchema,
  withEmbeddingEncoding,
} from "./embeddings-wire";
import { openAiEmbeddingsAdapterFactory } from "./openai";

describe("embedding wire encoding", () => {
  test.each([
    "",
    "!!!!",
    "aQ==",
    "not-base64",
    "AADAfw==",
  ])("rejects malformed upstream base64 vector %s", (embedding) => {
    const factory = withEmbeddingEncoding(
      openAiEmbeddingsAdapterFactory,
      "base64",
    );
    expect(() =>
      factory.createResponseAdapter({
        object: "list",
        model: "vector-model",
        data: [
          {
            object: "embedding",
            index: 0,
            embedding: embedding as unknown as number[],
          },
        ],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    ).toThrow();
  });
  test("real SDK default, float and base64 requests retain values and numeric log previews", async () => {
    const vector = [0.25, -0.5, 1.5];
    const bytes = Buffer.alloc(vector.length * 4);
    vector.forEach((value, index) => {
      bytes.writeFloatLE(value, index * 4);
    });
    const base64 = bytes.toString("base64");
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      expect(request.headers.authorization).toBe(
        "Bearer synthetic-provider-key",
      );
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          object: "list",
          model: "vector-model",
          data: [
            {
              object: "embedding",
              index: 0,
              embedding: body.encoding_format === "base64" ? base64 : vector,
            },
          ],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const port = upstream.address();
    if (!port || typeof port === "string") throw new Error("No upstream port");
    const app = createFastifyInstance();
    app.post(
      "/embeddings",
      {
        schema: {
          body: OpenAi.API.EmbeddingRequestSchema,
          response: { 200: EmbeddingWireResponseSchema },
        },
      },
      async (request) => {
        const body = OpenAi.API.EmbeddingRequestSchema.parse(request.body);
        const factory = withEmbeddingEncoding(
          openAiEmbeddingsAdapterFactory,
          body.encoding_format,
        );
        const client = factory.createClient("synthetic-provider-key", {
          source: "api",
          baseUrl: `http://127.0.0.1:${port.port}`,
        });
        const result = await factory.execute(client, body);
        const adapter = factory.createResponseAdapter(result);
        expect(adapter.getLoggedResponse?.().data[0].embedding).toEqual(vector);
        return adapter.getOriginalResponse();
      },
    );
    await app.listen({ port: 0, host: "127.0.0.1" });
    const appPort = app.server.address();
    if (!appPort || typeof appPort === "string") throw new Error("No app port");
    const client = new OpenAI({
      apiKey: "synthetic-router-key",
      baseURL: `http://127.0.0.1:${appPort.port}`,
      maxRetries: 0,
    });
    try {
      expect(
        (
          await client.embeddings.create({
            model: "vector-model",
            input: "hello",
          })
        ).data[0].embedding,
      ).toEqual(vector);
      expect(
        (
          await client.embeddings.create({
            model: "vector-model",
            input: "hello",
            encoding_format: "float",
          })
        ).data[0].embedding,
      ).toEqual(vector);
      expect(
        (
          await client.embeddings.create({
            model: "vector-model",
            input: "hello",
            encoding_format: "base64",
          })
        ).data[0].embedding,
      ).toBe(base64);
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
