import { ADMIN_ROLE_NAME, ARCHESTRA_TOKEN_PREFIX } from "@archestra/shared";
import ConversationModel from "@/models/conversation";
import ServiceAccountModel from "@/models/service-account";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import type { User } from "@/types";

describe("service account routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    user = await makeUser();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      request.user = user;
      request.organizationId = organizationId;
      request.authMethod = "session";
    });

    const { default: serviceAccountRoutes } = await import("./service-account");
    await app.register(serviceAccountRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates, lists, updates, creates a token, and deletes a service account", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/service-accounts",
      payload: {
        name: "Build Automation",
        role: ADMIN_ROLE_NAME,
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json();
    expect(created).toMatchObject({
      name: "Build Automation",
      role: ADMIN_ROLE_NAME,
      disabled: false,
      tokenCount: 0,
    });

    const tokenResponse = await app.inject({
      method: "POST",
      url: `/api/service-accounts/${created.id}/tokens`,
      payload: {
        name: "CI token",
        expiresIn: 3600,
      },
    });

    expect(tokenResponse.statusCode).toBe(200);
    const createdToken = tokenResponse.json();
    expect(createdToken).toMatchObject({
      name: "CI token",
      disabled: false,
      tokenStart: expect.any(String),
      token: expect.stringMatching(new RegExp(`^${ARCHESTRA_TOKEN_PREFIX}`)),
    });

    const updateTokenResponse = await app.inject({
      method: "PATCH",
      url: `/api/service-accounts/${created.id}/tokens/${createdToken.id}`,
      payload: {
        name: "CI token disabled",
        disabled: true,
        expiresAt: null,
      },
    });

    expect(updateTokenResponse.statusCode).toBe(200);
    expect(updateTokenResponse.json()).toMatchObject({
      id: createdToken.id,
      name: "CI token disabled",
      disabled: true,
      expiresAt: null,
    });

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/service-accounts",
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject([
      {
        id: created.id,
        name: "Build Automation",
        tokenCount: 1,
      },
    ]);

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/service-accounts/${created.id}`,
      payload: {
        name: "Build Automation Updated",
        disabled: true,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: created.id,
      name: "Build Automation Updated",
      disabled: true,
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/service-accounts/${created.id}`,
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });
  });

  test("rejects service account creation with an unknown role", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/service-accounts",
      payload: {
        name: "Unknown Role Account",
        role: "missing-role",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: "Role not found",
        type: "api_validation_error",
      },
    });
  });

  test("rejects token creation after the service account token limit", async () => {
    const serviceAccount = await ServiceAccountModel.create({
      organizationId,
      name: "Token limit automation",
      role: ADMIN_ROLE_NAME,
    });

    for (
      let index = 0;
      index < ServiceAccountModel.MAX_TOKENS_PER_SERVICE_ACCOUNT;
      index += 1
    ) {
      await ServiceAccountModel.createToken({
        serviceAccountId: serviceAccount.id,
        organizationId,
        name: `Token ${index + 1}`,
      });
    }

    const response = await app.inject({
      method: "POST",
      url: `/api/service-accounts/${serviceAccount.id}/tokens`,
      payload: {
        name: "One token too many",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: "Service account token limit exceeded",
        type: "api_validation_error",
      },
    });
  });
});

