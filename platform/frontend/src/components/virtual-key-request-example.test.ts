import { describe, expect, it } from "vitest";
import { buildCurlExample } from "./virtual-key-request-example";

const base = "https://archestra.example.com/v1";
const key = "arch_test123";

describe("buildCurlExample", () => {
  it("sends a standard key as the bearer token on the Model Router", () => {
    expect(
      buildCurlExample({
        connectionBaseUrl: base,
        target: { kind: "model-router" },
        keyType: "standard",
        keyValue: key,
        model: "openai:gpt-5.4",
      }),
    ).toBe(`curl "${base}/model-router/chat/completions" \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "openai:gpt-5.4",
    "messages": [
      {
        "role": "user",
        "content": "Hello!"
      }
    ]
  }'`);
  });

  it("uses chat completions with a bearer token for OpenAI-wire providers", () => {
    const example = buildCurlExample({
      connectionBaseUrl: base,
      target: { kind: "provider", provider: "zhipuai" },
      keyType: "standard",
      keyValue: key,
      model: "glm-5.1",
    });
    expect(example).toContain(`curl "${base}/zhipuai/chat/completions"`);
    expect(example).toContain(`-H "Authorization: Bearer ${key}"`);
    expect(example).toContain('"model": "glm-5.1"');
  });

  it("uses Responses for an OpenAI model that requires it", () => {
    const example = buildCurlExample({
      connectionBaseUrl: base,
      target: { kind: "provider", provider: "openai" },
      keyType: "standard",
      keyValue: key,
      model: "gpt-5.6-sol",
    });
    expect(example).toContain(`curl "${base}/openai/responses"`);
    expect(example).toContain('"input": "Hello!"');
    expect(example).not.toContain('"messages"');
  });

  it("uses Responses for a Copilot model published as Responses only", () => {
    const example = buildCurlExample({
      connectionBaseUrl: base,
      target: { kind: "model-router" },
      keyType: "standard",
      keyValue: key,
      model: "github-copilot:gpt-5.4-codex",
      supportedEndpoints: ["/responses"],
    });
    expect(example).toContain(`curl "${base}/model-router/responses"`);
    expect(example).toContain('"input": "Hello!"');
  });

  it("uses the Perplexity Agent API for vendor-prefixed models", () => {
    const example = buildCurlExample({
      connectionBaseUrl: base,
      target: { kind: "provider", provider: "perplexity" },
      keyType: "standard",
      keyValue: key,
      model: "perplexity/glm-5.2",
    });
    expect(example).toContain(`curl "${base}/perplexity/responses"`);
    expect(example).toContain('"input": "Hello!"');
  });

  it("uses each provider's own path and auth header for Anthropic and Gemini", () => {
    const anthropic = buildCurlExample({
      connectionBaseUrl: base,
      target: { kind: "provider", provider: "anthropic" },
      keyType: "standard",
      keyValue: key,
      model: "claude-opus-4-8",
    });
    expect(anthropic).toContain(`curl "${base}/anthropic/v1/messages"`);
    expect(anthropic).toContain(`-H "x-api-key: ${key}"`);
    expect(anthropic).toContain('"max_tokens": 256');

    const gemini = buildCurlExample({
      connectionBaseUrl: base,
      target: { kind: "provider", provider: "gemini" },
      keyType: "standard",
      keyValue: key,
      model: "gemini-3.5-pro",
    });
    expect(gemini).toContain(
      `curl "${base}/gemini/v1beta/models/gemini-3.5-pro:generateContent"`,
    );
    expect(gemini).toContain(`-H "x-goog-api-key: ${key}"`);
  });

  it("keeps the caller's provider key and adds the virtual key header for passthrough keys", () => {
    const example = buildCurlExample({
      connectionBaseUrl: base,
      target: { kind: "provider", provider: "github-copilot" },
      keyType: "passthrough",
      keyValue: key,
      model: "gpt-5.4",
    });
    expect(example).toContain(
      '-H "Authorization: Bearer $GITHUB_COPILOT_API_KEY"',
    );
    expect(example).toContain(`-H "X-Archestra-Virtual-Key: ${key}"`);
  });

  it("has no example for providers whose wire format it does not cover", () => {
    expect(
      buildCurlExample({
        connectionBaseUrl: base,
        target: { kind: "provider", provider: "bedrock" },
        keyType: "standard",
        keyValue: key,
        model: "anthropic.claude",
      }),
    ).toBeNull();
  });
});
