import { describe, expect, test } from "vitest";
import { buildAnthropicVertexRequest } from "./anthropic-vertex-request";

describe("buildAnthropicVertexRequest", () => {
  test("rewrites a Messages request to Vertex rawPredict with Google auth", async () => {
    const request = await buildAnthropicVertexRequest({
      input: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer caller-token",
          "x-api-key": "caller-key",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
          "x-custom-header": "preserved",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 32,
          messages: [{ role: "user", content: "Hello" }],
        }),
      },
      project: "test-project",
      location: "global",
      authHeaders: {
        Authorization: "Bearer google-token",
        "x-goog-user-project": "test-project",
      },
    });

    expect(request.url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/anthropic/models/claude-sonnet-5:rawPredict",
    );
    expect(await request.json()).toEqual({
      anthropic_version: "vertex-2023-10-16",
      max_tokens: 32,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(request.headers.get("Authorization")).toBe("Bearer google-token");
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(request.headers.get("anthropic-version")).toBeNull();
    expect(request.headers.get("anthropic-beta")).toBeNull();
    expect(request.headers.get("x-custom-header")).toBe("preserved");
    expect(request.headers.get("x-goog-user-project")).toBe("test-project");
  });

  test("uses streamRawPredict and preserves the stream flag", async () => {
    const request = await buildAnthropicVertexRequest({
      input: "https://us-east5-aiplatform.googleapis.com/v1/v1/messages",
      init: {
        method: "POST",
        body: JSON.stringify({
          model: "claude-sonnet-4-5@20250929",
          stream: true,
          anthropic_version: "custom-version",
          messages: [],
        }),
      },
      project: "test-project",
      location: "us-east5",
      authHeaders: { Authorization: "Bearer google-token" },
    });

    expect(request.url).toBe(
      "https://us-east5-aiplatform.googleapis.com/v1/projects/test-project/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:streamRawPredict",
    );
    expect(await request.json()).toEqual({
      stream: true,
      anthropic_version: "custom-version",
      messages: [],
    });
  });

  test("rejects model IDs that could escape the publisher-model path", async () => {
    await expect(
      buildAnthropicVertexRequest({
        input: "https://api.anthropic.com/v1/messages",
        init: {
          method: "POST",
          body: JSON.stringify({ model: "../endpoints/other" }),
        },
        project: "test-project",
        location: "global",
        authHeaders: {},
      }),
    ).rejects.toThrow("Invalid Anthropic Vertex AI model ID");
  });
});
