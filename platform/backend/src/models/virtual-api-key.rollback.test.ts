import {
  ARCHESTRA_TOKEN_PREFIX,
  LEGACY_ARCHESTRA_TOKEN_PREFIXES,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import { describe } from "vitest";
import db, { schema } from "@/database";
import { expect, test } from "@/test";
import LimitModel from "./limit";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import VirtualApiKeyModel from "./virtual-api-key";

describe("VirtualApiKeyModel", () => {
  // =========================================================================
  // create
  // =========================================================================

  test("create: creates a virtual key and returns the token value", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const { virtualKey, value } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Test Virtual Key",
    });

    expect(virtualKey.id).toBeDefined();
    expect(virtualKey.name).toBe("Test Virtual Key");
    expect(virtualKey.expiresAt).toBeNull();
    expect(value).toMatch(
      new RegExp(`^${ARCHESTRA_TOKEN_PREFIX}[a-f0-9]{64}$`),
    );
    expect(virtualKey.tokenStart).toBe(value.substring(0, 14));
  });

  test("create: stores expiresAt when provided", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const futureDate = new Date(Date.now() + 86400_000);
    const { virtualKey } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Expiring Key",
      expiresAt: futureDate,
    });

    expect(virtualKey.expiresAt).toBeInstanceOf(Date);
    expect(virtualKey.expiresAt?.getTime()).toBe(futureDate.getTime());
  });

  test("capExpiry tightens legacy leases without extending deadlines or changing grants", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    const user = await makeUser();
    const created = await VirtualApiKeyModel.create({
      organizationId: organization.id,
      name: "Retained runtime key",
      keyType: "passthrough",
      scope: "personal",
      authorId: user.id,
    });
    const params = {
      id: created.virtualKey.id,
      organizationId: organization.id,
      expectedScope: "personal" as const,
      expectedAuthorId: user.id,
    };
    const policyParams = {
      organizationId: organization.id,
      resource: "llmVirtualKey" as const,
      scope: params.id,
    };
    const grants = await ResourcePermissionPolicyModel.find(policyParams);
    const firstDeadline = new Date(Date.now() + 3600_000);
    expect(
      (
        await VirtualApiKeyModel.capExpiry({
          ...params,
          expiresAt: firstDeadline,
        })
      )?.expiresAt,
    ).toEqual(firstDeadline);
    expect(
      (
        await VirtualApiKeyModel.capExpiry({
          ...params,
          expiresAt: new Date(Date.now() + 7200_000),
        })
      )?.expiresAt,
    ).toEqual(firstDeadline);
    const tighter = new Date(Date.now() + 1800_000);
    expect(
      (await VirtualApiKeyModel.capExpiry({ ...params, expiresAt: tighter }))
        ?.expiresAt,
    ).toEqual(tighter);
    expect(
      await VirtualApiKeyModel.capExpiry({
        ...params,
        organizationId: otherOrganization.id,
        expiresAt: new Date(0),
      }),
    ).toBeNull();
    expect(
      await VirtualApiKeyModel.capExpiry({
        ...params,
        expectedAuthorId: "changed-owner",
        expiresAt: new Date(0),
      }),
    ).toBeNull();
    expect(
      await VirtualApiKeyModel.capExpiry({
        ...params,
        expectedScope: "org",
        expiresAt: new Date(0),
      }),
    ).toBeNull();
    expect(await VirtualApiKeyModel.findById(params.id)).toMatchObject({
      expiresAt: tighter,
      scope: "personal",
      authorId: user.id,
    });
    expect(await ResourcePermissionPolicyModel.find(policyParams)).toEqual(
      grants,
    );
  });

  test("capExpiry cannot resurrect an expired credential", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const expired = new Date(Date.now() - 60_000);
    const created = await VirtualApiKeyModel.create({
      organizationId: organization.id,
      name: "Expired runtime key",
      keyType: "passthrough",
      expiresAt: expired,
    });
    expect(
      (
        await VirtualApiKeyModel.capExpiry({
          id: created.virtualKey.id,
          organizationId: organization.id,
          expectedAuthorId: null,
          expectedScope: "org",
          expiresAt: new Date(Date.now() + 3600_000),
        })
      )?.expiresAt,
    ).toEqual(expired);
  });

  test("create: stores scope, author, and team assignments", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const secret = await makeSecret({ secret: { apiKey: "sk-real-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const { virtualKey, teams, authorName } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Team Virtual Key",
      scope: "team",
      authorId: user.id,
      teamIds: [team.id],
    });

    expect(virtualKey.scope).toBe("team");
    expect(virtualKey.authorId).toBe(user.id);
    expect(teams).toEqual([{ id: team.id, name: team.name }]);
    expect(authorName).toBe(user.name);
    expect(
      await VirtualApiKeyModel.getTeamIdsForVirtualApiKey(virtualKey.id),
    ).toEqual([team.id]);
  });

  // =========================================================================
  // findByProviderApiKeyId
  // =========================================================================

  test("findByProviderApiKeyId: returns all virtual keys for a chat API key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Key A",
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Key B",
    });

    const keys = await VirtualApiKeyModel.findByProviderApiKeyId(chatApiKey.id);
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.name)).toContain("Key A");
    expect(keys.map((k) => k.name)).toContain("Key B");
  });

  test("findByProviderApiKeyId: returns empty array for unknown id", async () => {
    const keys = await VirtualApiKeyModel.findByProviderApiKeyId(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(keys).toHaveLength(0);
  });

  test("findByProviderApiKeyId: respects organization boundary for access-controlled lookups", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeLlmProviderApiKey(orgB.id, secret.id);

    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Other Org Key",
      scope: "org",
    });

    const keys = await VirtualApiKeyModel.findByProviderApiKeyId({
      providerApiKeyId: chatApiKey.id,
      organizationId: orgA.id,
      userId: user.id,
      userTeamIds: [],
      isAdmin: true,
    });

    expect(keys).toEqual([]);
  });

  // =========================================================================
  // findById
  // =========================================================================

  test("findById: returns the virtual key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const { virtualKey } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Find Me",
    });

    const found = await VirtualApiKeyModel.findById(virtualKey.id);
    expect(found).not.toBeNull();
    expect(found?.name).toBe("Find Me");
  });

  test("findById: returns null for unknown id", async () => {
    const found = await VirtualApiKeyModel.findById(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(found).toBeNull();
  });

  // =========================================================================
  // delete
  // =========================================================================

  test("delete: removes a virtual key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const { virtualKey } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Delete Me",
    });
    const runBudget = await LimitModel.create({
      entityType: "virtual_key",
      entityId: virtualKey.id,
      limitType: "token_cost",
      limitValue: 25,
      model: null,
    });

    const deleted = await VirtualApiKeyModel.delete(virtualKey.id);
    expect(deleted).toBe(true);

    const found = await VirtualApiKeyModel.findById(virtualKey.id);
    expect(found).toBeNull();
    expect(await LimitModel.findById(runBudget.id)).toBeNull();
  });

  test("delete: returns false for unknown id", async () => {
    const deleted = await VirtualApiKeyModel.delete(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(deleted).toBe(false);
  });

  // =========================================================================
  // countByProviderApiKeyId
  // =========================================================================

  test("countByProviderApiKeyId: returns correct count", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    expect(
      await VirtualApiKeyModel.countByProviderApiKeyId(chatApiKey.id),
    ).toBe(0);

    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Key 1",
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Key 2",
    });

    expect(
      await VirtualApiKeyModel.countByProviderApiKeyId(chatApiKey.id),
    ).toBe(2);
  });

  // =========================================================================
  // validateToken
  // =========================================================================

  test("validateToken: validates a correct token and returns key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const { value } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Validate Me",
    });

    const result = await VirtualApiKeyModel.validateToken(value);
    expect(result).not.toBeNull();
    expect(result?.virtualKey.name).toBe("Validate Me");
  });

  test("validateToken: returns null for invalid token", async () => {
    const result = await VirtualApiKeyModel.validateToken(
      `${LEGACY_ARCHESTRA_TOKEN_PREFIXES[0]}0000000000000000000000000000`,
    );
    expect(result).toBeNull();
  });

  test("validateToken: returns null for non-platform token", async () => {
    const result = await VirtualApiKeyModel.validateToken("sk-some-random-key");
    expect(result).toBeNull();
  });

  // =========================================================================
  // findAllByOrganization
  // =========================================================================

  test("findAllByOrganization: returns virtual keys with provider API key mappings", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const viewer = await makeUser();
    await makeMember(viewer.id, org.id, { role: "admin" });
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      name: "Parent Key",
      provider: "anthropic",
    });

    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Virtual A",
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Virtual B",
    });

    const result = await VirtualApiKeyModel.findAllByOrganization({
      organizationId: org.id,
      userId: viewer.id,
      pagination: { limit: 20, offset: 0 },
    });
    expect(result.data).toHaveLength(2);
    expect(result.data[0].providerApiKeys).toEqual([
      {
        provider: "anthropic",
        providerApiKeyId: chatApiKey.id,
        providerApiKeyName: "Parent Key",
      },
    ]);
    expect(result.data.map((r) => r.name)).toContain("Virtual A");
    expect(result.data.map((r) => r.name)).toContain("Virtual B");
    expect(result.pagination.total).toBe(2);
  });

  test("findAllByOrganization: returns empty for org with no virtual keys", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const result = await VirtualApiKeyModel.findAllByOrganization({
      organizationId: org.id,
      pagination: { limit: 20, offset: 0 },
    });
    expect(result.data).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
  });

  test("findAllByOrganization: filters by search and parent provider API key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const viewer = await makeUser();
    await makeMember(viewer.id, org.id, { role: "admin" });
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const anthropicKey = await makeLlmProviderApiKey(org.id, secret.id, {
      name: "Anthropic Parent",
      provider: "anthropic",
    });
    const openAiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      name: "OpenAI Parent",
      provider: "openai",
    });

    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: anthropicKey.provider, providerApiKeyId: anthropicKey.id },
      ],
      name: "Primary Virtual Key",
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: openAiKey.provider, providerApiKeyId: openAiKey.id },
      ],
      name: "Backup Virtual Key",
    });

    const result = await VirtualApiKeyModel.findAllByOrganization({
      organizationId: org.id,
      userId: viewer.id,
      pagination: { limit: 20, offset: 0 },
      search: "primary",
      providerApiKeyId: anthropicKey.id,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].name).toBe("Primary Virtual Key");
    expect(result.data[0].providerApiKeys).toEqual([
      {
        provider: "anthropic",
        providerApiKeyId: anthropicKey.id,
        providerApiKeyName: "Anthropic Parent",
      },
    ]);
    expect(result.pagination.total).toBe(1);
  });

  test("findAllByOrganization: treats LIKE wildcard characters in search as literals", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const viewer = await makeUser();
    await makeMember(viewer.id, org.id, { role: "admin" });
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      name: "Parent Key",
      provider: "anthropic",
    });

    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Virtual%Key",
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Virtual Alpha Key",
    });

    const result = await VirtualApiKeyModel.findAllByOrganization({
      organizationId: org.id,
      userId: viewer.id,
      pagination: { limit: 20, offset: 0 },
      search: "%",
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].name).toBe("Virtual%Key");
    expect(result.pagination.total).toBe(1);
  });

  test("findAllByOrganization: applies scope visibility for non-admin users", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
    makeTeam,
    makeMember,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser({ email: "owner@test.com" });
    const otherUser = await makeUser({ email: "other@test.com" });
    const team = await makeTeam(org.id, owner.id, { name: "Platform Team" });
    await makeMember(owner.id, org.id);
    await makeMember(otherUser.id, org.id);
    await makeTeamMember(team.id, owner.id);
    const outsiderTeam = await makeTeam(org.id, owner.id, {
      name: "Other Team",
    });
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Org Key",
      scope: "org",
      publishToOrganization: true,
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "My Personal Key",
      scope: "personal",
      authorId: owner.id,
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Other Personal Key",
      scope: "personal",
      authorId: otherUser.id,
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "My Team Key",
      scope: "team",
      authorId: owner.id,
      teamIds: [team.id],
      initialPermissionGrants: [
        { subject: { type: "team", id: team.id }, actions: ["read", "use"] },
      ],
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Other Team Key",
      scope: "team",
      authorId: otherUser.id,
      teamIds: [outsiderTeam.id],
      initialPermissionGrants: [
        {
          subject: { type: "team", id: outsiderTeam.id },
          actions: ["read", "use"],
        },
      ],
    });

    const result = await VirtualApiKeyModel.findAllByOrganization({
      organizationId: org.id,
      pagination: { limit: 20, offset: 0 },
      userId: owner.id,
      userTeamIds: [team.id],
      isAdmin: false,
    });

    expect(result.data.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Org Key", "My Personal Key", "My Team Key"]),
    );
    expect(result.data.map((item) => item.name)).not.toContain(
      "Other Personal Key",
    );
    expect(result.data.map((item) => item.name)).not.toContain(
      "Other Team Key",
    );
  });

  test("findAllByOrganization: admin can see all scopes", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const otherUser = await makeUser({ email: "other-admin@test.com" });
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Org Key",
      scope: "org",
      publishToOrganization: true,
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Other Personal Key",
      scope: "personal",
      authorId: otherUser.id,
    });

    const result = await VirtualApiKeyModel.findAllByOrganization({
      organizationId: org.id,
      pagination: { limit: 20, offset: 0 },
      userId: user.id,
      userTeamIds: [],
      isAdmin: true,
    });

    expect(result.data.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Org Key", "Other Personal Key"]),
    );
  });

  test("update: updates scope, teams, and expiration", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);
    const futureDate = new Date(Date.now() + 3600_000);

    const { virtualKey } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "Before",
      scope: "personal",
      authorId: user.id,
    });

    const updated = await VirtualApiKeyModel.update({
      id: virtualKey.id,
      name: "After",
      expiresAt: futureDate,
      scope: "team",
      authorId: user.id,
      teamIds: [team.id],
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
    });

    expect(updated?.name).toBe("After");
    expect(updated?.scope).toBe("team");
    expect(updated?.expiresAt?.getTime()).toBe(futureDate.getTime());
    expect(
      await VirtualApiKeyModel.getTeamIdsForVirtualApiKey(virtualKey.id),
    ).toEqual([team.id]);
  });

  test("ensureProviderMapping: replaces only the same provider's stale mapping", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const makeKey = async (provider: "anthropic" | "openai") =>
      makeLlmProviderApiKey(
        org.id,
        (await makeSecret({ secret: { apiKey: `sk-${provider}` } })).id,
        { provider },
      );
    const staleAnthropic = await makeKey("anthropic");
    const openai = await makeKey("openai");
    const freshAnthropic = await makeKey("anthropic");
    const { virtualKey } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: "anthropic", providerApiKeyId: staleAnthropic.id },
        { provider: "openai", providerApiKeyId: openai.id },
      ],
      name: "connection key",
    });

    // Twice: a repeat (two concurrent setups converging) changes nothing.
    for (let attempt = 0; attempt < 2; attempt++) {
      await VirtualApiKeyModel.ensureProviderMapping({
        virtualApiKeyId: virtualKey.id,
        provider: "anthropic",
        providerApiKeyId: freshAnthropic.id,
      });
    }

    expect(
      (await VirtualApiKeyModel.getProviderApiKeys(virtualKey.id)).map(
        ({ provider, providerApiKeyId }) => ({ provider, providerApiKeyId }),
      ),
    ).toEqual([
      { provider: "anthropic", providerApiKeyId: freshAnthropic.id },
      { provider: "openai", providerApiKeyId: openai.id },
    ]);
  });

  test("getProviderApiKeysForRouting: orders one provider's keys primary first, then oldest", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const keys = [];
    for (const [index, [name, isPrimary]] of (
      [
        ["oldest", false],
        ["newer", false],
        ["primary", true],
      ] as const
    ).entries()) {
      const key = await makeLlmProviderApiKey(
        org.id,
        (await makeSecret({ secret: { apiKey: `sk-${name}` } })).id,
        { provider: "vllm", name, isPrimary },
      );
      // A rollback test runs in one transaction, where now() never advances:
      // give each key its own creation time so "oldest" is well defined.
      await db
        .update(schema.llmProviderApiKeysTable)
        .set({ createdAt: new Date(Date.UTC(2026, 0, index + 1)) })
        .where(eq(schema.llmProviderApiKeysTable.id, key.id));
      keys.push(key);
    }
    const { virtualKey } = await VirtualApiKeyModel.create({
      providerApiKeys: [...keys].reverse().map((key) => ({
        provider: "vllm" as const,
        providerApiKeyId: key.id,
      })),
      name: "three endpoints",
    });

    expect(
      (
        await VirtualApiKeyModel.getProviderApiKeysForRouting(virtualKey.id)
      ).map((mapping) => mapping.providerApiKeyName),
    ).toEqual(["primary", "oldest", "newer"]);
  });
});
