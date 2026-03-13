import { describe, expect, test } from "@/test";
import { isNoiseRoute } from "./utils";

describe("isNoiseRoute", () => {
  test("should match /health", () => {
    expect(isNoiseRoute("/health")).toBe(true);
  });

  test("should match /ready", () => {
    expect(isNoiseRoute("/ready")).toBe(true);
  });

  test("should match /metrics", () => {
    expect(isNoiseRoute("/metrics")).toBe(true);
  });

  test("should match /metrics with subpath", () => {
    expect(isNoiseRoute("/metrics/prometheus")).toBe(true);
  });

  test("should match /.well-known/oauth- prefixed routes", () => {
    expect(isNoiseRoute("/.well-known/oauth-authorization-server")).toBe(true);
  });

  test("should match /.well-known/oauth-protected-resource", () => {
    expect(
      isNoiseRoute("/.well-known/oauth-protected-resource/v1/mcp/123"),
    ).toBe(true);
  });

  test("should not match API routes", () => {
    expect(isNoiseRoute("/api/agents")).toBe(false);
  });

  test("should not match MCP gateway", () => {
    expect(isNoiseRoute("/v1/mcp/some-profile-id")).toBe(false);
  });

  test("should not match LLM proxy", () => {
    expect(isNoiseRoute("/v1/openai/chat/completions")).toBe(false);
  });

  test("should not match non-oauth well-known routes", () => {
    expect(isNoiseRoute("/.well-known/acme-challenge/token")).toBe(false);
  });
});
