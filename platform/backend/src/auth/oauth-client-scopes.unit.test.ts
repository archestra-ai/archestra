import { describe, expect, test } from "vitest";
import { requestedOauthClientScopes } from "./oauth-client-scopes";

describe("OAuth token scope selection", () => {
  test("issues exactly the requested subset, deduplicated", () => {
    expect(
      requestedOauthClientScopes({
        granted: ["mcp", "a2a", "llm:proxy"],
        requested: "mcp  llm:proxy mcp",
      }),
    ).toEqual(["mcp", "llm:proxy"]);
  });
  test("uses configured capabilities only when scope is omitted", () => {
    expect(requestedOauthClientScopes({ granted: ["a2a"] })).toEqual(["a2a"]);
  });
  test.each([
    "llm:proxy",
    "mcp llm:proxy",
    "openid",
    "",
    "   ",
  ])("refuses ungranted or empty scopes: %s", (requested) => {
    expect(
      requestedOauthClientScopes({ granted: ["mcp"], requested }),
    ).toBeNull();
  });
  test("a client with no granted scopes cannot issue a token", () => {
    expect(requestedOauthClientScopes({ granted: [] })).toBeNull();
  });
});
