// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { randomUUID } from "node:crypto";
import type { ResourcePermissionAction } from "@archestra/shared";
import { authPlugin } from "@/auth/fastify-plugin";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import SecretModel from "@/models/secret";
import ServiceAccountModel from "@/models/service-account";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { encodeGithubAppReference } from "@/services/github-app-copilot-token";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { ResourcePermissions } from "@/services/resource-permissions";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import llmProviderApiKeyRoutes from "../llm-provider-api-keys";
import { validateVirtualApiKey } from "../proxy/llm-proxy-auth";
import virtualApiKeyRoutes from "./virtual-api-key.routes";

describe("service-account owner-matched Copilot mappings", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let owner: User;
  let serviceAccountId: string;
  let authorization: string;
  let copilotKey: Awaited<ReturnType<typeof LlmProviderApiKeyModel.create>>;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      organizationId = (await makeOrganization()).id;
      owner = await makeUser();
      await makeMember(owner.id, organizationId);
      const secret = await makeSecret({
        secret: { apiKey: "gho_owner_token" },
      });
      copilotKey = await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "github-copilot",
        userId: owner.id,
      });
      const account = await ServiceAccountModel.create({
        organizationId,
        name: "Credential automation",
        role: "member",
        createdBy: null,
      });
      serviceAccountId = account.id;
      authorization = (
        await ServiceAccountModel.createToken({
          serviceAccountId,
          organizationId,
          name: "Mapping automation",
        })
      ).token;
      await setWildcardAuthority(["read", "use", "update"]);
      app = createFastifyInstance();
      await app.register(authPlugin);
      registerAuditLogHook(app);
      await app.register(virtualApiKeyRoutes);
      await app.register(llmProviderApiKeyRoutes);
    },
  );

  afterEach(async () => {
    await drainBackgroundWork();
    await app.close();
  });

  const mapping = (key = copilotKey) => [
    { provider: key.provider, providerApiKeyId: key.id },
  ];

  const create = (payload: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      headers: { authorization },
      payload: {
        name: "Owner credential mapping",
        ownerId: owner.id,
        providerApiKeys: mapping(),
        ...payload,
      },
    });

  const patch = (id: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: "PATCH",
      url: `/api/llm-virtual-keys/${id}`,
      headers: { authorization },
      payload: {
        name: "Updated owner credential mapping",
        providerApiKeys: mapping(),
        ...payload,
      },
    });

  async function setWildcardAuthority(actions: ResourcePermissionAction[]) {
    const key = {
      organizationId,
      resource: "llmVirtualKey" as const,
      scope: "*",
    };
    const current = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: current?.revision ?? 0,
      grants: actions.length
        ? [
            {
              subject: { type: "serviceAccount", id: serviceAccountId },
              actions,
            },
          ]
        : [],
    });
  }

  async function creationState() {
    return {
      keys: await VirtualApiKeyModel.findAllByOrganization({
        organizationId,
        userId: owner.id,
        pagination: { limit: 100, offset: 0 },
      }),
      secrets: await SecretModel.count(),
    };
  }

  async function keyState(id: string) {
    return {
      key: await VirtualApiKeyModel.findByIdForAudit(id, organizationId),
      policy: await ResourcePermissionPolicyModel.find({
        organizationId,
        resource: "llmVirtualKey",
        scope: id,
      }),
      secrets: await SecretModel.count(),
    };
  }

  test("creates, retains and replaces an owner's mapping without becoming the owner or gaining credential access", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const response = await create();
    expect(response.statusCode, response.body).toBe(200);
    const created = response.json();
    expect(created.authorId).toBe(owner.id);
    expect(response.body).not.toContain("gho_owner_token");
    expect(await VirtualApiKeyModel.isPersonal(created)).toBe(true);
    expect((await keyState(created.id)).policy?.grants).toEqual([
      {
        subject: { type: "user", id: owner.id },
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
    ]);
    expect((await patch(created.id)).statusCode).toBe(200);
    const secret = await makeSecret({ secret: { apiKey: "gho_replacement" } });
    const replacement = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "github-copilot",
      userId: owner.id,
    });
    const updated = await patch(created.id, {
      name: "Rotated mapping",
      providerApiKeys: mapping(replacement),
      ownerId: randomUUID(),
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      authorId: owner.id,
      name: "Rotated mapping",
    });
    expect(updated.json()).not.toHaveProperty("value");
    expect(updated.body).not.toContain("gho_replacement");
    const readback = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys/${created.id}`,
      headers: { authorization },
    });
    expect(readback.statusCode, readback.body).toBe(200);
    expect(readback.json()).toMatchObject({
      authorId: owner.id,
      providerApiKeys: [{ providerApiKeyId: replacement.id }],
    });
    expect(
      await LlmProviderApiKeyModel.canUseKey(
        copilotKey,
        serviceAccountUserId(serviceAccountId),
        [],
      ),
    ).toBe(false);
    const hiddenProvider = await app.inject({
      method: "GET",
      url: `/api/llm-provider-api-keys/${copilotKey.id}`,
      headers: { authorization },
    });
    expect(hiddenProvider.statusCode).toBe(404);
    const hiddenValue = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys/${created.id}/value`,
      headers: { authorization },
    });
    expect(hiddenValue.statusCode).toBe(403);
    expect(hiddenValue.body).not.toContain(created.value);
    await drainBackgroundWork();
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "virtualApiKey",
      resourceId: created.id,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toHaveLength(3);
    for (const event of audit.data) {
      expect(event).toMatchObject({
        actorId: null,
        actorType: "service_account",
        actorName: "Credential automation",
        actorEmail: `${serviceAccountId}@service-account.local`,
        outcome: "success",
        after: expect.objectContaining({ authorId: owner.id }),
      });
      expect(event.after).not.toEqual(event.before);
    }
    expect(JSON.stringify(audit)).not.toContain(created.value);
    expect(JSON.stringify(audit)).not.toContain("gho_");
  });

  test.for([
    ["omitted", 403],
    ["unknown", 404],
    ["nonmember", 404],
    ["other member", 403],
    ["foreign member", 404],
  ] as const)("rejects %s create owner without persisting a key or secret", async ([
    scenario,
    status,
  ], { makeUser, makeMember, makeOrganization }) => {
    let ownerId: string | undefined;
    if (scenario === "unknown") ownerId = randomUUID();
    else if (scenario !== "omitted") {
      ownerId = (await makeUser()).id;
      if (scenario === "other member")
        await makeMember(ownerId, organizationId);
      if (scenario === "foreign member")
        await makeMember(ownerId, (await makeOrganization()).id);
    }
    const before = await creationState();
    const response = await create({ ownerId });
    expect(response.statusCode, response.body).toBe(status);
    expect(await creationState()).toEqual(before);
  });

  test.for([
    "missing",
    "mismatched",
    "nonmember",
  ] as const)("rejects a %s persisted owner before PATCH writes", async (scenario, {
    makeUser,
    makeMember,
    makeVirtualApiKey,
    makeLlmProviderApiKey,
  }) => {
    const other = await makeUser();
    if (scenario === "mismatched") await makeMember(other.id, organizationId);
    const key = await makeVirtualApiKey(organizationId, {
      name: "Unchanged",
      authorId: scenario === "missing" ? null : other.id,
      access: "personal",
    });
    const providerKey =
      scenario === "nonmember"
        ? await makeLlmProviderApiKey(organizationId, copilotKey.secretId, {
            provider: "github-copilot",
            userId: other.id,
          })
        : copilotKey;
    const before = await keyState(key.id);
    const response = await patch(key.id, {
      ownerId: owner.id,
      providerApiKeys: mapping(providerKey),
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(await keyState(key.id)).toEqual(before);
  });

  test.for([
    "none",
    "read only",
    "object only",
  ] as const)("rejects %s authority even for a retained owner-matched mapping", async (authority, {
    makeVirtualApiKey,
  }) => {
    await setWildcardAuthority(authority === "read only" ? ["read"] : []);
    const key = await makeVirtualApiKey(organizationId, {
      authorId: owner.id,
      access: "personal",
      providerApiKeys: mapping(),
    });
    if (authority === "object only") {
      const current = await ResourcePermissionPolicyModel.find({
        organizationId,
        resource: "llmVirtualKey",
        scope: key.id,
      });
      await ResourcePermissionPolicyModel.replace({
        organizationId,
        resource: "llmVirtualKey",
        scope: key.id,
        revision: current?.revision ?? 0,
        grants: [
          ...(current?.grants ?? []),
          {
            subject: { type: "serviceAccount", id: serviceAccountId },
            actions: ["read", "use", "update"],
          },
        ],
      });
      expect(
        await ResourcePermissions.allows({
          organizationId,
          userId: serviceAccountUserId(serviceAccountId),
          resource: "llmVirtualKey",
          scope: key.id,
          action: "update",
        }),
      ).toBe(true);
    }
    const beforeCreate = await creationState();
    const deniedCreate = await create();
    expect(deniedCreate.statusCode, deniedCreate.body).toBe(403);
    expect(await creationState()).toEqual(beforeCreate);
    const beforePatch = await keyState(key.id);
    const deniedPatch = await patch(key.id);
    expect(deniedPatch.statusCode, deniedPatch.body).toBe(403);
    expect(await keyState(key.id)).toEqual(beforePatch);
  });

  test.for([
    "microsoft-365-copilot",
    "openai",
    "anthropic",
  ] as const)("does not delegate personal %s credentials alongside Copilot", async (provider, {
    makeSecret,
    makeLlmProviderApiKey,
    makeVirtualApiKey,
  }) => {
    const secret = await makeSecret({
      secret: {
        apiKey:
          provider === "openai"
            ? encodeOpenAiCodexCredential({
                refreshToken: "rt_owner",
                accountId: "account_owner",
              })
            : "personal-provider-token",
      },
    });
    const providerKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider,
      userId: owner.id,
    });
    const providerApiKeys = [...mapping(), ...mapping(providerKey)];
    const beforeCreate = await creationState();
    const deniedCreate = await create({ providerApiKeys });
    expect(deniedCreate.statusCode, deniedCreate.body).toBe(403);
    expect(await creationState()).toEqual(beforeCreate);
    const key = await makeVirtualApiKey(organizationId, {
      authorId: owner.id,
      access: "personal",
    });
    const beforePatch = await keyState(key.id);
    const deniedPatch = await patch(key.id, { providerApiKeys });
    expect(deniedPatch.statusCode, deniedPatch.body).toBe(403);
    expect(await keyState(key.id)).toEqual(beforePatch);
  });

  test.for([
    "organization",
    "provider",
  ] as const)("keeps %s consistency checks on create and PATCH", async (mismatch, {
    makeOrganization,
    makeLlmProviderApiKey,
    makeVirtualApiKey,
  }) => {
    const providerKey =
      mismatch === "organization"
        ? await makeLlmProviderApiKey(
            (await makeOrganization()).id,
            copilotKey.secretId,
            { provider: "github-copilot", userId: owner.id },
          )
        : copilotKey;
    const providerApiKeys = [
      {
        provider: mismatch === "provider" ? "openai" : "github-copilot",
        providerApiKeyId: providerKey.id,
      },
    ];
    const beforeCreate = await creationState();
    const deniedCreate = await create({ providerApiKeys });
    expect(deniedCreate.statusCode, deniedCreate.body).toBe(
      mismatch === "organization" ? 404 : 400,
    );
    expect(await creationState()).toEqual(beforeCreate);
    const key = await makeVirtualApiKey(organizationId, {
      authorId: owner.id,
      access: "personal",
    });
    const beforePatch = await keyState(key.id);
    const deniedPatch = await patch(key.id, { providerApiKeys });
    expect(deniedPatch.statusCode, deniedPatch.body).toBe(
      mismatch === "organization" ? 404 : 400,
    );
    expect(await keyState(key.id)).toEqual(beforePatch);
  });

  test("rejects sharing on create and an already-shared PATCH without partial writes", async ({
    makeUser,
    makeMember,
    makeVirtualApiKey,
  }) => {
    const recipient = await makeUser();
    await makeMember(recipient.id, organizationId);
    const beforeCreate = await creationState();
    const deniedCreate = await create({
      initialGrants: [
        {
          subject: { type: "user", id: recipient.id },
          actions: ["read", "use"],
        },
      ],
    });
    expect(deniedCreate.statusCode, deniedCreate.body).toBe(400);
    expect(deniedCreate.json().error.message).toContain("cannot be shared");
    expect(await creationState()).toEqual(beforeCreate);
    const key = await makeVirtualApiKey(organizationId, {
      authorId: owner.id,
      access: { users: [recipient.id] },
    });
    const beforePatch = await keyState(key.id);
    const deniedPatch = await patch(key.id);
    expect(deniedPatch.statusCode, deniedPatch.body).toBe(400);
    expect(deniedPatch.json().error.message).toContain("cannot be shared");
    expect(await keyState(key.id)).toEqual(beforePatch);
  });

  test("keeps GitHub App credentials on the ordinary shared-credential path without wildcard update", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await setWildcardAuthority([]);
    const secret = await makeSecret({
      secret: {
        apiKey: encodeGithubAppReference({
          ref: { organizationId, credentialId: randomUUID() },
          installationId: "123",
          organization: "example-org",
          githubUrl: "https://github.com",
        }),
      },
    });
    const enterpriseKey = await makeLlmProviderApiKey(
      organizationId,
      secret.id,
      {
        provider: "github-copilot",
        access: "org",
      },
    );
    expect(
      await LlmProviderApiKeyModel.canUseKey(
        enterpriseKey,
        serviceAccountUserId(serviceAccountId),
        [],
      ),
    ).toBe(true);
    const response = await create({
      ownerId: undefined,
      providerApiKeys: mapping(enterpriseKey),
    });
    expect(response.statusCode, response.body).toBe(200);
    const policyKey = {
      organizationId,
      resource: "llmVirtualKey" as const,
      scope: response.json().id,
    };
    const policy = await ResourcePermissionPolicyModel.find(policyKey);
    await ResourcePermissionPolicyModel.replace({
      ...policyKey,
      revision: policy?.revision ?? 0,
      grants: [
        ...(policy?.grants ?? []),
        {
          subject: { type: "serviceAccount", id: serviceAccountId },
          actions: ["read", "update"],
        },
      ],
    });
    const updated = await patch(response.json().id, {
      providerApiKeys: mapping(enterpriseKey),
    });
    expect(updated.statusCode, updated.body).toBe(200);
  });

  test("rechecks owner matching at runtime for delegated and legacy mismatched mappings", async ({
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
  }) => {
    const response = await create();
    expect(response.statusCode, response.body).toBe(200);
    const created = response.json();
    const params = {
      tokenValue: created.value,
      expectedProvider: "github-copilot",
      expectedOrganizationId: organizationId,
    };
    expect((await validateVirtualApiKey(params)).apiKey).toBe(
      "gho_owner_token",
    );
    const other = await makeUser();
    await makeMember(other.id, organizationId);
    const mismatched = await makeLlmProviderApiKey(
      organizationId,
      copilotKey.secretId,
      {
        provider: "github-copilot",
        userId: other.id,
      },
    );
    await VirtualApiKeyModel.update({
      id: created.id,
      name: "Legacy mismatched mapping",
      authorId: owner.id,
      scope: "personal",
      teamIds: [],
      providerApiKeys: mapping(mismatched),
      expiresAt: null,
    });
    await expect(validateVirtualApiKey(params)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
