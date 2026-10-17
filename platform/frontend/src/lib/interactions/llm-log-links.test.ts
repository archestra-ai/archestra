// @vitest-environment node
import { describe, expect, it } from "vitest";
import { llmRequestHref, llmSessionHref } from "./llm-log-links";

describe("llmSessionHref", () => {
  it("encodes a session id that is not URL-safe", () => {
    expect(llmSessionHref("user:abc|ses 1")).toBe(
      "/llm/logs/user%3Aabc%7Cses%201",
    );
  });

  it("preselects a tool call", () => {
    expect(llmSessionHref("s1", { toolCall: "call/1" })).toBe(
      "/llm/logs/s1?toolCall=call%2F1",
    );
  });
});

describe("llmRequestHref", () => {
  it("opens a request in its session, preselected", () => {
    expect(llmRequestHref({ id: "req-1", sessionId: "slack-C1-1.2" })).toBe(
      "/llm/logs/slack-C1-1.2?request=req-1",
    );
  });

  it("opens a sessionless request as its own session", () => {
    expect(llmRequestHref({ id: "req-1", sessionId: null })).toBe(
      "/llm/logs/req-1",
    );
  });
});
