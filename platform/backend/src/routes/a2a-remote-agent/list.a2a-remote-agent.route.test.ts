import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { describe, expect, test, useRouteTestApp } from "@/test";
import a2aRemoteAgentRoutes from "./a2a-remote-agent.routes";
import { makeAgentCard } from "./a2a-remote-agent.test-helpers";

describe("GET /api/a2a/remote-agents", () => {
  const ctx = useRouteTestApp(a2aRemoteAgentRoutes);

  test("lists only the organization's agents and keeps connection secrets redacted", async ({
    makeOrganization,
  }) => {
    const own = await ctx.app.inject({
      method: "POST",
      url: "/api/a2a/remote-agents",
      payload: {
        name: "Visible remote",
        source: { type: "inline_card", agentCard: makeAgentCard("api-key") },
        auth: {
          type: "api_key",
          headerName: "X-API-Key",
          credential: "visible-org-secret",
        },
      },
    });
    expect(own.statusCode).toBe(200);

    const otherOrganization = await makeOrganization();
    await createA2aRemoteAgent({
      organizationId: otherOrganization.id,
      input: {
        name: "Foreign remote",
        source: { type: "inline_card", agentCard: makeAgentCard("none") },
        auth: { type: "none" },
        connectionName: "Default",
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/a2a/remote-agents",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      name: "Visible remote",
      connection: {
        authType: "api_key",
        authConfig: { headerName: "X-API-Key" },
        hasCredential: true,
      },
    });
    expect(JSON.stringify(body)).not.toContain("visible-org-secret");
    expect(JSON.stringify(body)).not.toContain("Foreign remote");
    expect(body[0].connection.secretId).toBeUndefined();
  });
});
