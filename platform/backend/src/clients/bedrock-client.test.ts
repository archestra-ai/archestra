import { beforeEach, describe, expect, it, vi } from "vitest";
import { BedrockClient } from "./bedrock-client";

// Stub fetch at the process boundary (no module mocks) so this file stays in
// the fast "clean" vitest project. Re-applied per test because unstubGlobals
// auto-reverts after each test.
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function makeClient() {
  return new BedrockClient({
    baseUrl: "https://bedrock.example.com",
    region: "us-east-1",
    // apiKey path skips SigV4 signing: signedFetch just sets a Bearer header.
    apiKey: "test-key",
  });
}

type ThrownError = Error & { statusCode?: number; responseBody?: string };

async function catchError(promise: Promise<unknown>): Promise<ThrownError> {
  return promise.then(
    () => {
      throw new Error("expected the request to reject");
    },
    (e) => e as ThrownError,
  );
}

describe("BedrockClient non-OK error messages", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  describe("converse", () => {
    it("does not surface an opaque `{}` when the error body is a message-less JSON object", async () => {
      fetchMock.mockResolvedValue(new Response("{}", { status: 400 }));

      const err = await catchError(makeClient().converse("model", {}));

      // The regression: `{}` used to become the Error message verbatim.
      expect(err.message).toBe("Bedrock API error: 400");
      expect(err.message).not.toBe("{}");
      // The raw body is still preserved for callers that want it.
      expect(err.statusCode).toBe(400);
      expect(err.responseBody).toBe("{}");
    });

    it("falls back to the status when the error body is empty", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 502 }));

      const err = await catchError(makeClient().converse("model", {}));

      expect(err.message).toBe("Bedrock API error: 502");
    });

    it("includes the embedded AWS message when present", async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            message: "prompt is too long",
            __type: "ValidationException",
          }),
          { status: 400 },
        ),
      );

      const err = await catchError(makeClient().converse("model", {}));

      expect(err.message).toBe("Bedrock API error (400): prompt is too long");
    });

    it("uses a non-JSON body verbatim as the detail", async () => {
      fetchMock.mockResolvedValue(
        new Response("Rate exceeded", { status: 429 }),
      );

      const err = await catchError(makeClient().converse("model", {}));

      expect(err.message).toBe("Bedrock API error (429): Rate exceeded");
    });
  });

  describe("converseStream", () => {
    it("does not surface an opaque `{}` when the error body is a message-less JSON object", async () => {
      fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));

      const err = await catchError(makeClient().converseStream("model", {}));

      expect(err.message).toBe("Bedrock API error: 500");
      expect(err.message).not.toBe("{}");
      expect(err.statusCode).toBe(500);
    });

    it("falls back to the __type when the body has no message field", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ __type: "ThrottlingException" }), {
          status: 429,
        }),
      );

      const err = await catchError(makeClient().converseStream("model", {}));

      expect(err.message).toBe("Bedrock API error (429): ThrottlingException");
    });
  });
});
