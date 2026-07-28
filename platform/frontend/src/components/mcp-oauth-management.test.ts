import { describe, expect, it } from "vitest";
import { isMcpOauthClientApplicable } from "./mcp-oauth-management";

describe("MCP OAuth resource filtering", () => {
  it("includes user-delegated clients and assigned application clients", () => {
    expect(
      isMcpOauthClientApplicable(
        { grantType: "authorization_code", allowedGatewayIds: [] },
        "agent-1",
      ),
    ).toBe(true);
    expect(
      isMcpOauthClientApplicable(
        {
          grantType: "client_credentials",
          allowedGatewayIds: ["agent-1"],
        },
        "agent-1",
      ),
    ).toBe(true);
  });

  it("excludes application clients assigned only to another resource", () => {
    expect(
      isMcpOauthClientApplicable(
        {
          grantType: "client_credentials",
          allowedGatewayIds: ["gateway-2"],
        },
        "agent-1",
      ),
    ).toBe(false);
  });
});
