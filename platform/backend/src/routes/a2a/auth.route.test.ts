// Route-level auth tests for the A2A endpoints (v1 `/v1/a2a` and v2 `/v2/a2a`)
// exercising the REAL `validateMCPGatewayToken` path — not a mock of it. The
// other A2A tests (v1.test.ts / v2.stream.test.ts) stub the validator, so
// real token validation was previously untested.
//
// A2A accepts the same inbound auth methods the MCP gateway and LLM proxy do:
// static Archestra tokens (personal / team / org), external-IdP JWTs (JWKS,
// when the agent is bound to an identity provider), and platform OAuth (client
// credentials + user-bound). IdP binding and OAuth-client scoping are
// configurable for A2A agents (agentType="agent"). Only the LLM run
// (executeA2AMessage) and the low-level JWKS network verify are mocked here.

import { randomBytes } from "node:crypto";
import {
  MCP_GATEWAY_OAUTH_SCOPE,
  MCP_OAUTH_CLIENT_REFERENCE_PREFIX,
} from "@archestra/shared";
import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import {
  A2AContextModel,
  A2ATaskModel,
  McpOauthClientModel,
  OAuthAccessTokenModel,
  TeamTokenModel,
  UserTokenModel,
} from "@/models";
import ServiceAccountModel from "@/models/service-account";
import type { JwksValidationResult } from "@/services/jwks-validator";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const { mockExecuteA2AMessage, mockValidateJwt } = vi.hoisted(() => ({
  mockExecuteA2AMessage: vi.fn(),
  mockValidateJwt: vi.fn(),
}));

// NOTE: `@/routes/mcp-gateway.utils` is intentionally NOT mocked — the real
// validator runs. Only the LLM run and the JWKS network verify are stubbed.
vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: (...args: unknown[]) => mockExecuteA2AMessage(...args),
}));

vi.mock("@/services/jwks-validator", () => ({
  jwksValidator: {
    validateJwt: (...args: unknown[]) => mockValidateJwt(...args),
  },
}));

vi.mock("@/observability/tracing", async () => {
  const actual = await vi.importActual<
    typeof import("@/observability/tracing")
  >("@/observability/tracing");
  return {
    ...actual,
    startActiveChatSpan: async <T>(params: {
      callback: () => Promise<T>;
    }): Promise<T> => params.callback(),
  };
});

// A JWT-shaped, non-Archestra-prefixed bearer forces the JWKS path.
const FAKE_JWT = "eyJhbGciOiJSUzI1NiJ9.fake.jwt";

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const v2Payload = (text = "hi") => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "SendMessage",
  params: {
    message: {
      messageId: crypto.randomUUID(),
      role: "ROLE_USER",
      parts: [{ text }],
    },
  },
});

const v1Payload = (text = "hi") => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "message/send",
  params: { message: { parts: [{ kind: "text", text }] } },
});

