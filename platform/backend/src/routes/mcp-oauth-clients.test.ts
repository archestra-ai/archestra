import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("mcpOauthClientsRoutes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: mcpOauthClientsRoutes } = await import(
      "./mcp-oauth-clients"
    );
    await app.register(mcpOauthClientsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates, lists, updates, rotates, and deletes an MCP OAuth client", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      name: "Support Gateway",
      agentType: "mcp_gateway",
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: {
        name: "Backend Service",
        allowedGatewayIds: [gateway.id],
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json();
    expect(created.clientId).toMatch(/^mcp_oauth_/);
    expect(created.clientSecret).toMatch(/^mcp_secret_/);
    expect(created.allowedGatewayIds).toEqual([gateway.id]);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/mcp-oauth-clients",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toHaveLength(1);
    expect(listResponse.json()[0].name).toBe("Backend Service");
    // The hashed secret must never be returned on reads.
    expect(listResponse.json()[0].clientSecret).toBeUndefined();

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/mcp-oauth-clients/${created.id}`,
      payload: {
        name: "Updated Backend Service",
        allowedGatewayIds: [gateway.id],
      },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: created.id,
      name: "Updated Backend Service",
      allowedGatewayIds: [gateway.id],
    });

    const rotateResponse = await app.inject({
      method: "POST",
      url: `/api/mcp-oauth-clients/${created.id}/rotate-secret`,
    });
    expect(rotateResponse.statusCode).toBe(200);
    expect(rotateResponse.json().clientSecret).toMatch(/^mcp_secret_/);
    expect(rotateResponse.json().clientSecret).not.toBe(created.clientSecret);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/mcp-oauth-clients/${created.id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });
  });

  test("filters MCP OAuth clients by search", async ({ makeAgent }) => {
    const gateway = await makeAgent({
      organizationId,
      name: "Filter Gateway",
      agentType: "mcp_gateway",
    });

    await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: { name: "Searchable Service", allowedGatewayIds: [gateway.id] },
    });
    await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: { name: "Other Client", allowedGatewayIds: [gateway.id] },
    });

    const searchResponse = await app.inject({
      method: "GET",
      url: "/api/mcp-oauth-clients?search=searchable",
    });
    expect(searchResponse.statusCode).toBe(200);
    expect(
      searchResponse.json().map((client: { name: string }) => client.name),
    ).toEqual(["Searchable Service"]);
  });

  test("rejects a non-gateway agent as an allowed gateway", async ({
    makeAgent,
  }) => {
    const llmProxy = await makeAgent({
      organizationId,
      name: "Not A Gateway",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: {
        name: "Misconfigured Client",
        allowedGatewayIds: [llmProxy.id],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("MCP gateway not found");
  });

  test("rejects a gateway from another organization", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const otherGateway = await makeAgent({
      organizationId: otherOrg.id,
      name: "Other Org Gateway",
      agentType: "mcp_gateway",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: {
        name: "Cross Org Client",
        allowedGatewayIds: [otherGateway.id],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("MCP gateway not found");
  });
});
