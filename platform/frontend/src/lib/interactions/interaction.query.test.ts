import { describe, expect, it } from "vitest";
import { isSessionId } from "./interaction.query";

// The logs search box only filters by session ID (free-text content search was
// removed), so this predicate decides whether a typed term filters or is
// ignored. Pin the accepted shapes and the rejection of anything else.
describe("isSessionId", () => {
  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";

  it("accepts a bare UUID", () => {
    expect(isSessionId(uuid)).toBe(true);
  });

  it("accepts a scheduled-<UUID> session ID", () => {
    expect(isSessionId(`scheduled-${uuid}`)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSessionId(uuid.toUpperCase())).toBe(true);
  });

  it("rejects arbitrary free-text search terms", () => {
    expect(isSessionId("summarize the quarterly report")).toBe(false);
    expect(isSessionId("gpt-4o")).toBe(false);
    expect(isSessionId("")).toBe(false);
  });

  it("rejects partial or padded UUIDs", () => {
    expect(isSessionId(uuid.slice(0, 8))).toBe(false);
    expect(isSessionId(` ${uuid} `)).toBe(false);
    expect(isSessionId(`session ${uuid}`)).toBe(false);
    // Only the `scheduled-` prefix is allowed, not arbitrary prefixes.
    expect(isSessionId(`task-${uuid}`)).toBe(false);
  });
});
