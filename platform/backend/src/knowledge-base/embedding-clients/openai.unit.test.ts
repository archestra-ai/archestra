import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import { callOpenAIEmbedding } from "./openai";

const BASE_URL = "https://embed.example.com/v1";
const DIMENSIONS = 1536;

describe("callOpenAIEmbedding vector decoding", () => {
  // Values that survive a float32 round trip exactly, so the decoded vector
  // can be compared with strict equality.
  const vector = Array.from(
    { length: DIMENSIONS },
    (_, i) => Math.fround(Math.sin(i + 1)) * 0.5,
  ).map(Math.fround);

  let responseEmbedding: string | number[] = [];
  const requestedFormats: unknown[] = [];
  useMswServer(
    http.post(`${BASE_URL}/embeddings`, async ({ request }) => {
      const body = (await request.json()) as { encoding_format?: unknown };
      requestedFormats.push(body.encoding_format);
      return HttpResponse.json({
        object: "list",
        data: [{ object: "embedding", embedding: responseEmbedding, index: 0 }],
        model: "m",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }),
  );

  test("decodes a base64 float32 payload into the full vector", async () => {
    responseEmbedding = encodeFloat32Base64(vector);

    const response = await embed();

    expect(requestedFormats.at(-1)).toBe("base64");
    expect(response.data[0].embedding).toHaveLength(DIMENSIONS);
    expect(response.data[0].embedding).toEqual(vector);
  });

  test("keeps a JSON float array from a provider that ignores encoding_format", async () => {
    responseEmbedding = vector;

    const response = await embed();

    expect(response.data[0].embedding).toHaveLength(DIMENSIONS);
    expect(response.data[0].embedding).toEqual(vector);
  });
});

function embed() {
  return callOpenAIEmbedding({
    inputs: ["hello"],
    model: "text-embedding-3-small",
    apiKey: "k",
    baseUrl: BASE_URL,
    dimensions: DIMENSIONS,
  });
}

function encodeFloat32Base64(values: number[]): string {
  const floats = new Float32Array(values);
  return Buffer.from(
    floats.buffer,
    floats.byteOffset,
    floats.byteLength,
  ).toString("base64");
}
