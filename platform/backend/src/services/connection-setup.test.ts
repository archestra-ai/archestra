import { ARCHESTRA_TOKEN_PREFIX } from "@archestra/shared";
import { VirtualApiKeyModel } from "@/models";
import {
  ensureConnectionVirtualKey,
  readVirtualKeyValue,
} from "@/services/connection-setup";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";

describe("ensureConnectionVirtualKey", () => {
  test("throws a 400 when no provider API key is configured", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    await expect(
      ensureConnectionVirtualKey({
        organizationId: org.id,
        userId: user.id,
        userEmail: user.email,
        userTeamIds: [],
        provider: "anthropic",
      }),
    ).rejects.toThrow(ApiError);
  });

  test("creates a personal key mapped to the resolved provider key, then reuses it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const secret = await makeSecret();
    const providerKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
    });

    const firstId = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "anthropic",
    });

    const created = await VirtualApiKeyModel.findById(firstId);
    expect(created?.scope).toBe("personal");
    expect(created?.authorId).toBe(user.id);
    expect(created?.name).toContain(user.email);
    expect(await VirtualApiKeyModel.getProviderApiKeys(firstId)).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        providerApiKeyId: providerKey.id,
      }),
    ]);

    const secondId = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "anthropic",
    });
    expect(secondId).toBe(firstId);
  });

  test("per-user provider: provisions a personal key mapped to the connecting user's own key", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const copilotKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "github-copilot", scope: "personal", userId: user.id },
    );

    const id = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "github-copilot",
    });

    const created = await VirtualApiKeyModel.findById(id);
    expect(created?.scope).toBe("personal");
    expect(created?.authorId).toBe(user.id);
    expect(await VirtualApiKeyModel.getProviderApiKeys(id)).toEqual([
      expect.objectContaining({
        provider: "github-copilot",
        providerApiKeyId: copilotKey.id,
      }),
    ]);
  });

  test("per-user provider: ignores an admin default and never wraps another user's key", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const otherUser = await makeUser();
    await makeMember(user.id, org.id);
    const ownKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      {
        provider: "github-copilot",
        scope: "personal",
        userId: user.id,
      },
    );
    const otherKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "github-copilot", scope: "personal", userId: otherUser.id },
    );

    const id = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "github-copilot",
      // An admin default pointing at someone else's personal key must be
      // ignored for per-user providers.
      preferredProviderKeyId: otherKey.id,
    });

    expect(await VirtualApiKeyModel.getProviderApiKeys(id)).toEqual([
      expect.objectContaining({
        provider: "github-copilot",
        providerApiKeyId: ownKey.id,
      }),
    ]);
  });

  test("per-user provider: throws when the user hasn't connected their own account", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    await expect(
      ensureConnectionVirtualKey({
        organizationId: org.id,
        userId: user.id,
        userEmail: user.email,
        userTeamIds: [],
        provider: "github-copilot",
      }),
    ).rejects.toThrow(/Connect your own/);
  });

  test("adds a second provider mapping without clobbering the first", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const anthropicKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "anthropic" },
    );
    const openaiKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "openai" },
    );

    const id = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "anthropic",
    });
    const sameId = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "openai",
    });

    expect(sameId).toBe(id);
    const mappings = await VirtualApiKeyModel.getProviderApiKeys(id);
    expect(mappings).toHaveLength(2);
    expect(mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "anthropic",
          providerApiKeyId: anthropicKey.id,
        }),
        expect.objectContaining({
          provider: "openai",
          providerApiKeyId: openaiKey.id,
        }),
      ]),
    );
  });

  test("replaces a stale same-provider mapping when key resolution changes", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const orgKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "anthropic", scope: "org" },
    );

    const id = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "anthropic",
    });
    expect(await VirtualApiKeyModel.getProviderApiKeys(id)).toEqual([
      expect.objectContaining({ providerApiKeyId: orgKey.id }),
    ]);

    // A personal key now outranks the org key in resolution precedence.
    const personalKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "anthropic", scope: "personal", userId: user.id },
    );

    const sameId = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "anthropic",
    });
    expect(sameId).toBe(id);
    expect(await VirtualApiKeyModel.getProviderApiKeys(id)).toEqual([
      expect.objectContaining({ providerApiKeyId: personalKey.id }),
    ]);
  });

  test("recreates the key when the row was deleted (revoked)", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    await makeLlmProviderApiKey(org.id, (await makeSecret()).id, {
      provider: "anthropic",
    });

    const firstId = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "anthropic",
    });
    await VirtualApiKeyModel.delete(firstId);

    const secondId = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "anthropic",
    });
    expect(secondId).not.toBe(firstId);
    expect(
      (await readVirtualKeyValue(secondId))?.startsWith(ARCHESTRA_TOKEN_PREFIX),
    ).toBe(true);
  });
});

describe("readVirtualKeyValue", () => {
  test("returns the raw token for a live key and null for a deleted one", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    await makeLlmProviderApiKey(org.id, (await makeSecret()).id, {
      provider: "anthropic",
    });

    const id = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "anthropic",
    });

    const value = await readVirtualKeyValue(id);
    expect(value).toMatch(
      new RegExp(`^${ARCHESTRA_TOKEN_PREFIX}[0-9a-f]{64}$`),
    );
    expect(
      (await VirtualApiKeyModel.validateToken(value as string))?.virtualKey.id,
    ).toBe(id);

    await VirtualApiKeyModel.delete(id);
    expect(await readVirtualKeyValue(id)).toBeNull();
  });
});
