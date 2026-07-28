import { describe, expect, it } from "vitest";
import { formatCallerIdentity } from "./mcp-tool-call.query";

describe("formatCallerIdentity", () => {
  it("names the user who made the call", () => {
    expect(
      formatCallerIdentity({ userName: "Grace Hopper", authMethod: "oauth" }),
    ).toBe("Grace Hopper");
  });

  it("names the token when a call carries no user", () => {
    // Gateway tokens act for an organization or a team rather than a person,
    // and an auditor still needs a name for whoever made the call.
    expect(
      formatCallerIdentity({ userName: null, authMethod: "org_token" }),
    ).toBe("Org Token");
    expect(
      formatCallerIdentity({ userName: null, authMethod: "team_token" }),
    ).toBe("Team Token");
  });

  it("has nothing to name when neither is recorded", () => {
    expect(
      formatCallerIdentity({ userName: null, authMethod: null }),
    ).toBeNull();
  });
});
