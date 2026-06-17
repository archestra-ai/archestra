import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import McpOauthClientModel from "./mcp-oauth-client";

describe("McpOauthClientModel", () => {
  test("creates a client with a one-time secret and prefixed identifiers", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const gatewayId = crypto.randomUUID();

    const result = await McpOauthClientModel.create({
      organizationId: organization.id,
      name: "Backend Service",
      allowedGatewayIds: [gatewayId],
    });

    expect(result.clientSecret).toMatch(/^mcp_secret_/);
    expect(result.oauthClient.clientId).toMatch(/^mcp_oauth_/);
    expect(result.oauthClient.name).toBe("Backend Service");
    expect(result.oauthClient.organizationId).toBe(organization.id);
    expect(result.oauthClient.allowedGatewayIds).toEqual([gatewayId]);
    expect(result.oauthClient.disabled).toBe(false);
  });

  test("findClientForCredentials verifies the hashed secret", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const { oauthClient, clientSecret } = await McpOauthClientModel.create({
      organizationId: organization.id,
      name: "service",
      allowedGatewayIds: [crypto.randomUUID()],
    });

    const matched = await McpOauthClientModel.findClientForCredentials({
      clientId: oauthClient.clientId,
      clientSecret,
    });
    expect(matched?.id).toBe(oauthClient.id);

    const wrongSecret = await McpOauthClientModel.findClientForCredentials({
      clientId: oauthClient.clientId,
      clientSecret: "mcp_secret_wrong",
    });
    expect(wrongSecret).toBeNull();
  });

  test("rotateSecret replaces the stored secret", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const { oauthClient, clientSecret } = await McpOauthClientModel.create({
      organizationId: organization.id,
      name: "service",
      allowedGatewayIds: [crypto.randomUUID()],
    });

    const rotated = await McpOauthClientModel.rotateSecret({
      id: oauthClient.id,
      organizationId: organization.id,
    });
    expect(rotated?.clientSecret).toMatch(/^mcp_secret_/);
    expect(rotated?.clientSecret).not.toBe(clientSecret);

    // The old secret no longer authenticates; the new one does.
    expect(
      await McpOauthClientModel.findClientForCredentials({
        clientId: oauthClient.clientId,
        clientSecret,
      }),
    ).toBeNull();
    expect(
      await McpOauthClientModel.findClientForCredentials({
        clientId: oauthClient.clientId,
        clientSecret: rotated?.clientSecret ?? "",
      }),
    ).not.toBeNull();
  });

  test("disabled clients are not returned for credential or client-id lookups", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const { oauthClient, clientSecret } = await McpOauthClientModel.create({
      organizationId: organization.id,
      name: "service",
      allowedGatewayIds: [crypto.randomUUID()],
    });

    await db
      .update(schema.oauthClientsTable)
      .set({ disabled: true })
      .where(eq(schema.oauthClientsTable.id, oauthClient.id));

    expect(
      await McpOauthClientModel.findByClientId(oauthClient.clientId),
    ).toBeNull();
    expect(
      await McpOauthClientModel.findClientForCredentials({
        clientId: oauthClient.clientId,
        clientSecret,
      }),
    ).toBeNull();
  });

  test("organization scoping isolates clients across orgs", async ({
    makeOrganization,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const { oauthClient } = await McpOauthClientModel.create({
      organizationId: orgA.id,
      name: "org-a-service",
      allowedGatewayIds: [crypto.randomUUID()],
    });

    expect(
      await McpOauthClientModel.findById({
        id: oauthClient.id,
        organizationId: orgB.id,
      }),
    ).toBeNull();
    expect(
      await McpOauthClientModel.findAllByOrganization({
        organizationId: orgB.id,
      }),
    ).toHaveLength(0);
  });
});
