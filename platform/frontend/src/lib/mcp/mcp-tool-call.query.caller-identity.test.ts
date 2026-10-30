// @vitest-environment node
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

  it("names a service account call by the account, or as a service account once it is gone", () => {
    expect(
      formatCallerIdentity({
        userName: "CI pipeline",
        authMethod: "service_account_token",
      }),
    ).toEqual({ name: "CI pipeline", scope: "personal" });
    expect(
      formatCallerIdentity({
        userName: null,
        authMethod: "service_account_token",
      }),
    ).toEqual({ name: "Service account", scope: "org" });
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