describe("service account API authentication", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    app = createFastifyInstance();
    const { fastifyAuthPlugin } = await import("@/auth");
    const { default: serviceAccountRoutes } = await import("./service-account");
    await app.register(fastifyAuthPlugin);
    await app.register(serviceAccountRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("authorizes protected routes from the service account role", async ({
    makeCustomRole,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const role = await makeCustomRole(organization.id, {
      permission: { serviceAccount: ["read"] },
    });
    const serviceAccount = await ServiceAccountModel.create({
      organizationId: organization.id,
      name: "Read-only automation",
      role: role.role,
    });
    const serviceToken = await ServiceAccountModel.createToken({
      serviceAccountId: serviceAccount.id,
      organizationId: organization.id,
      name: "Route token",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/service-accounts",
      headers: {
        authorization: serviceToken.token,
      },
    });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    expect(response.json()).toMatchObject([
      {
        id: serviceAccount.id,
        name: "Read-only automation",
      },
    ]);
  });

  test("reuses service account token verification during request authentication", async ({
    makeCustomRole,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const role = await makeCustomRole(organization.id, {
      permission: { serviceAccount: ["read"] },
    });
    const serviceAccount = await ServiceAccountModel.create({
      organizationId: organization.id,
      name: "Cached token automation",
      role: role.role,
    });
    const serviceToken = await ServiceAccountModel.createToken({
      serviceAccountId: serviceAccount.id,
      organizationId: organization.id,
      name: "Route token",
    });
    const verifyTokenSpy = vi.spyOn(ServiceAccountModel, "verifyToken");

    const response = await app.inject({
      method: "GET",
      url: "/api/service-accounts",
      headers: {
        authorization: serviceToken.token,
      },
    });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    expect(verifyTokenSpy).toHaveBeenCalledOnce();
  });

  test("rejects protected routes when the service account role lacks permission", async ({
    makeCustomRole,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const role = await makeCustomRole(organization.id, {
      permission: { agent: ["read"] },
    });
    const serviceAccount = await ServiceAccountModel.create({
      organizationId: organization.id,
      name: "Limited automation",
      role: role.role,
    });
    const serviceToken = await ServiceAccountModel.createToken({
      serviceAccountId: serviceAccount.id,
      organizationId: organization.id,
      name: "Route token",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/service-accounts",
      headers: {
        authorization: serviceToken.token,
      },
    });

    expect(response.statusCode).toBe(403);
  });

  test("rejects protected routes when the service account token is disabled", async ({
    makeCustomRole,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const role = await makeCustomRole(organization.id, {
      permission: { serviceAccount: ["read"] },
    });
    const serviceAccount = await ServiceAccountModel.create({
      organizationId: organization.id,
      name: "Disabled token automation",
      role: role.role,
    });
    const serviceToken = await ServiceAccountModel.createToken({
      serviceAccountId: serviceAccount.id,
      organizationId: organization.id,
      name: "Disabled route token",
    });
    await ServiceAccountModel.updateToken({
      serviceAccountId: serviceAccount.id,
      tokenId: serviceToken.id,
      organizationId: organization.id,
      data: { disabled: true },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/service-accounts",
      headers: {
        authorization: serviceToken.token,
      },
    });

    expect(response.statusCode).toBe(401);
  });

  test("rejects protected routes when the service account is disabled", async ({
    makeCustomRole,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const role = await makeCustomRole(organization.id, {
      permission: { serviceAccount: ["read"] },
    });
    const serviceAccount = await ServiceAccountModel.create({
      organizationId: organization.id,
      name: "Disabled automation",
      role: role.role,
    });
    const serviceToken = await ServiceAccountModel.createToken({
      serviceAccountId: serviceAccount.id,
      organizationId: organization.id,
      name: "Route token",
    });
    await ServiceAccountModel.update(serviceAccount.id, organization.id, {
      disabled: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/service-accounts",
      headers: {
        authorization: serviceToken.token,
      },
    });

    expect(response.statusCode).toBe(401);
  });

  test("creates a conversation using service account user context", async ({
    makeAgent,
    makeCustomRole,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: owner.id,
      scope: "personal",
    });
    const role = await makeCustomRole(organization.id, {
      permission: {
        agent: ["admin"],
        chat: ["create"],
      },
    });
    const serviceAccount = await ServiceAccountModel.create({
      organizationId: organization.id,
      name: "Chat automation",
      role: role.role,
    });
    const serviceToken = await ServiceAccountModel.createToken({
      serviceAccountId: serviceAccount.id,
      organizationId: organization.id,
      name: "Chat route token",
    });

    const { default: chatRoutes } = await import("./chat/routes");
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: {
        authorization: serviceToken.token,
      },
      payload: {
        agentId: agent.id,
        title: "Automation conversation",
      },
    });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    expect(response.json()).toMatchObject({
      agentId: agent.id,
      title: "Automation conversation",
      userId: `service-account:${serviceAccount.id}`,
    });

    const stored = await ConversationModel.findById({
      id: response.json().id,
      userId: `service-account:${serviceAccount.id}`,
      organizationId: organization.id,
    });
    expect(stored?.userId).toBe(`service-account:${serviceAccount.id}`);
  });
});
