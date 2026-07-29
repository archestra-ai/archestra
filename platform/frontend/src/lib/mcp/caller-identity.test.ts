import { describe, expect, it } from "vitest";
import { formatCallerIdentity } from "./mcp-tool-call.query";

describe("formatCallerIdentity", () => {
  it("names the user who made the call", () => {
    expect(
      formatCallerIdentity({ userName: "Grace Hopper", authMethod: "oauth" }),
    ).toEqual({ name: "Grace Hopper", scope: "personal" });
  });

  it("credits a call made with a gateway token to the scope it acts for", () => {
    // A token carries no user and is nobody's identity of its own — it holds
    // the authority of the organization or team that issued it.
    expect(
      formatCallerIdentity({ userName: null, authMethod: "org_token" }),
    ).toEqual({ name: null, scope: "org" });
    expect(
      formatCallerIdentity({ userName: null, authMethod: "team_token" }),
    ).toEqual({ name: null, scope: "team" });
  });

  it("has nothing to name when a personal method lost its user", () => {
    expect(
      formatCallerIdentity({ userName: null, authMethod: "oauth" }),
    ).toBeNull();
    expect(
      formatCallerIdentity({ userName: null, authMethod: null }),
    ).toBeNull();
  });
});
