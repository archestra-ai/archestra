import { randomUUID } from "node:crypto";
import { ARCHESTRA_TOKEN_PREFIX } from "@archestra/shared";
import { beforeEach, vi } from "vitest";
import { LlmProviderApiKeyModel, VirtualApiKeyModel } from "@/models";
import type { AnthropicCreditVerdict } from "@/routes/chat/model-fetchers/anthropic-credit-probe";
import { probeAnthropicCredit } from "@/routes/chat/model-fetchers/anthropic-credit-probe";
import {
  ensureConnectionPassthroughKey,
  ensureConnectionVirtualKey,
  readVirtualKeyValue,
} from "@/services/connection-setup";
import { encodeGithubAppReference } from "@/services/github-app-copilot-token";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";

// The credit probe makes a real network call; stub it so tests are deterministic
// and offline. Default: every key is usable (so existing binding behavior is
// unchanged); individual tests override per key value.
vi.mock("@/routes/chat/model-fetchers/anthropic-credit-probe", () => ({
  probeAnthropicCredit: vi.fn(),
}));

const probeMock = vi.mocked(probeAnthropicCredit);

beforeEach(() => {
  probeMock.mockReset();
  probeMock.mockResolvedValue("usable");
});

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

    const { virtualApiKeyId: firstId } = await ensureConnectionVirtualKey({
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

    const { virtualApiKeyId: secondId } = await ensureConnectionVirtualKey({
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
      { provider: "github-copilot", userId: user.id },
    );

    const { virtualApiKeyId: id } = await ensureConnectionVirtualKey({
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
        userId: user.id,
      },
    );
    const otherKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "github-copilot", userId: otherUser.id },
    );

    const { virtualApiKeyId: id } = await ensureConnectionVirtualKey({
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

  test("per-user provider: binds the organization plan the user picks, then their own sign-in again", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const ownKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "github-copilot", userId: user.id },
    );
    // An organization plan: a GitHub App key, shared with the organization.
    const planValue = encodeGithubAppReference({
      ref: { organizationId: org.id, credentialId: randomUUID() },
      installationId: "2",
      organization: "acme",
      githubUrl: "https://github.com",
    });
    const planKey = await LlmProviderApiKeyModel.create(
      {
        organizationId: org.id,
        name: "GitHub Copilot (acme)",
        provider: "github-copilot",
        secretId: (await makeSecret({ secret: { apiKey: planValue } })).id,
        scope: "org",
        userId: null,
      },
      {
        apiKeyValue: planValue,
        // As connecting the GitHub App grants it: everyone may use the plan.
        initialPermissionGrants: [
          {
            subject: { type: "organization", id: "*" },
            actions: ["read", "use"],
          },
        ],
      },
    );
    const connect = (selectedProviderKeyId?: string) =>
      ensureConnectionVirtualKey({
        organizationId: org.id,
        userId: user.id,
        userEmail: user.email,
        userTeamIds: [],
        provider: "github-copilot",
        clientId: "copilot-cli",
        selectedProviderKeyId,
      });

    const { virtualApiKeyId: id } = await connect(planKey.id);
    expect(await VirtualApiKeyModel.getProviderApiKeys(id)).toEqual([
      expect.objectContaining({
        provider: "github-copilot",
        providerApiKeyId: planKey.id,
      }),
    ]);

    // The same client's key moves back to the user's own sign-in.
    const again = await connect();
    expect(again.virtualApiKeyId).toBe(id);
    expect(await VirtualApiKeyModel.getProviderApiKeys(id)).toEqual([
      expect.objectContaining({
        provider: "github-copilot",
        providerApiKeyId: ownKey.id,
      }),
    ]);
  });

  test("per-user provider: binds the picked organization plan when the key includes future providers", async ({
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
      provider: "github-copilot",
      userId: user.id,
    });
    const planValue = encodeGithubAppReference({
      ref: { organizationId: org.id, credentialId: randomUUID() },
      installationId: "2",
      organization: "acme",
      githubUrl: "https://github.com",
    });
    const planKey = await LlmProviderApiKeyModel.create(
      {
        organizationId: org.id,
        name: "GitHub Copilot (acme)",
        provider: "github-copilot",
        secretId: (await makeSecret({ secret: { apiKey: planValue } })).id,
        scope: "org",
        userId: null,
      },
      {
        apiKeyValue: planValue,
        initialPermissionGrants: [
          {
            subject: { type: "organization", id: "*" },
            actions: ["read", "use"],
          },
        ],
      },
    );
    const connect = () =>
      ensureConnectionVirtualKey({
        organizationId: org.id,
        userId: user.id,
        userEmail: user.email,
        userTeamIds: [],
        provider: "github-copilot",
        clientId: "copilot-cli",
        selectedProviderKeyId: planKey.id,
        includeFutureProviders: true,
      });

    // Issued with future providers, and again over the existing key.
    for (const attempt of [1, 2]) {
      const { virtualApiKeyId } = await connect();
      expect(
        (await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId)).filter(
          (key) => key.provider === "github-copilot",
        ),
        `attempt ${attempt}`,
      ).toEqual([
        expect.objectContaining({
          provider: "github-copilot",
          providerApiKeyId: planKey.id,
        }),
      ]);
    }
  });

  test("per-user provider: refuses a picked key that is not the user's to use", async ({
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
    await makeMember(otherUser.id, org.id);
    await makeLlmProviderApiKey(org.id, (await makeSecret()).id, {
      provider: "github-copilot",
      userId: user.id,
    });
    const othersSignIn = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "github-copilot", userId: otherUser.id },
    );
    const openAiKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "openai" },
    );
    const connect = (selectedProviderKeyId: string) =>
      ensureConnectionVirtualKey({
        organizationId: org.id,
        userId: user.id,
        userEmail: user.email,
        userTeamIds: [],
        provider: "github-copilot",
        selectedProviderKeyId,
      });

    // Another member's sign-in, a key of another provider, and a key that
    // does not exist are refused, never replaced by the user's own.
    for (const id of [othersSignIn.id, openAiKey.id, randomUUID()]) {
      await expect(connect(id)).rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringMatching(/not available to you/),
      });
    }
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

    const { virtualApiKeyId: id } = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "anthropic",
    });
    const { virtualApiKeyId: sameId } = await ensureConnectionVirtualKey({
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
      { provider: "anthropic" },
    );

    const { virtualApiKeyId: id } = await ensureConnectionVirtualKey({
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
      { provider: "anthropic", userId: user.id },
    );

    const { virtualApiKeyId: sameId } = await ensureConnectionVirtualKey({
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

    const { virtualApiKeyId: firstId } = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "anthropic",
    });
    await VirtualApiKeyModel.delete(firstId);

    const { virtualApiKeyId: secondId } = await ensureConnectionVirtualKey({
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

describe("ensureConnectionVirtualKey — Anthropic credit failover", () => {
  // Drive verdicts by the decrypted key value (the probe's first argument).
  function verdictByApiKey(map: Record<string, AnthropicCreditVerdict>) {
    probeMock.mockImplementation(
      async (apiKey: string) => map[apiKey] ?? "usable",
    );
  }

  test("binds a secondary key with balance when the resolved key is exhausted", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    // Personal key outranks the org key in resolution, but it's out of credit.
    const personalKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "exhausted-key" } })).id,
      { provider: "anthropic", userId: user.id },
    );
    const orgKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "funded-key" } })).id,
      { provider: "anthropic" },
    );
    verdictByApiKey({ "exhausted-key": "exhausted", "funded-key": "usable" });

    const { virtualApiKeyId, creditWarning } = await ensureConnectionVirtualKey(
      {
        organizationId: org.id,
        userId: user.id,
        userEmail: user.email,
        userTeamIds: [],
        provider: "anthropic",
      },
    );

    expect(creditWarning).toBeUndefined();
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId),
    ).toEqual([expect.objectContaining({ providerApiKeyId: orgKey.id })]);
    // The exhausted resolved key was not bound.
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId),
    ).not.toContainEqual(
      expect.objectContaining({ providerApiKeyId: personalKey.id }),
    );
  });

  test("falls through to a usable key when the resolved key is unverifiable", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "inconclusive-key" } })).id,
      { provider: "anthropic", userId: user.id },
    );
    const orgKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "funded-key" } })).id,
      { provider: "anthropic" },
    );
    verdictByApiKey({
      "inconclusive-key": "inconclusive",
      "funded-key": "usable",
    });

    const { virtualApiKeyId, creditWarning } = await ensureConnectionVirtualKey(
      {
        organizationId: org.id,
        userId: user.id,
        userEmail: user.email,
        userTeamIds: [],
        provider: "anthropic",
      },
    );

    expect(creditWarning).toBeUndefined();
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId),
    ).toEqual([expect.objectContaining({ providerApiKeyId: orgKey.id })]);
  });

  test("warns 'insufficient_balance' and still provisions when every key is exhausted", async ({
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
      (await makeSecret({ secret: { apiKey: "exhausted-key" } })).id,
      { provider: "anthropic", name: "Org Anthropic" },
    );
    verdictByApiKey({ "exhausted-key": "exhausted" });

    const { virtualApiKeyId, creditWarning } = await ensureConnectionVirtualKey(
      {
        organizationId: org.id,
        userId: user.id,
        userEmail: user.email,
        userTeamIds: [],
        provider: "anthropic",
      },
    );

    // The warning names the exhausted key so the user knows which one to fix.
    expect(creditWarning).toEqual({
      kind: "insufficient_balance",
      keyName: "Org Anthropic",
    });
    // Setup is never blocked — the resolved key is still bound.
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId),
    ).toEqual([expect.objectContaining({ providerApiKeyId: orgKey.id })]);
  });

  test("warns 'unverified' when every probe is inconclusive", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "inconclusive-key" } })).id,
      { provider: "anthropic", name: "Org Anthropic" },
    );
    verdictByApiKey({ "inconclusive-key": "inconclusive" });

    const { creditWarning } = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "anthropic",
    });

    expect(creditWarning).toEqual({
      kind: "unverified",
      keyName: "Org Anthropic",
    });
  });

  test("prefers 'insufficient_balance' over 'unverified' when both occur", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "exhausted-key" } })).id,
      {
        provider: "anthropic",
        userId: user.id,
        name: "Personal Anthropic",
      },
    );
    await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "inconclusive-key" } })).id,
      { provider: "anthropic", name: "Org Anthropic" },
    );
    verdictByApiKey({
      "exhausted-key": "exhausted",
      "inconclusive-key": "inconclusive",
    });

    const { creditWarning } = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "anthropic",
    });

    // Names the definitively exhausted key, not the merely unverifiable one.
    expect(creditWarning).toEqual({
      kind: "insufficient_balance",
      keyName: "Personal Anthropic",
    });
  });

  test("does not credit-probe non-Anthropic providers", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "openai-key" } })).id,
      { provider: "openai" },
    );

    const { creditWarning } = await ensureConnectionVirtualKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      userTeamIds: [],
      provider: "openai",
    });

    expect(creditWarning).toBeUndefined();
    expect(probeMock).not.toHaveBeenCalled();
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

    const { virtualApiKeyId: id } = await ensureConnectionVirtualKey({
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

describe("ensureConnectionPassthroughKey", () => {
  test("creates a single personal passthrough key per user and reuses it", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    const firstId = await ensureConnectionPassthroughKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
    });

    const created = await VirtualApiKeyModel.findById(firstId);
    expect(created?.keyType).toBe("passthrough");
    expect(created?.scope).toBe("personal");
    expect(created?.authorId).toBe(user.id);
    expect(created?.name).toBe(`Connection passthrough — ${user.email}`);
    // No provider credential — passthrough keys only attribute the user.
    expect(await VirtualApiKeyModel.getProviderApiKeys(firstId)).toEqual([]);
    expect(
      (await readVirtualKeyValue(firstId))?.startsWith(ARCHESTRA_TOKEN_PREFIX),
    ).toBe(true);

    // Re-running returns the same per-user key.
    const secondId = await ensureConnectionPassthroughKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
    });
    expect(secondId).toBe(firstId);
  });

  test("recreates the key when the prior one was deleted", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    const firstId = await ensureConnectionPassthroughKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
    });
    await VirtualApiKeyModel.delete(firstId);

    const secondId = await ensureConnectionPassthroughKey({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
    });
    expect(secondId).not.toBe(firstId);
    expect((await VirtualApiKeyModel.findById(secondId))?.keyType).toBe(
      "passthrough",
    );
  });
});
