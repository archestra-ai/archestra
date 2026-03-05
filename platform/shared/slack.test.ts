import { describe, expect, test } from "vitest";
import { SLACK_REQUIRED_BOT_SCOPES } from "./slack";

describe("SLACK_REQUIRED_BOT_SCOPES", () => {
  test("includes files:read scope", () => {
    expect(SLACK_REQUIRED_BOT_SCOPES).toContain("files:read");
  });

  test("includes all core scopes for chatops functionality", () => {
    const coreScopes = [
      "chat:write",
      "app_mentions:read",
      "channels:history",
      "im:history",
      "users:read",
    ];
    for (const scope of coreScopes) {
      expect(SLACK_REQUIRED_BOT_SCOPES).toContain(scope);
    }
  });

  test("has no duplicate entries", () => {
    const unique = new Set(SLACK_REQUIRED_BOT_SCOPES);
    expect(unique.size).toBe(SLACK_REQUIRED_BOT_SCOPES.length);
  });
});
