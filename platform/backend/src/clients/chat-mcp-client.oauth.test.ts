import {
  OAUTH_CLIENT_REFERENCE_PREFIX,
  OAUTH_TOKEN_ID_PREFIX,
} from "@archestra/shared";
import { executeA2AMessage } from "@/agents/a2a-executor";
import { handleDelegation } from "@/archestra-mcp-server/delegation";
import {
  AgentToolModel,
  ManagedOauthClientModel,
  OAuthAccessTokenModel,
  ToolModel,
} from "@/models";
import { authorizeA2AOAuthExecution } from "@/routes/mcp-gateway/utils";
import { expect, test } from "@/test";
import { getChatMcpTools } from "./chat-mcp-client";

for (const change of [
  "expiry",
  "revocation",
  "allowlist",
  "scope",
  "deletion",
  "binding",
  "organization",
] as const) {
  test(`OAuth tool closures and discovery honor live ${change} changes`, async ({
    makeOrganization,
    makeInternalAgent,
    makeUser,
    makeMember,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { oauthClient } = await ManagedOauthClientModel.create({
      organizationId: org.id,
      authorId: user.id,
      name: "Synthetic app",
      grantType: "client_credentials",
      scopes: ["a2a"],
      allowedGatewayIds: [agent.id],
    });
    const bearer = crypto.randomUUID();
    const tokenHash = OAuthAccessTokenModel.hashTokenForLookup(bearer);
    const token = await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash,
      clientId: oauthClient.clientId,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: ["a2a"],
      referenceId: `${OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
    });
    const execution = {
      tokenId: `${OAUTH_TOKEN_ID_PREFIX}${token.id}`,
      clientId: oauthClient.clientId,
    };
    const params = {
      agentId: agent.id,
      agentName: agent.name,
      organizationId: org.id,
      userId: "system",
      isolationKey: "same-scope",
      oauthExecution: execution,
    };
    const tools = await getChatMcpTools(params);
    const held = Object.values(tools).find((tool) => tool.execute);
    expect(held).toBeDefined();
    const otherToken = await OAuthAccessTokenModel.createClientCredentialsToken(
      {
        tokenHash: OAuthAccessTokenModel.hashTokenForLookup(
          crypto.randomUUID(),
        ),
        clientId: oauthClient.clientId,
        expiresAt: new Date(Date.now() + 60_000),
        scopes: ["a2a"],
        referenceId: `${OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
      },
    );
    const otherParams = {
      ...params,
      oauthExecution: {
        ...execution,
        tokenId: `${OAUTH_TOKEN_ID_PREFIX}${otherToken.id}`,
      },
    };
    const otherTools = await getChatMcpTools(otherParams);
    expect(otherTools).not.toBe(tools);
    const update = {
      id: oauthClient.id,
      organizationId: org.id,
      name: "Synthetic app",
    };
    switch (change) {
      case "expiry":
        await OAuthAccessTokenModel.updateExpiresAtByTokenHash({
          tokenHash,
          expiresAt: new Date(0),
        });
        break;
      case "revocation":
        await OAuthAccessTokenModel.deleteByTokenHash(tokenHash);
        break;
      case "allowlist":
        await ManagedOauthClientModel.update({
          ...update,
          allowedGatewayIds: [],
        });
        break;
      case "scope":
        await ManagedOauthClientModel.update({ ...update, scopes: ["mcp"] });
        break;
      case "deletion":
        await ManagedOauthClientModel.delete(update);
        break;
      case "binding": {
        const account = await makeServiceAccount(org.id);
        await ManagedOauthClientModel.update({
          ...update,
          serviceAccountId: account.id,
        });
        break;
      }
      case "organization":
        params.organizationId = (await makeOrganization()).id;
        break;
    }
    if (change !== "organization") {
      await expect(
        held?.execute?.({}, { toolCallId: "held", messages: [] }),
      ).rejects.toThrow("no longer authorized");
    }
    await expect(getChatMcpTools(params)).rejects.toThrow(
      "no longer authorized",
    );
    if (change === "revocation" || change === "expiry") {
      const unaffected = await getChatMcpTools(otherParams);
      expect(Object.keys(unaffected)).toEqual(Object.keys(otherTools));
    }
    await expect(
      authorizeA2AOAuthExecution({
        agentId: agent.id,
        organizationId: params.organizationId,
        execution,
      }),
    ).rejects.toThrow("no longer authorized");
  });
}

test("OAuth cannot reach an outside-allowlist agent through delegation or a nested executor", async ({
  makeOrganization,
  makeInternalAgent,
  makeUser,
  makeMember,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const agent = await makeInternalAgent({ organizationId: org.id });
  const outside = await makeInternalAgent({ organizationId: org.id });
  await AgentToolModel.assignDelegation({
    agentId: agent.id,
    targetAgentId: outside.id,
  });
  const { oauthClient } = await ManagedOauthClientModel.create({
    organizationId: org.id,
    authorId: user.id,
    name: "Synthetic app",
    grantType: "client_credentials",
    scopes: ["a2a"],
    allowedGatewayIds: [agent.id],
  });
  const token = await OAuthAccessTokenModel.createClientCredentialsToken({
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(crypto.randomUUID()),
    clientId: oauthClient.clientId,
    expiresAt: new Date(Date.now() + 60_000),
    scopes: ["a2a"],
    referenceId: `${OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
  });
  const execution = {
    tokenId: `${OAUTH_TOKEN_ID_PREFIX}${token.id}`,
    clientId: oauthClient.clientId,
  };
  const params = {
    agentId: agent.id,
    agentName: agent.name,
    organizationId: org.id,
    userId: "system",
    oauthExecution: execution,
  };
  const tools = await getChatMcpTools(params);
  const descriptor = await ToolModel.findOrCreateDelegationTool(outside.id);
  expect(tools[descriptor.name]).toBeUndefined();
  const denied = await handleDelegation(
    descriptor.name,
    { message: "Delegate" },
    {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: org.id,
      tokenAuth: {
        tokenId: execution.tokenId,
        teamId: null,
        isOrganizationToken: false,
        oauthClientId: oauthClient.clientId,
        oauthExecution: execution,
      },
    },
  );
  expect(denied.isError).toBe(true);
  await expect(
    executeA2AMessage({ ...params, agentId: outside.id, message: "Delegate" }),
  ).rejects.toThrow("no longer authorized");
});
