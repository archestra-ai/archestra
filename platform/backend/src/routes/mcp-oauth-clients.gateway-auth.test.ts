import { randomBytes } from "node:crypto";
import {
  MCP_GATEWAY_OAUTH_SCOPE,
  MCP_OAUTH_CLIENT_REFERENCE_PREFIX,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { McpOauthClientModel, OAuthAccessTokenModel } from "@/models";
import { describe, expect, test } from "@/test";
import { validateMCPGatewayToken } from "./mcp-gateway.utils";

/**
 * End-to-end authorization tests for MCP OAuth client (application) tokens
 * at the gateway boundary. These exercise the security gate added to
 * validateOAuthTokenByHash: a client_credentials token is accepted only for the
 * gateways its client is explicitly scoped to, in the same organization.
 */
describe("MCP OAuth client gateway authorization", () => {
  async function mintToken(params: {
    clientId: string;
    referenceClientUuid: string;
    scopes?: string[];
    expiresAt?: Date;
  }) {
    const accessToken = `mcp_at_${randomBytes(32).toString("base64url")}`;
    await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash: OAuthAccessTokenModel.hashTokenForLookup(accessToken),
      clientId: params.clientId,
      expiresAt: params.expiresAt ?? new Date(Date.now() + 3_600_000),
      scopes: params.scopes ?? [MCP_GATEWAY_OAUTH_SCOPE],
      referenceId: `${MCP_OAUTH_CLIENT_REFERENCE_PREFIX}${params.referenceClientUuid}`,
    });
    return accessToken;
  }

  test("authorizes a gateway the client is scoped to", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const { oauthClient } = await McpOauthClientModel.create({
      organizationId: org.id,
      name: "service",
      allowedGatewayIds: [gateway.id],
    });
    const token = await mintToken({
      clientId: oauthClient.clientId,
      referenceClientUuid: oauthClient.id,
    });

    const result = await validateMCPGatewayToken(gateway.id, token);

    expect(result).not.toBeNull();
    expect(result?.organizationId).toBe(org.id);
    expect(result?.teamId).toBeNull();
    expect(result?.isOrganizationToken).toBe(false);
    // Application (machine-to-machine) tokens have no acting user.
    expect(result?.isUserToken).toBeUndefined();
    expect(result?.userId).toBeUndefined();
  });

  test("rejects a gateway the client is not scoped to", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const allowedGateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const otherGateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const { oauthClient } = await McpOauthClientModel.create({
      organizationId: org.id,
      name: "service",
      allowedGatewayIds: [allowedGateway.id],
    });
    const token = await mintToken({
      clientId: oauthClient.clientId,
      referenceClientUuid: oauthClient.id,
    });

    expect(await validateMCPGatewayToken(otherGateway.id, token)).toBeNull();
  });

  test("rejects a gateway in a different organization", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const clientOrg = await makeOrganization();
    const otherOrg = await makeOrganization();
    const otherOrgGateway = await makeAgent({
      organizationId: otherOrg.id,
      agentType: "mcp_gateway",
    });
    // Scope the client (in clientOrg) to a gateway that lives in another org.
    // The allowedGatewayIds check passes, but the org guard must still reject.
    const { oauthClient } = await McpOauthClientModel.create({
      organizationId: clientOrg.id,
      name: "service",
      allowedGatewayIds: [otherOrgGateway.id],
    });
    const token = await mintToken({
      clientId: oauthClient.clientId,
      referenceClientUuid: oauthClient.id,
    });

    expect(await validateMCPGatewayToken(otherOrgGateway.id, token)).toBeNull();
  });

  test("rejects an expired token", async ({ makeOrganization, makeAgent }) => {
    const org = await makeOrganization();
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const { oauthClient } = await McpOauthClientModel.create({
      organizationId: org.id,
      name: "service",
      allowedGatewayIds: [gateway.id],
    });
    const token = await mintToken({
      clientId: oauthClient.clientId,
      referenceClientUuid: oauthClient.id,
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect(await validateMCPGatewayToken(gateway.id, token)).toBeNull();
  });

  test("rejects a token missing the mcp scope", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const { oauthClient } = await McpOauthClientModel.create({
      organizationId: org.id,
      name: "service",
      allowedGatewayIds: [gateway.id],
    });
    const token = await mintToken({
      clientId: oauthClient.clientId,
      referenceClientUuid: oauthClient.id,
      scopes: ["llm:proxy"],
    });

    expect(await validateMCPGatewayToken(gateway.id, token)).toBeNull();
  });

  test("rejects a token whose referenceId points to a different client", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const { oauthClient } = await McpOauthClientModel.create({
      organizationId: org.id,
      name: "service",
      allowedGatewayIds: [gateway.id],
    });
    const token = await mintToken({
      clientId: oauthClient.clientId,
      referenceClientUuid: crypto.randomUUID(),
    });

    expect(await validateMCPGatewayToken(gateway.id, token)).toBeNull();
  });

  test("rejects a token after its client is deleted", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const { oauthClient } = await McpOauthClientModel.create({
      organizationId: org.id,
      name: "service",
      allowedGatewayIds: [gateway.id],
    });
    const token = await mintToken({
      clientId: oauthClient.clientId,
      referenceClientUuid: oauthClient.id,
    });

    await McpOauthClientModel.delete({
      id: oauthClient.id,
      organizationId: org.id,
    });

    expect(await validateMCPGatewayToken(gateway.id, token)).toBeNull();
  });

  test("rejects a token after its client is disabled", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const { oauthClient } = await McpOauthClientModel.create({
      organizationId: org.id,
      name: "service",
      allowedGatewayIds: [gateway.id],
    });
    const token = await mintToken({
      clientId: oauthClient.clientId,
      referenceClientUuid: oauthClient.id,
    });

    await db
      .update(schema.oauthClientsTable)
      .set({ disabled: true })
      .where(eq(schema.oauthClientsTable.id, oauthClient.id));

    expect(await validateMCPGatewayToken(gateway.id, token)).toBeNull();
  });
});
