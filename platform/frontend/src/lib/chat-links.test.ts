import { describe, expect, it } from "vitest";
import { isValidChatLinkUrl } from "./chat-links";

describe("isValidChatLinkUrl", () => {
  it("accepts valid https URLs", () => {
    expect(
      isValidChatLinkUrl("https://support.example.com/docs/getting-started"),
    ).toBe(true);
  });

  it("accepts valid http URLs", () => {
    expect(isValidChatLinkUrl("http://localhost:8080/help")).toBe(true);
  });

  it("rejects invalid URLs", () => {
    expect(isValidChatLinkUrl("not-a-url")).toBe(false);
  });

  it("rejects non-http protocols", () => {
    expect(isValidChatLinkUrl("ftp://example.com/help")).toBe(false);
  });
});
