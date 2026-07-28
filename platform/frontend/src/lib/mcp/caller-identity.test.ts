import { describe, expect, it } from "vitest";
import { formatCallerIdentity } from "./mcp-tool-call.query";

describe("formatCallerIdentity", () => {
  it("names the user who made the call", () => {
    expect(
      formatCallerIdentity({ userName: "Grace Hopper", authMethod: "oauth" }),
    ).toEqual({ label: "Grace Hopper", scope: "personal" });
  });

  it("names the token when a call carries no user", () => {
    // Gateway tokens act for an organization or a team rather than a person,
    // and an auditor still needs a name for whoever made the call. The scope
    // keeps them from being drawn as somebody's personal identity.
    expect(
      formatCallerIdentity({ userName: null, authMethod: "org_token" }),
    ).toEqual({ label: "Org Token", scope: "org" });
    expect(
      formatCallerIdentity({ userName: null, authMethod: "team_token" }),
    ).toEqual({ label: "Team Token", scope: "team" });
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
