import { vi } from "vitest";
import config from "@/config";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { describe, expect, test } from "@/test";
import { SelectLlmProviderApiKeySchema } from "@/types";
import { _resetCachedKey } from "@/utils/crypto";
import LlmProviderApiKeyModel from "./llm-provider-api-key";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

describe("LlmProviderApiKeyModel", () => {
  test("an old validation cannot overwrite a reconnected credential", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const secret = await makeSecret();
    const key = await makeLlmProviderApiKey(org.id, secret.id);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(key.updatedAt.getTime() + 1000));
      await LlmProviderApiKeyModel.setRequiresReauthentication({
        id: key.id,
        requiresReauthentication: false,
      });
      await LlmProviderApiKeyModel.setRequiresReauthentication({
        id: key.id,
        requiresReauthentication: true,
        expectedUpdatedAt: key.updatedAt,
      });
      expect(
        (await LlmProviderApiKeyModel.findById(key.id))
          ?.requiresReauthentication,
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("create", () => {
    test("can create a personal LLM provider API key", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const user = await makeUser();

      const apiKey = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "My Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      expect(apiKey).toBeDefined();
      expect(apiKey.id).toBeDefined();
      expect(apiKey.organizationId).toBe(org.id);
      expect(apiKey.name).toBe("My Personal Key");
      expect(apiKey.provider).toBe("anthropic");
      expect(apiKey.scope).toBe("personal");
      expect(apiKey.userId).toBe(user.id);
      expect(apiKey.teamId).toBeNull();
    });

    test("can create a team LLM provider API key", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Test Team" });

      const apiKey = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Team Key",
        provider: "anthropic",
        scope: "team",
        teamId: team.id,
      });

      expect(apiKey.scope).toBe("team");
      expect(apiKey.teamId).toBe(team.id);
      expect(apiKey.userId).toBeNull();
    });

    test("can create an org-wide LLM provider API key", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });

      const apiKey = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Org Wide Key",
        provider: "anthropic",
        scope: "org",
      });

      expect(apiKey.scope).toBe("org");
      expect(apiKey.userId).toBeNull();
      expect(apiKey.teamId).toBeNull();
    });

    test("allows multiple keys per provider and scope", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const user = await makeUser();

      const key1 = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Personal Key 1",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      const key2 = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Personal Key 2",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      expect(key1.id).toBeDefined();
      expect(key2.id).toBeDefined();
      expect(key1.id).not.toBe(key2.id);
    });

    test("can create key with isPrimary", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const user = await makeUser();

      const key = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Primary Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
        isPrimary: true,
      });

      expect(key.isPrimary).toBe(true);
    });

    test("creating a new primary demotes the current primary in the same scope", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });

      const first = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "First Org Key",
        provider: "openai",
        scope: "org",
        isPrimary: true,
      });

      // Previously this violated chat_api_keys_primary_org_unique and 500'd.
      const second = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Second Org Key",
        provider: "openai",
        scope: "org",
        isPrimary: true,
      });

      expect(second.isPrimary).toBe(true);
      const demoted = await LlmProviderApiKeyModel.findById(first.id);
      expect(demoted?.isPrimary).toBe(false);
    });

    test("a new primary does not demote primaries in other scopes or providers", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const user = await makeUser();

      const personalPrimary = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Personal Primary",
        provider: "openai",
        scope: "personal",
        userId: user.id,
        isPrimary: true,
      });
      const otherProviderPrimary = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Anthropic Org Primary",
        provider: "anthropic",
        scope: "org",
        isPrimary: true,
      });

      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "OpenAI Org Primary",
        provider: "openai",
        scope: "org",
        isPrimary: true,
      });

      expect(
        (await LlmProviderApiKeyModel.findById(personalPrimary.id))?.isPrimary,
      ).toBe(true);
      expect(
        (await LlmProviderApiKeyModel.findById(otherProviderPrimary.id))
          ?.isPrimary,
      ).toBe(true);
    });

    test("own keys and shared keys are separate primary partitions, decided by the owner column", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const alice = await makeUser();
      const bob = await makeUser();
      const team = await makeTeam(org.id, alice.id);

      const aliceOwn = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Alice own",
        provider: "openai",
        scope: "personal",
        userId: alice.id,
        isPrimary: true,
      });
      const bobOwn = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Bob own",
        provider: "openai",
        scope: "personal",
        userId: bob.id,
        isPrimary: true,
      });
      const teamShared = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Team shared",
        provider: "openai",
        scope: "team",
        teamId: team.id,
        isPrimary: true,
      });
      // A second shared key (no owner) takes the one shared primary, whatever
      // audience its grants give it. The own keys keep theirs.
      const orgShared = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Org shared",
        provider: "openai",
        scope: "org",
        isPrimary: true,
      });

      const primaryOf = async (id: string) =>
        (await LlmProviderApiKeyModel.findById(id))?.isPrimary;
      expect(await primaryOf(aliceOwn.id)).toBe(true);
      expect(await primaryOf(bobOwn.id)).toBe(true);
      expect(await primaryOf(teamShared.id)).toBe(false);
      expect(await primaryOf(orgShared.id)).toBe(true);

      // A second own key for Alice demotes only her first one.
      const aliceSecond = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Alice second",
        provider: "openai",
        scope: "personal",
        userId: alice.id,
        isPrimary: true,
      });
      expect(await primaryOf(aliceSecond.id)).toBe(true);
      expect(await primaryOf(aliceOwn.id)).toBe(false);
      expect(await primaryOf(bobOwn.id)).toBe(true);
      expect(await primaryOf(orgShared.id)).toBe(true);
    });

    test("allows personal keys for different providers", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const user = await makeUser();

      const anthropicKey = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Anthropic Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      const openaiKey = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "OpenAI Key",
        provider: "openai",
        scope: "personal",
        userId: user.id,
      });

      expect(anthropicKey.provider).toBe("anthropic");
      expect(openaiKey.provider).toBe("openai");
    });

    test("baseUrl and inferenceBaseUrl are nullable and round-trip", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const user = await makeUser();

      // Key without baseUrl should have null
      const keyWithoutBaseUrl = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "No BaseUrl Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });
      expect(keyWithoutBaseUrl.baseUrl).toBeNull();
      expect(keyWithoutBaseUrl.inferenceBaseUrl).toBeNull();

      // Key with baseUrl should store it
      const keyWithBaseUrl = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Custom BaseUrl Key",
        provider: "openai",
        scope: "personal",
        userId: user.id,
        baseUrl: "https://custom-api.example.com",
        inferenceBaseUrl: "https://runtime-api.example.com",
      });
      expect(keyWithBaseUrl.baseUrl).toBe("https://custom-api.example.com");
      expect(keyWithBaseUrl.inferenceBaseUrl).toBe(
        "https://runtime-api.example.com",
      );

      // Verify via findById that nullable baseUrl round-trips correctly
      const found = await LlmProviderApiKeyModel.findById(keyWithoutBaseUrl.id);
      expect(found?.baseUrl).toBeNull();
      expect(found?.inferenceBaseUrl).toBeNull();
    });
  });

  describe("findById", () => {
    test("can find an LLM provider API key by ID", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const user = await makeUser();
      const created = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      const found = await LlmProviderApiKeyModel.findById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.name).toBe("Test Key");
    });

    test("returns null for non-existent ID", async () => {
      const found = await LlmProviderApiKeyModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(found).toBeNull();
    });
  });

  describe("findByOrganizationId", () => {
    test("can find all LLM provider API keys for an organization", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const user = await makeUser();

      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Key 1",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });
      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Key 2",
        provider: "openai",
        scope: "org",
      });

      const keys = await LlmProviderApiKeyModel.findByOrganizationId(org.id);

      expect(keys).toHaveLength(2);
      expect(keys.map((k) => k.name)).toContain("Key 1");
      expect(keys.map((k) => k.name)).toContain("Key 2");
    });
  });

  describe("findOrganizationWideKey", () => {
    test("finds a key published to the whole organization, whatever its retired scope says", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const key = await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Published Key",
          provider: "anthropic",
          scope: "personal",
        },
        {
          initialPermissionGrants: [
            {
              subject: { type: "organization", id: "*" },
              actions: ["read", "use"],
            },
          ],
        },
      );

      expect(
        (
          await LlmProviderApiKeyModel.findOrganizationWideKey(
            org.id,
            "anthropic",
          )
        )?.id,
      ).toBe(key.id);
    });

    test("ignores a key the organization cannot use, whatever its retired scope says", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Unpublished Key",
          provider: "anthropic",
          scope: "org",
        },
        { initialPermissionGrants: [] },
      );

      expect(
        await LlmProviderApiKeyModel.findOrganizationWideKey(
          org.id,
          "anthropic",
        ),
      ).toBeNull();
    });
  });

  describe("update", () => {
    test("can update a chat API key", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const user = await makeUser();
      const apiKey = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Original Name",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      const updated = await LlmProviderApiKeyModel.update(apiKey.id, {
        name: "Updated Name",
      });

      expect(updated).toBeDefined();
      expect(updated?.name).toBe("Updated Name");
    });

    test("promoting a key to primary demotes the current primary in its scope", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const currentPrimary = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Current Primary",
        provider: "openai",
        scope: "org",
        isPrimary: true,
      });
      const challenger = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Challenger",
        provider: "openai",
        scope: "org",
      });

      // Previously this violated chat_api_keys_primary_org_unique and 500'd.
      const promoted = await LlmProviderApiKeyModel.update(challenger.id, {
        isPrimary: true,
      });

      expect(promoted?.isPrimary).toBe(true);
      expect(
        (await LlmProviderApiKeyModel.findById(currentPrimary.id))?.isPrimary,
      ).toBe(false);
    });

    test("re-promoting the current primary is a no-op that keeps it primary", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const primary = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Primary",
        provider: "openai",
        scope: "org",
        isPrimary: true,
      });

      const updated = await LlmProviderApiKeyModel.update(primary.id, {
        isPrimary: true,
      });

      expect(updated?.isPrimary).toBe(true);
    });
  });

  describe("delete", () => {
    test("can delete a chat API key", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const user = await makeUser();
      const apiKey = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "To Delete",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      const deleted = await LlmProviderApiKeyModel.delete(apiKey.id);
      const found = await LlmProviderApiKeyModel.findById(apiKey.id);

      expect(deleted).toBe(true);
      expect(found).toBeNull();
    });
  });

  describe("getVisibleKeys", () => {
    test("user sees their own personal keys", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user1 = await makeUser({ email: "user1@test.com" });
      await makeMember(user1.id, org.id);
      const user2 = await makeUser({ email: "user2@test.com" });
      await makeMember(user2.id, org.id);

      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "User1 Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: user1.id,
      });
      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "User2 Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: user2.id,
      });

      const visibleToUser1 = await LlmProviderApiKeyModel.getVisibleKeys(
        org.id,
        user1.id,
        [],
        false,
      );

      expect(visibleToUser1).toHaveLength(1);
      expect(visibleToUser1[0].name).toBe("User1 Personal Key");
    });

    test("user sees team keys for their teams", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeMember,
      makeTeamMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const team = await makeTeam(org.id, user.id, { name: "Test Team" });
      await makeTeamMember(team.id, user.id);

      await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Team Key",
          provider: "anthropic",
          scope: "team",
          teamId: team.id,
        },
        {
          initialPermissionGrants: [
            {
              subject: { type: "team", id: team.id },
              actions: ["read", "use"],
            },
          ],
        },
      );

      const visible = await LlmProviderApiKeyModel.getVisibleKeys(
        org.id,
        user.id,
        [team.id],
        false,
      );

      expect(visible).toHaveLength(1);
      expect(visible[0].name).toBe("Team Key");
    });

    test("user sees org-wide keys", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Org Wide Key",
          provider: "anthropic",
          scope: "org",
        },
        { publishToOrganization: true },
      );

      const visible = await LlmProviderApiKeyModel.getVisibleKeys(
        org.id,
        user.id,
        [],
        false,
      );

      expect(visible).toHaveLength(1);
      expect(visible[0].name).toBe("Org Wide Key");
    });

    test("admin sees all keys except other users personal keys", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const admin = await makeUser({ email: "admin@test.com" });
      await makeMember(admin.id, org.id, { role: "admin" });
      const user = await makeUser({ email: "user@test.com" });
      await makeMember(user.id, org.id);

      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Admin Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: admin.id,
      });
      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "User Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });
      await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Org Wide Key",
          provider: "openai",
          scope: "org",
        },
        { publishToOrganization: true },
      );

      const visible = await LlmProviderApiKeyModel.getVisibleKeys(
        org.id,
        admin.id,
        [],
        true, // isAgentAdmin
      );

      // Admin sees own personal key, all team keys, all org-wide keys, but not other users' personal keys
      expect(visible).toHaveLength(2);
      expect(visible.map((k) => k.name)).toContain("Admin Personal Key");
      expect(visible.map((k) => k.name)).toContain("Org Wide Key");
      expect(visible.map((k) => k.name)).not.toContain("User Personal Key");
    });

    test("supports filtering visible keys by search and provider", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Primary Anthropic Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });
      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "OpenAI Backup",
        provider: "openai",
        scope: "personal",
        userId: user.id,
      });

      const visible = await LlmProviderApiKeyModel.getVisibleKeys(
        org.id,
        user.id,
        [],
        false,
        {
          search: "primary",
          provider: "anthropic",
        },
      );

      expect(visible).toHaveLength(1);
      expect(visible[0].name).toBe("Primary Anthropic Key");
    });

    test("treats LIKE wildcard characters in search as literals", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Primary%Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });
      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Primary Alpha Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      const visible = await LlmProviderApiKeyModel.getVisibleKeys(
        org.id,
        user.id,
        [],
        false,
        {
          search: "%",
        },
      );

      expect(visible).toHaveLength(1);
      expect(visible[0].name).toBe("Primary%Key");
    });

    test("flags a ChatGPT-subscription (Codex) key so the edit form can pick the right tab", async ({
      makeOrganization,
      makeUser,
      makeSecret,
      makeLlmProviderApiKey,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const codexSecret = await makeSecret({
        secret: {
          apiKey: encodeOpenAiCodexCredential({
            refreshToken: "rt-abc",
            accountId: "acct-123",
          }),
        },
      });
      await makeLlmProviderApiKey(org.id, codexSecret.id, {
        provider: "openai",
        userId: user.id,
        name: "ChatGPT Subscription",
      });

      const plainSecret = await makeSecret({ secret: { apiKey: "sk-plain" } });
      await makeLlmProviderApiKey(org.id, plainSecret.id, {
        provider: "openai",
        userId: user.id,
        name: "Plain OpenAI Key",
      });

      const visible = await LlmProviderApiKeyModel.getVisibleKeys(
        org.id,
        user.id,
        [],
        false,
        undefined,
        { includeSubscriptionInfo: true },
      );

      const codexKey = visible.find((k) => k.name === "ChatGPT Subscription");
      const plainKey = visible.find((k) => k.name === "Plain OpenAI Key");
      expect(codexKey?.subscriptionKind).toBe("chatgpt");
      expect(plainKey?.subscriptionKind).toBeNull();
    });

    test("still lists a key whose stored secret cannot be decrypted", async ({
      makeOrganization,
      makeUser,
      makeSecret,
      makeLlmProviderApiKey,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const secret = await makeSecret({ secret: { apiKey: "sk-old" } });
      await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
        userId: user.id,
        name: "Key From Before Rotation",
      });

      // Simulate an encryption-secret rotation: the stored secret was encrypted
      // under the previous ARCHESTRA_SECRETS_ENCRYPTION_SECRET and can no longer
      // be decrypted with the current one.
      _resetCachedKey();
      const original = config.secretsManager.encryptionSecret;
      config.secretsManager.encryptionSecret =
        "rotated-encryption-secret-that-cannot-decrypt-old-rows";

      try {
        const visible = await LlmProviderApiKeyModel.getVisibleKeys(
          org.id,
          user.id,
          [],
          false,
          undefined,
          { includeSubscriptionInfo: true },
        );

        expect(visible).toHaveLength(1);
        expect(visible[0].name).toBe("Key From Before Rotation");
        // Metadata derived from the secret value degrades to its defaults.
        expect(visible[0].subscriptionKind).toBeNull();
        expect(visible[0].vaultSecretPath).toBeNull();
      } finally {
        config.secretsManager.encryptionSecret = original;
        _resetCachedKey();
      }
    });
  });

  describe("resolveApiKey", () => {
    // Decision 2 order, read from grants: the owner's key, then a shared key
    // granted to one of the caller's teams (even when it also reaches the
    // organization), then an organization key. The retired scope column plays
    // no part, and a newer, primary organization key does not jump the queue.
    test("ranks a key granted to the caller's team above an organization key, by grants", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "member" });
      const team = await makeTeam(org.id, user.id);
      await makeTeamMember(team.id, user.id);

      const teamKey = await makeLlmProviderApiKey(
        org.id,
        (await makeSecret()).id,
        {
          name: "Team and org",
          access: { teams: [team.id] },
        },
      );
      // The same key also reaches the organization.
      const policy = await ResourcePermissionPolicyModel.find({
        organizationId: org.id,
        resource: "llmProviderApiKey",
        scope: teamKey.id,
      });
      await ResourcePermissionPolicyModel.replace({
        organizationId: org.id,
        resource: "llmProviderApiKey",
        scope: teamKey.id,
        revision: policy?.revision ?? 0,
        grants: [
          ...(policy?.grants ?? []),
          { subject: { type: "organization", id: "*" }, actions: ["use"] },
        ],
      });
      await makeLlmProviderApiKey(org.id, (await makeSecret()).id, {
        name: "Org primary",
        isPrimary: true,
        access: "org",
      });

      const resolve = () =>
        LlmProviderApiKeyModel.getCurrentApiKey({
          organizationId: org.id,
          userId: user.id,
          userTeamIds: [team.id],
          provider: "anthropic",
          conversationId: null,
        });
      expect((await resolve())?.id).toBe(teamKey.id);

      const ownKey = await makeLlmProviderApiKey(
        org.id,
        (await makeSecret()).id,
        { name: "Mine", userId: user.id },
      );
      expect((await resolve())?.id).toBe(ownKey.id);

      const scopes = await LlmProviderApiKeyModel.findDisplayScopes({
        organizationId: org.id,
        keys: [teamKey, ownKey],
      });
      expect(scopes.get(ownKey.id)).toBe("personal");
      expect(scopes.get(teamKey.id)).toBe("org");
    });

    test("returns personal key first", async ({
      makeOrganization,
      makeUser,
      makeSecret,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const secret1 = await makeSecret();
      const secret2 = await makeSecret();

      const personalKey = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
        secretId: secret1.id,
      });
      await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Org Wide Key",
          provider: "anthropic",
          scope: "org",
          secretId: secret2.id,
        },
        { publishToOrganization: true },
      );

      const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
        provider: "anthropic",
        conversationId: null,
      });

      expect(resolved?.id).toBe(personalKey.id);
    });

    test("falls back to team key when no personal key", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeSecret,
      makeMember,
      makeTeamMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const team = await makeTeam(org.id, user.id, { name: "Test Team" });
      await makeTeamMember(team.id, user.id);
      const secret1 = await makeSecret();
      const secret2 = await makeSecret();

      const teamKey = await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Team Key",
          provider: "anthropic",
          scope: "team",
          teamId: team.id,
          secretId: secret1.id,
        },
        {
          initialPermissionGrants: [
            {
              subject: { type: "team", id: team.id },
              actions: ["read", "use"],
            },
          ],
        },
      );
      await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Org Wide Key",
          provider: "anthropic",
          scope: "org",
          secretId: secret2.id,
        },
        { publishToOrganization: true },
      );

      const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [team.id],
        provider: "anthropic",
        conversationId: null,
      });

      expect(resolved?.id).toBe(teamKey.id);
    });

    test("falls back to org-wide key when no personal or team key", async ({
      makeOrganization,
      makeUser,
      makeSecret,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const secret = await makeSecret();

      const orgWideKey = await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Org Wide Key",
          provider: "anthropic",
          scope: "org",
          secretId: secret.id,
        },
        { publishToOrganization: true },
      );

      const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
        provider: "anthropic",
        conversationId: null,
      });

      expect(resolved?.id).toBe(orgWideKey.id);
    });

    test("returns conversation key when specified", async ({
      makeOrganization,
      makeUser,
      makeSecret,
      makeAgent,
      makeConversation,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const secret1 = await makeSecret();
      const secret2 = await makeSecret();
      const agent = await makeAgent({ name: "Test Agent" });

      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Personal Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
        secretId: secret1.id,
      });
      const conversationKey = await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Org Wide Key",
          provider: "anthropic",
          scope: "org",
          secretId: secret2.id,
        },
        { publishToOrganization: true },
      );

      // Create a conversation with the org-wide key as its chatApiKeyId
      const conversation = await makeConversation(agent.id, {
        userId: user.id,
        organizationId: org.id,
        chatApiKeyId: conversationKey.id,
      });

      const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
        provider: "anthropic",
        conversationId: conversation.id,
      });

      expect(resolved?.id).toBe(conversationKey.id);
    });

    test("never picks a key its own policy grants nobody, even for an administrator", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSecret,
    }) => {
      const org = await makeOrganization();
      const admin = await makeUser();
      await makeMember(admin.id, org.id, { role: "admin" });
      // A personal key whose owner is gone, as the upgrade converts it: no
      // owner and a policy that grants no one. It is the older primary, so
      // only the orphan rule keeps it from winning the tie.
      const orphan = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Departed user's key",
        provider: "anthropic",
        scope: "personal",
        isPrimary: true,
        secretId: (await makeSecret()).id,
      });
      const key = {
        organizationId: org.id,
        resource: "llmProviderApiKey" as const,
        scope: orphan.id,
      };
      await ResourcePermissionPolicyModel.replace({
        ...key,
        revision:
          (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
        grants: [],
      });
      const shared = await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Organization key",
          provider: "anthropic",
          scope: "org",
          secretId: (await makeSecret()).id,
        },
        { publishToOrganization: true },
      );

      const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: admin.id,
        userTeamIds: [],
        provider: "anthropic",
        conversationId: null,
      });

      expect(resolved?.id).toBe(shared.id);
    });

    test("a system key reaches every member", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const systemKey = await LlmProviderApiKeyModel.createSystemKey({
        organizationId: org.id,
        name: "Platform key",
        provider: "gemini",
      });

      const available = await LlmProviderApiKeyModel.getAvailableKeysForUser(
        org.id,
        user.id,
        [],
      );

      expect(available.map((entry) => entry.id)).toContain(systemKey.id);
    });

    test("returns null when no keys available", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
        provider: "anthropic",
        conversationId: null,
      });

      expect(resolved).toBeNull();
    });

    test("prefers isPrimary key over older key in same scope", async ({
      makeOrganization,
      makeUser,
      makeSecret,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const secret1 = await makeSecret();
      const secret2 = await makeSecret();

      // Create an older key (not primary)
      await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Older Key",
          provider: "anthropic",
          scope: "org",
          secretId: secret1.id,
          isPrimary: false,
        },
        { publishToOrganization: true },
      );

      // Create a newer key marked as primary
      const primaryKey = await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Primary Key",
          provider: "anthropic",
          scope: "org",
          secretId: secret2.id,
          isPrimary: true,
        },
        { publishToOrganization: true },
      );

      const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
        provider: "anthropic",
        conversationId: null,
      });

      expect(resolved?.id).toBe(primaryKey.id);
    });

    test("falls back to oldest key when no primary is set", async ({
      makeOrganization,
      makeUser,
      makeSecret,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const secret1 = await makeSecret();
      const secret2 = await makeSecret();

      // Create two keys, neither is primary — oldest should win
      const olderKey = await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Older Key",
          provider: "anthropic",
          scope: "org",
          secretId: secret1.id,
        },
        { publishToOrganization: true },
      );

      await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Newer Key",
          provider: "anthropic",
          scope: "org",
          secretId: secret2.id,
        },
        { publishToOrganization: true },
      );

      const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
        provider: "anthropic",
        conversationId: null,
      });

      expect(resolved?.id).toBe(olderKey.id);
    });

    // GitHub Copilot is a per-user-credential provider: resolution must use ONLY
    // the acting user's personal key, never an agent's attached key or a
    // team/org key — those would let one user ride on another's GitHub token.
    test("per-user provider: resolves only the acting user's personal key", async ({
      makeOrganization,
      makeUser,
      makeSecret,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const secret = await makeSecret();

      const personalKey = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "My Copilot",
        provider: "github-copilot",
        scope: "personal",
        userId: user.id,
        secretId: secret.id,
      });

      const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
        provider: "github-copilot",
        conversationId: null,
      });

      expect(resolved?.id).toBe(personalKey.id);
    });

    test("per-user provider: ignores an agent's attached key and another user's/org key", async ({
      makeOrganization,
      makeUser,
      makeSecret,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const owner = await makeUser();
      await makeMember(owner.id, org.id);
      const otherUser = await makeUser();
      await makeMember(otherUser.id, org.id);
      const ownerSecret = await makeSecret();
      const orgSecret = await makeSecret();

      // The agent owner's personal Copilot key (used as the agent's attached key)
      const ownerKey = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Owner Copilot",
        provider: "github-copilot",
        scope: "personal",
        userId: owner.id,
        secretId: ownerSecret.id,
      });
      // An org-scoped Copilot key (shouldn't exist under enforcement, but the
      // guard must ignore it even if one is present)
      await LlmProviderApiKeyModel.create(
        {
          organizationId: org.id,
          name: "Shared Copilot",
          provider: "github-copilot",
          scope: "org",
          secretId: orgSecret.id,
        },
        { publishToOrganization: true },
      );

      // otherUser invokes the agent (agentLlmApiKeyId = owner's key) but has no
      // personal Copilot key → must resolve to null, not the owner's/org key.
      const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId: otherUser.id,
        userTeamIds: [],
        provider: "github-copilot",
        conversationId: null,
        agentLlmApiKeyId: ownerKey.id,
      });

      expect(resolved).toBeNull();
    });
  });

  describe("hasAnyApiKey", () => {
    test("returns true when organization has API keys", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });

      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key",
        provider: "anthropic",
        scope: "org",
      });

      const hasKeys = await LlmProviderApiKeyModel.hasAnyApiKey(org.id);

      expect(hasKeys).toBe(true);
    });

    test("returns false when organization has no API keys", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });

      const hasKeys = await LlmProviderApiKeyModel.hasAnyApiKey(org.id);

      expect(hasKeys).toBe(false);
    });
  });

  describe("hasConfiguredApiKey", () => {
    test("returns true when configured API key exists for provider", async ({
      makeOrganization,
      makeSecret,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const secret = await makeSecret();

      await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Anthropic Key",
        provider: "anthropic",
        scope: "org",
        secretId: secret.id,
      });

      const hasAnthropic = await LlmProviderApiKeyModel.hasConfiguredApiKey(
        org.id,
        "anthropic",
      );
      const hasOpenai = await LlmProviderApiKeyModel.hasConfiguredApiKey(
        org.id,
        "openai",
      );

      expect(hasAnthropic).toBe(true);
      expect(hasOpenai).toBe(false);
    });
  });

  describe("SelectLlmProviderApiKeySchema", () => {
    test("accepts null baseUrl without validation error", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const user = await makeUser();

      const key = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        name: "Test Key",
        provider: "anthropic",
        scope: "personal",
        userId: user.id,
      });

      // This would throw if baseUrl is not marked as nullable in the schema
      const result = SelectLlmProviderApiKeySchema.safeParse(key);
      expect(result.success).toBe(true);
    });
  });
});