async function makeClientCredentialsToken(params: {
  organizationId: string;
  authorId: string;
  allowedGatewayIds: string[];
  serviceAccountId?: string;
}): Promise<string> {
  const { oauthClient } = await McpOauthClientModel.create({
    organizationId: params.organizationId,
    authorId: params.authorId,
    name: "service",
    allowedGatewayIds: params.allowedGatewayIds,
    serviceAccountId: params.serviceAccountId,
  });
  const raw = `mcp_at_${randomBytes(32).toString("base64url")}`;
  await OAuthAccessTokenModel.createClientCredentialsToken({
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(raw),
    clientId: oauthClient.clientId,
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: [MCP_GATEWAY_OAUTH_SCOPE],
    referenceId: `${MCP_OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
  });
  return raw;
}

describe("a2a route-level authentication", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    mockExecuteA2AMessage.mockReset();
    mockValidateJwt.mockReset();
    // A successful run: a uuid message id so v2's stateful persistence accepts it.
    mockExecuteA2AMessage.mockImplementation(async () => {
      const messageId = crypto.randomUUID();
      return {
        messageId,
        text: "ok",
        finishReason: "stop",
        responseUiMessage: {
          id: messageId,
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
        },
      };
    });

    app = createFastifyInstance();
    const { default: a2aRoutes } = await import("./v1");
    const { default: a2aV2Routes } = await import("./v2");
    await app.register(a2aRoutes);
    await app.register(a2aV2Routes);
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  // === v2: static tokens ===

  test("v2 SendMessage accepts a static organization token", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { value } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      headers: bearer(value),
      payload: v2Payload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().error).toBeUndefined();
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
  });

  test("v2 SendMessage accepts a static user token for a member of the agent's org", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { value } = await UserTokenModel.create(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      headers: bearer(value),
      payload: v2Payload(),
    });

    expect(res.json().error).toBeUndefined();
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
  });

  test("v2 SendMessage accepts a team token for an agent shared with that team", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id, { name: "Dev Team" });
    const agent = await makeInternalAgent({
      organizationId: org.id,
      access: { teams: [team.id] },
    });
    const { value } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Team Token",
      teamId: team.id,
    });

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      headers: bearer(value),
      payload: v2Payload(),
    });

    expect(res.json().error).toBeUndefined();
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
  });

  // === v2: external-IdP JWT (JWKS) — agent bound to an identity provider ===

  test("v2 SendMessage accepts an external-IdP JWT validated via JWKS", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "test-client",
        jwksEndpoint: "https://idp.example.com/.well-known/jwks.json",
      },
    });
    // An A2A agent bound to an identity provider (now configurable).
    const agent = await makeInternalAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });
    mockValidateJwt.mockResolvedValue({
      sub: user.email,
      email: user.email,
      name: "Caller",
      rawClaims: { sub: user.email },
    } as JwksValidationResult);

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      headers: bearer(FAKE_JWT),
      payload: v2Payload(),
    });

    expect(res.json().error).toBeUndefined();
    expect(mockValidateJwt).toHaveBeenCalledTimes(1);
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
  });

  // === v2: platform OAuth — client scoped to the A2A agent ===

  test("v2 SendMessage accepts a client-credentials OAuth token scoped to the agent", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    const raw = await makeClientCredentialsToken({
      organizationId: org.id,
      authorId: crypto.randomUUID(),
      allowedGatewayIds: [agent.id],
    });

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      headers: bearer(raw),
      payload: v2Payload(),
    });

    expect(res.json().error).toBeUndefined();
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
  });

  test("client-credentials applications can manage only their own tasks", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    const first = await makeClientCredentialsToken({
      organizationId: org.id,
      authorId: crypto.randomUUID(),
      allowedGatewayIds: [agent.id],
    });
    const second = await makeClientCredentialsToken({
      organizationId: org.id,
      authorId: crypto.randomUUID(),
      allowedGatewayIds: [agent.id],
    });
    const call = (token: string, method: string, params: unknown) =>
      app.inject({
        method: "POST",
        url: `/v2/a2a/${agent.id}`,
        headers: bearer(token),
        payload: { jsonrpc: "2.0", id: 1, method, params },
      });
    const started = await call(first, "SendMessage", v2Payload().params);
    expect(started.json().error, started.body).toBeUndefined();
    const contextId = started.json().result.message.contextId;
    expect(contextId).toBeTruthy();
    const task = await A2ATaskModel.create({
      contextId,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
    });
    const taskId = task.id;
    expect(taskId).toBeTruthy();
    const own = await call(first, "GetTask", { id: taskId });
    expect(own.json().error, own.body).toBeUndefined();
    const originalToken = await OAuthAccessTokenModel.getByTokenHash(
      OAuthAccessTokenModel.hashTokenForLookup(first),
    );
    expect(originalToken).toBeTruthy();
    if (!originalToken?.clientId || !originalToken.referenceId)
      throw new Error("Expected application token");
    const renewed = `mcp_at_${randomBytes(32).toString("base64url")}`;
    await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash: OAuthAccessTokenModel.hashTokenForLookup(renewed),
      clientId: originalToken.clientId,
      referenceId: originalToken.referenceId,
      scopes: [MCP_GATEWAY_OAUTH_SCOPE],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const renewedAccess = await call(renewed, "GetTask", { id: taskId });
    expect(renewedAccess.json().error, renewedAccess.body).toBeUndefined();
    for (const method of ["GetTask", "CancelTask", "SubscribeToTask"]) {
      const denied = await call(second, method, { id: taskId });
      expect(denied.json().error?.code, denied.body).toBe(-32001);
    }
    const listed = await call(second, "ListTasks", {});
    expect(listed.json().result.tasks).toEqual([]);
    const ownList = await call(first, "ListTasks", {});
    expect(ownList.json().result.tasks).toEqual([
      expect.objectContaining({ id: taskId }),
    ]);
    // Keep cancellation real while the executor boundary stays synthetic.
    const canceled = await call(first, "CancelTask", { id: taskId });
    expect(canceled.json().result.status.state, canceled.body).toBe(
      "TASK_STATE_CANCELED",
    );
    const client = await McpOauthClientModel.findByClientId(
      originalToken.clientId,
    );
    if (!client) throw new Error("Expected application client");
    await McpOauthClientModel.delete({
      id: client.id,
      organizationId: org.id,
    });
    const revoked = await call(renewed, "GetTask", { id: taskId });
    expect(revoked.json().error, revoked.body).toBeTruthy();
  });

  test("OAuth and API credentials share account-owned tasks without granting other accounts access", async ({
    makeOrganization,
    makeInternalAgent,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    const account = await makeServiceAccount(org.id);
    const other = await makeServiceAccount(org.id);
    const tokenFor = (serviceAccountId: string) =>
      makeClientCredentialsToken({
        organizationId: org.id,
        authorId: crypto.randomUUID(),
        allowedGatewayIds: [agent.id],
        serviceAccountId,
      });
    const oauth = await tokenFor(account.id);
    const anotherClient = await tokenFor(account.id);
    const foreign = await tokenFor(other.id);
    const api = await ServiceAccountModel.createToken({
      organizationId: org.id,
      serviceAccountId: account.id,
      name: "worker API",
    });
    const call = (token: string, method: string, params: unknown) =>
      app.inject({
        method: "POST",
        url: `/v2/a2a/${agent.id}`,
        headers: bearer(token),
        payload: { jsonrpc: "2.0", id: 1, method, params },
      });
    const started = await call(oauth, "SendMessage", v2Payload().params);
    expect(started.json().error, started.body).toBeUndefined();
    const contextId = started.json().result.message.contextId;
    expect(await A2AContextModel.findById(contextId)).toMatchObject({
      actorKind: "serviceAccount",
      actorId: account.id,
    });
    const task = await A2ATaskModel.create({
      contextId,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
    });
    for (const credential of [oauth, anotherClient, api.token]) {
      const own = await call(credential, "GetTask", { id: task.id });
      expect(own.json().error, own.body).toBeUndefined();
    }
    for (const method of ["GetTask", "SubscribeToTask", "CancelTask"]) {
      const denied = await call(foreign, method, { id: task.id });
      expect(denied.json().error?.code, denied.body).toBe(-32001);
    }
    expect((await call(foreign, "ListTasks", {})).json().result.tasks).toEqual(
      [],
    );
    const canceled = await call(api.token, "CancelTask", { id: task.id });
    expect(canceled.json().result.status.state, canceled.body).toBe(
      "TASK_STATE_CANCELED",
    );
    await ServiceAccountModel.deleteToken({
      serviceAccountId: account.id,
      organizationId: org.id,
      tokenId: api.id,
    });
    expect(
      (await call(api.token, "GetTask", { id: task.id })).json().error,
    ).toBeTruthy();
    expect(
      (await call(oauth, "GetTask", { id: task.id })).json().error,
    ).toBeUndefined();
    await ServiceAccountModel.update(account.id, org.id, { disabled: true });
    expect(
      (await call(oauth, "GetTask", { id: task.id })).json().error,
    ).toBeTruthy();
  });

  test("v2 SendMessage accepts a user-bound OAuth access token", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { oauthClient } = await McpOauthClientModel.create({
      organizationId: org.id,
      authorId: user.id,
      name: "Agentic App",
      grantType: "authorization_code",
      redirectUris: ["https://app.example.com/oauth/callback"],
    });
    const raw = randomBytes(32).toString("base64url");
    await OAuthAccessTokenModel.create({
      tokenHash: OAuthAccessTokenModel.hashTokenForLookup(raw),
      clientId: oauthClient.clientId,
      userId: user.id,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [MCP_GATEWAY_OAUTH_SCOPE],
      referenceId: null,
    });

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      headers: bearer(raw),
      payload: v2Payload(),
    });

    expect(res.json().error).toBeUndefined();
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
  });

  // === v2: rejection cases never reach execution ===

  test("v2 rejects a missing token with a JSON-RPC error and no run", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      payload: v2Payload(),
    });

    expect(res.json().error.code).toBe(-32600);
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("v2 rejects a garbage bearer token with no run", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      headers: bearer("not-a-real-token"),
      payload: v2Payload(),
    });

    expect(res.json().error).toBeDefined();
    expect(res.json().result).toBeUndefined();
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("v2 rejects an OAuth token whose client is not scoped to this agent", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    const otherAgent = await makeInternalAgent({ organizationId: org.id });
    const raw = await makeClientCredentialsToken({
      organizationId: org.id,
      authorId: crypto.randomUUID(),
      allowedGatewayIds: [otherAgent.id],
    });

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      headers: bearer(raw),
      payload: v2Payload(),
    });

    expect(res.json().error).toBeDefined();
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  // === v1: the same validator authenticates the legacy endpoint ===

  test("v1 accepts a static organization token", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { value } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/a2a/${agent.id}`,
      headers: bearer(value),
      payload: v1Payload(),
    });

    expect(res.json().result).toBeDefined();
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
  });

  test("v1 accepts an external-IdP JWT validated via JWKS", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "test-client",
        jwksEndpoint: "https://idp.example.com/.well-known/jwks.json",
      },
    });
    const agent = await makeInternalAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });
    mockValidateJwt.mockResolvedValue({
      sub: user.email,
      email: user.email,
      name: "Caller",
      rawClaims: { sub: user.email },
    } as JwksValidationResult);

    const res = await app.inject({
      method: "POST",
      url: `/v1/a2a/${agent.id}`,
      headers: bearer(FAKE_JWT),
      payload: v1Payload(),
    });

    expect(res.json().result).toBeDefined();
    expect(mockValidateJwt).toHaveBeenCalledTimes(1);
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
  });

  test("v1 rejects a garbage bearer token with no run", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });

    const res = await app.inject({
      method: "POST",
      url: `/v1/a2a/${agent.id}`,
      headers: bearer("not-a-real-token"),
      payload: v1Payload(),
    });

    expect(res.json().error).toBeDefined();
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });
});
