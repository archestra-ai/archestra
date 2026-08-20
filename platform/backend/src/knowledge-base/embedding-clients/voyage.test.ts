import { HttpResponse, http } from "msw";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  callVoyageEmbedding,
  VoyageEmbeddingError,
  VoyagePartialEmbeddingError,
} from "./voyage";

const VOYAGE_HOST = "https://api.voyageai.com";
const TEXT_URL = `${VOYAGE_HOST}/v1/embeddings`;
const MULTIMODAL_URL = `${VOYAGE_HOST}/v1/multimodalembeddings`;

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

/** One [n, 0.5] vector per input, for whichever endpoint was called. */
function embeddingResponse(count: number) {
  return HttpResponse.json({
    object: "list",
    data: Array.from({ length: count }, (_, i) => ({
      object: "embedding",
      embedding: [i + 1, 0.5],
      index: i,
    })),
    model: "voyage",
    usage: { total_tokens: count * 2 },
  });
}

describe("callVoyageEmbedding", () => {
  const captured: CapturedCall[] = [];

  const capture = async (request: Request) => {
    const body = (await request.json()) as Record<string, unknown>;
    captured.push({
      url: request.url,
      body,
      authorization: request.headers.get("authorization"),
    });
    return body;
  };

  const server = useMswServer(
    http.post(TEXT_URL, async ({ request }) => {
      const body = await capture(request);
      return embeddingResponse((body.input as unknown[]).length);
    }),
    http.post(MULTIMODAL_URL, async ({ request }) => {
      const body = await capture(request);
      return embeddingResponse((body.inputs as unknown[]).length);
    }),
  );

  describe("text models", () => {
    test("sends one ordered call to /v1/embeddings with a bearer key", async () => {
      captured.length = 0;
      const result = await callVoyageEmbedding({
        inputs: ["first text", "second text"],
        model: "voyage-4",
        apiKey: "pa-test-key",
        baseUrl: VOYAGE_HOST,
        dimensions: 1024,
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe(TEXT_URL);
      expect(captured[0].authorization).toBe("Bearer pa-test-key");
      expect(captured[0].body).toMatchObject({
        model: "voyage-4",
        input: ["first text", "second text"],
        // Voyage spells the document side "document", not "search_document".
        input_type: "document",
        truncation: true,
        output_dtype: "float",
        output_dimension: 1024,
      });
      expect(result.data.map((item) => item.embedding)).toEqual([
        [1, 0.5],
        [2, 0.5],
      ]);
      expect(result.usage).toEqual({ prompt_tokens: 4, total_tokens: 4 });
    });

    test("maps the query purpose onto Voyage's own input_type spelling", async () => {
      captured.length = 0;
      await callVoyageEmbedding({
        inputs: ["a query"],
        model: "voyage-4",
        apiKey: "pa-test-key",
        baseUrl: VOYAGE_HOST,
        purpose: "search_query",
      });

      expect(captured[0].body.input_type).toBe("query");
    });

    test("omits output_dimension for a model that fixes its dimension", async () => {
      captured.length = 0;
      await callVoyageEmbedding({
        inputs: ["text"],
        model: "voyage-law-2",
        apiKey: "pa-test-key",
        baseUrl: VOYAGE_HOST,
        dimensions: 1024,
      });

      expect(captured[0].body).not.toHaveProperty("output_dimension");
    });

    test("places vectors by the index the response reports, not arrival order", async () => {
      captured.length = 0;
      server.use(
        http.post(TEXT_URL, async () =>
          HttpResponse.json({
            object: "list",
            // Deliberately shuffled: index is authoritative.
            data: [
              { object: "embedding", embedding: [2, 0.5], index: 1 },
              { object: "embedding", embedding: [1, 0.5], index: 0 },
            ],
            model: "voyage-4",
            usage: { total_tokens: 4 },
          }),
        ),
      );

      const result = await callVoyageEmbedding({
        inputs: ["first", "second"],
        model: "voyage-4",
        apiKey: "pa-test-key",
        baseUrl: VOYAGE_HOST,
      });

      expect(result.data.map((item) => item.embedding)).toEqual([
        [1, 0.5],
        [2, 0.5],
      ]);
    });

    test("rejects image inputs for a text-only model without calling the API", async () => {
      captured.length = 0;
      await expect(
        callVoyageEmbedding({
          inputs: [{ mimeType: "image/png", data: "aW1n" }],
          model: "voyage-4",
          apiKey: "pa-test-key",
          baseUrl: VOYAGE_HOST,
        }),
      ).rejects.toThrow(VoyageEmbeddingError);
      expect(captured).toHaveLength(0);
    });
  });

  describe("multimodal models", () => {
    test("routes text and images to /v1/multimodalembeddings as content items", async () => {
      captured.length = 0;
      const result = await callVoyageEmbedding({
        inputs: ["describe this", { mimeType: "image/png", data: "aW1n" }],
        model: "voyage-multimodal-3.5",
        apiKey: "pa-test-key",
        baseUrl: VOYAGE_HOST,
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe(MULTIMODAL_URL);
      expect(captured[0].body).toMatchObject({
        model: "voyage-multimodal-3.5",
        inputs: [
          { content: [{ type: "text", text: "describe this" }] },
          {
            content: [
              {
                type: "image_base64",
                // Voyage wants a data URL here, not a bare payload.
                image_base64: "data:image/png;base64,aW1n",
              },
            ],
          },
        ],
        input_type: "document",
      });
      expect(result.data).toHaveLength(2);
    });

    test("rejects an image over Voyage's 20MB per-image limit", async () => {
      captured.length = 0;
      // base64 expands 3 bytes into 4 chars, so this decodes to just over 20MB.
      const oversized = "A".repeat(Math.ceil((21 * 1024 * 1024 * 4) / 3));
      await expect(
        callVoyageEmbedding({
          inputs: [{ mimeType: "image/png", data: oversized }],
          model: "voyage-multimodal-3.5",
          apiKey: "pa-test-key",
          baseUrl: VOYAGE_HOST,
        }),
      ).rejects.toThrow(/exceeds the 20MB limit/);
      expect(captured).toHaveLength(0);
    });
  });

  describe("batching", () => {
    test("splits one slice across calls when it exceeds the per-request token budget", async () => {
      captured.length = 0;
      // Each input is first truncated to 85% of the model's 16K context
      // (~13.6K tokens), and voyage-law-2's request budget is 120K at the same
      // margin (~102K) — so the 8th input is the one that forces a second call.
      const bigText = "lorem ipsum dolor sit amet ".repeat(20_000);
      await callVoyageEmbedding({
        inputs: Array.from({ length: 9 }, () => bigText),
        model: "voyage-law-2",
        apiKey: "pa-test-key",
        baseUrl: VOYAGE_HOST,
      });

      expect(captured.length).toBeGreaterThan(1);
      const sent = captured.map((call) => (call.body.input as string[]).length);
      // Every input is sent exactly once, across however many calls it took.
      expect(sent.reduce((a, b) => a + b, 0)).toBe(9);
    });
  });

  describe("failures", () => {
    test("surfaces the provider's `detail` message with its status", async () => {
      server.use(
        http.post(TEXT_URL, () =>
          HttpResponse.json({ detail: "invalid model" }, { status: 400 }),
        ),
      );

      await expect(
        callVoyageEmbedding({
          inputs: ["text"],
          model: "voyage-4",
          apiKey: "pa-test-key",
          baseUrl: VOYAGE_HOST,
        }),
      ).rejects.toMatchObject({
        name: "VoyageEmbeddingError",
        status: 400,
        message: "invalid model",
      });
    });

    test("throws the plain typed error when every call fails", async () => {
      server.use(
        http.post(TEXT_URL, () =>
          HttpResponse.json({ detail: "rate limited" }, { status: 429 }),
        ),
      );

      const error = await callVoyageEmbedding({
        inputs: ["text"],
        model: "voyage-4",
        apiKey: "pa-test-key",
        baseUrl: VOYAGE_HOST,
      }).catch((err) => err);

      // A total outage is not a "partial" — there are no vectors worth banking.
      expect(error).toBeInstanceOf(VoyageEmbeddingError);
      expect(error).not.toBeInstanceOf(VoyagePartialEmbeddingError);
      expect(error.status).toBe(429);
    });

    test("banks the vectors that arrived when only some calls fail", async () => {
      let call = 0;
      server.use(
        http.post(TEXT_URL, async ({ request }) => {
          const body = (await request.json()) as { input: string[] };
          call += 1;
          return call === 1
            ? embeddingResponse(body.input.length)
            : HttpResponse.json({ detail: "boom" }, { status: 500 });
        }),
      );

      // Large enough to span more than one request (see the batching test).
      const bigText = "lorem ipsum dolor sit amet ".repeat(20_000);
      const error = await callVoyageEmbedding({
        inputs: Array.from({ length: 9 }, () => bigText),
        model: "voyage-law-2",
        apiKey: "pa-test-key",
        baseUrl: VOYAGE_HOST,
      }).catch((err) => err);

      expect(error).toBeInstanceOf(VoyagePartialEmbeddingError);
      expect(error.successes.length).toBeGreaterThan(0);
      expect(error.failures.length).toBeGreaterThan(0);
      // Successes and failures together account for every input.
      expect(error.successes.length + error.failures.length).toBe(9);
    });
  });
});
