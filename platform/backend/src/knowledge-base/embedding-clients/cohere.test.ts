import { HttpResponse, http } from "msw";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  CohereEmbeddingError,
  CoherePartialEmbeddingError,
  callCohereEmbedding,
} from "./cohere";

const COHERE_HOST = "https://api.cohere.com";
const EMBED_URL = `${COHERE_HOST}/v2/embed`;

interface CapturedCall {
  body: Record<string, unknown>;
  authorization: string | null;
}

describe("callCohereEmbedding", () => {
  const captured: CapturedCall[] = [];

  // Default handler: one [n, 0.5] vector per input, whichever request shape.
  const server = useMswServer(
    http.post(EMBED_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      captured.push({
        body,
        authorization: request.headers.get("authorization"),
      });
      const count = Array.isArray(body.inputs)
        ? body.inputs.length
        : Array.isArray(body.texts)
          ? body.texts.length
          : Array.isArray(body.images)
            ? body.images.length
            : 0;
      return HttpResponse.json({
        id: "req",
        embeddings: {
          float: Array.from({ length: count }, (_, i) => [i + 1, 0.5]),
        },
        meta: { billed_units: { input_tokens: count * 2 } },
      });
    }),
  );

  describe("Embed v4", () => {
    test("sends mixed text and image inputs in one ordered call with a bearer key", async () => {
      captured.length = 0;
      const result = await callCohereEmbedding({
        inputs: [
          "first text",
          { mimeType: "image/png", data: "aW1n" },
          "second text",
        ],
        model: "embed-v4.0",
        apiKey: "co-test-key",
        baseUrl: COHERE_HOST,
        dimensions: 1024,
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].authorization).toBe("Bearer co-test-key");
      expect(captured[0].body).toMatchObject({
        model: "embed-v4.0",
        input_type: "search_document",
        embedding_types: ["float"],
        output_dimension: 1024,
        inputs: [
          { content: [{ type: "text", text: "first text" }] },
          {
            content: [
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,aW1n" },
              },
            ],
          },
          { content: [{ type: "text", text: "second text" }] },
        ],
      });
      // No v3-only fields leak into the v4 request.
      expect(captured[0].body).not.toHaveProperty("texts");
      expect(captured[0].body).not.toHaveProperty("truncate");

      expect(result.data.map((item) => item.embedding)).toEqual([
        [1, 0.5],
        [2, 0.5],
        [3, 0.5],
      ]);
      expect(result.usage.prompt_tokens).toBe(6);
    });

    test("omits output_dimension for a dimension the model does not offer", async () => {
      captured.length = 0;
      await callCohereEmbedding({
        inputs: ["text"],
        model: "embed-v4.0",
        apiKey: "k",
        baseUrl: COHERE_HOST,
        dimensions: 768,
      });
      expect(captured[0].body).not.toHaveProperty("output_dimension");
    });

    test("splits inputs into batches of at most 96 and reassembles in order", async () => {
      captured.length = 0;
      const inputs = Array.from({ length: 100 }, (_, i) => `text ${i}`);
      const result = await callCohereEmbedding({
        inputs,
        model: "embed-v4.0",
        apiKey: "k",
        baseUrl: COHERE_HOST,
      });
      expect(captured).toHaveLength(2);
      expect((captured[0].body.inputs as unknown[]).length).toBe(96);
      expect((captured[1].body.inputs as unknown[]).length).toBe(4);
      expect(result.data).toHaveLength(100);
      // The second batch's vectors restart at [1, 0.5] — index 96 is the first
      // item of the second call.
      expect(result.data[96].embedding).toEqual([1, 0.5]);
      expect(result.data[95].embedding).toEqual([96, 0.5]);
    });

    test("starts a new batch when the images in one call would exceed 20MB", async () => {
      captured.length = 0;
      // Four 6MB (base64; ~4.5MB decoded, under the per-image cap) images: the
      // fourth would push one call past the combined cap, so it goes into a
      // second request.
      const big = "A".repeat(6 * 1024 * 1024);
      await callCohereEmbedding({
        inputs: [
          { mimeType: "image/jpeg", data: big },
          { mimeType: "image/jpeg", data: big },
          { mimeType: "image/jpeg", data: big },
          { mimeType: "image/jpeg", data: big },
        ],
        model: "embed-v4.0",
        apiKey: "k",
        baseUrl: COHERE_HOST,
      });
      expect(captured).toHaveLength(2);
      expect((captured[0].body.inputs as unknown[]).length).toBe(3);
      expect((captured[1].body.inputs as unknown[]).length).toBe(1);
    });

    test("embeds queries as search_query", async () => {
      captured.length = 0;
      await callCohereEmbedding({
        inputs: ["what is in the diagram?"],
        model: "embed-v4.0",
        apiKey: "k",
        baseUrl: COHERE_HOST,
        purpose: "search_query",
      });
      expect(captured[0].body.input_type).toBe("search_query");
    });
  });

  describe("Embed v3", () => {
    test("batches texts into one call and gives each image its own call", async () => {
      captured.length = 0;
      const result = await callCohereEmbedding({
        inputs: [
          "first text",
          { mimeType: "image/jpeg", data: "aW1n" },
          "second text",
          { mimeType: "image/png", data: "cG5n" },
        ],
        model: "embed-english-v3.0",
        apiKey: "k",
        baseUrl: COHERE_HOST,
        dimensions: 1024,
      });

      const textCalls = captured.filter((call) => "texts" in call.body);
      const imageCalls = captured.filter((call) => "images" in call.body);
      expect(textCalls).toHaveLength(1);
      expect(textCalls[0].body).toMatchObject({
        model: "embed-english-v3.0",
        texts: ["first text", "second text"],
        input_type: "search_document",
        embedding_types: ["float"],
        truncate: "END",
      });
      // Fixed-dimension model: the parameter is never sent.
      expect(textCalls[0].body).not.toHaveProperty("output_dimension");
      expect(imageCalls).toHaveLength(2);
      expect(imageCalls.map((call) => call.body)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            images: ["data:image/jpeg;base64,aW1n"],
            input_type: "image",
          }),
          expect.objectContaining({
            images: ["data:image/png;base64,cG5n"],
            input_type: "image",
          }),
        ]),
      );

      // Results reassemble in input order: texts at 0 and 2, images at 1 and 3.
      expect(result.data.map((item) => item.embedding)).toEqual([
        [1, 0.5],
        [1, 0.5],
        [2, 0.5],
        [1, 0.5],
      ]);
    });

    test("rejects an image over the 5MB limit before calling the API", async () => {
      captured.length = 0;
      await expect(
        callCohereEmbedding({
          inputs: [
            { mimeType: "image/jpeg", data: "A".repeat(7 * 1024 * 1024) },
          ],
          model: "embed-english-v3.0",
          apiKey: "k",
          baseUrl: COHERE_HOST,
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: /exceeds the 5MB limit/,
      });
      expect(captured).toHaveLength(0);
    });
  });

  describe("unknown models", () => {
    test("takes the text path and rejects images with a typed 400", async () => {
      captured.length = 0;
      await callCohereEmbedding({
        inputs: ["text"],
        model: "embed-english-v2.0",
        apiKey: "k",
        baseUrl: COHERE_HOST,
      });
      expect(captured[0].body).toMatchObject({
        texts: ["text"],
        input_type: "search_document",
      });

      await expect(
        callCohereEmbedding({
          inputs: [{ mimeType: "image/png", data: "aW1n" }],
          model: "embed-english-v2.0",
          apiKey: "k",
          baseUrl: COHERE_HOST,
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: /doesn't support embedding image inputs/,
      });
    });
  });

  describe("URL and errors", () => {
    test("normalizes a versioned base URL onto /v2/embed", async () => {
      captured.length = 0;
      await callCohereEmbedding({
        inputs: ["text"],
        model: "embed-v4.0",
        apiKey: "k",
        baseUrl: `${COHERE_HOST}/v1/`,
      });
      expect(captured).toHaveLength(1);
    });

    test("surfaces the provider's message and status as a typed error", async () => {
      server.use(
        http.post(EMBED_URL, () =>
          HttpResponse.json({ message: "invalid api token" }, { status: 401 }),
        ),
      );
      await expect(
        callCohereEmbedding({
          inputs: ["text"],
          model: "embed-v4.0",
          apiKey: "bad",
          baseUrl: COHERE_HOST,
        }),
      ).rejects.toMatchObject({
        status: 401,
        message: "invalid api token",
      });
    });

    test("a failed batch surfaces as a partial error carrying the other batches' vectors", async () => {
      let calls = 0;
      server.use(
        http.post(EMBED_URL, async ({ request }) => {
          const body = (await request.json()) as { inputs: unknown[] };
          calls++;
          // The second (4-item) batch is rate-limited; the first succeeds.
          if (body.inputs.length === 4) {
            return HttpResponse.json(
              { message: "rate limited" },
              { status: 429 },
            );
          }
          return HttpResponse.json({
            embeddings: {
              float: body.inputs.map((_, i) => [i + 1, 0.5]),
            },
            meta: { billed_units: { input_tokens: 96 } },
          });
        }),
      );
      const inputs = Array.from({ length: 100 }, (_, i) => `text ${i}`);
      const error = await callCohereEmbedding({
        inputs,
        model: "embed-v4.0",
        apiKey: "k",
        baseUrl: COHERE_HOST,
      }).catch((err: unknown) => err);

      expect(calls).toBe(2);
      expect(error).toBeInstanceOf(CoherePartialEmbeddingError);
      const partial = error as CoherePartialEmbeddingError;
      expect(partial.status).toBe(429);
      expect(partial.successes).toHaveLength(96);
      expect(partial.failures.map((failure) => failure.index)).toEqual([
        96, 97, 98, 99,
      ]);
      expect(partial.failures[0].reason).toBeInstanceOf(CohereEmbeddingError);
      expect(partial.tokens).toBe(96);
    });

    test("a vector count mismatch is a 500", async () => {
      server.use(
        http.post(EMBED_URL, () =>
          HttpResponse.json({ embeddings: { float: [[0.1, 0.2]] } }),
        ),
      );
      const error = await callCohereEmbedding({
        inputs: ["a", "b"],
        model: "embed-v4.0",
        apiKey: "k",
        baseUrl: COHERE_HOST,
      }).catch((err: unknown) => err);
      // A total failure is the plain typed error, not a partial one.
      expect(error).toBeInstanceOf(CohereEmbeddingError);
      expect(error).not.toBeInstanceOf(CoherePartialEmbeddingError);
      expect((error as CohereEmbeddingError).status).toBe(500);
    });
  });
});
