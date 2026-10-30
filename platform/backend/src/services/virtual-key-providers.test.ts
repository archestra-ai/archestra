import { withDbTransaction } from "@/database";
import ConnectedClientModel from "@/models/connected-client";
import ConnectionSetupModel from "@/models/connection-setup";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { describe, expect, test } from "@/test";
import { encodeOpenAiCodexCredential } from "./openai-codex-credentials";
import { resolveVirtualKeyProviderMappings } from "./virtual-key-providers";

describe("automatic virtual key providers", () => {
  test.for([
    false,
    true,
  ])("managed owner expansion preserves explicit mappings and requires a live owned installation (automatic=%s)", async (includeFutureProviders, {
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const other = await makeUser();
    await makeMember(owner.id, org.id);
    await makeMember(other.id, org.id);
    const proxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
    });
    const secret = await makeSecret();
    const explicit = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      userId: owner.id,
      isPrimary: true,
    });
    const personal = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "github-copilot",
      userId: owner.id,
      isPrimary: true,
    });
    const { virtualKey } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Managed primary overrides",
      scope: "personal",
      authorId: owner.id,
      includeFutureProviders,
      providerApiKeys: [{ provider: "openai", providerApiKeyId: explicit.id }],
    });
    const mappedIds = async () =>
      (await resolveVirtualKeyProviderMappings(virtualKey.id)).map(
        (mapping) => mapping.providerApiKeyId,
      );
    const setupParams = {
      organizationId: org.id,
      userId: owner.id,
      clientId: "opencode" as const,
      baseUrl: "https://deployment.example.com/v1",
      llmProxyId: proxy.id,
      provider: "openai" as const,
      proxyAuth: "primary-providers" as const,
      virtualApiKeyId: virtualKey.id,
      expiresAt: new Date(Date.now() + 60000),
    };
    expect(await mappedIds()).toEqual([explicit.id]);
    const foreignOwner = await ConnectionSetupModel.create({
      ...setupParams,
      userId: other.id,
    });
    await ConnectionSetupModel.claimByToken({
      rawToken: foreignOwner.rawToken,
    });
    expect(await mappedIds()).toEqual([explicit.id]);
    const singleProvider = await ConnectionSetupModel.create({
      ...setupParams,
      proxyAuth: "virtual-key",
    });
    await ConnectionSetupModel.claimByToken({
      rawToken: singleProvider.rawToken,
    });
    expect(await mappedIds()).toEqual([explicit.id]);
    const unsupported = await ConnectionSetupModel.create({
      ...setupParams,
      clientId: "claude-code",
    });
    await ConnectionSetupModel.claimByToken({ rawToken: unsupported.rawToken });
    expect(await mappedIds()).toEqual([explicit.id]);
    const pending = await ConnectionSetupModel.create(setupParams);
    expect(await mappedIds()).toEqual([explicit.id]);
    await ConnectionSetupModel.claimByToken({ rawToken: pending.rawToken });
    expect(await mappedIds()).toEqual([explicit.id, personal.id]);
    expect(await VirtualApiKeyModel.getProviderApiKeys(virtualKey.id)).toEqual([
      expect.objectContaining({ providerApiKeyId: explicit.id }),
    ]);
    const policyKey = {
      organizationId: org.id,
      resource: "llmVirtualKey" as const,
      scope: virtualKey.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(policyKey);
    const sharedPolicy = await ResourcePermissionPolicyModel.replace({
      ...policyKey,
      revision: policy?.revision ?? 0,
      grants: [
        ...(policy?.grants ?? []),
        { subject: { type: "user", id: other.id }, actions: ["use"] },
      ],
    });
    expect((await VirtualApiKeyModel.findById(virtualKey.id))?.scope).toBe(
      "personal",
    );
    expect(await VirtualApiKeyModel.isPersonal(virtualKey)).toBe(false);
    expect(await mappedIds()).toEqual([explicit.id]);
    await ResourcePermissionPolicyModel.replace({
      ...policyKey,
      revision: sharedPolicy?.revision ?? 0,
      grants: policy?.grants ?? [],
    });
    expect(await mappedIds()).toEqual([explicit.id, personal.id]);
    const unrelated = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Unrelated automatic key",
      scope: "personal",
      authorId: owner.id,
      includeFutureProviders: true,
    });
    expect(
      (await resolveVirtualKeyProviderMappings(unrelated.virtualKey.id)).map(
        (mapping) => mapping.providerApiKeyId,
      ),
    ).toEqual([explicit.id]);
    await withDbTransaction((tx) =>
      ConnectedClientModel.revokeForUser({
        organizationId: org.id,
        userId: owner.id,
        clientId: "opencode",
        revokedByUserId: owner.id,
        tx,
      }),
    );
    expect(await mappedIds()).toEqual([explicit.id]);
    const renewed = await ConnectionSetupModel.create(setupParams);
    await ConnectionSetupModel.claimByToken({ rawToken: renewed.rawToken });
    expect(await mappedIds()).toEqual([explicit.id, personal.id]);
    await MemberModel.deleteByMemberOrUserId(owner.id, org.id);
    expect(await mappedIds()).toEqual([explicit.id]);
  });

  test("adds new shared primaries to the same token, follows primary changes, and preserves overrides", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const secret = await makeSecret();
    const primary = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      isPrimary: true,
    });
    const override = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      isPrimary: false,
    });
    const { virtualKey, value } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Automatic",
      authorId: owner.id,
      includeFutureProviders: true,
      providerApiKeys: [{ provider: "openai", providerApiKeyId: override.id }],
    });
    expect(await resolveVirtualKeyProviderMappings(virtualKey.id)).toEqual([
      expect.objectContaining({ providerApiKeyId: override.id }),
    ]);
    const later = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "gemini",
      isPrimary: true,
    });
    expect(
      (await resolveVirtualKeyProviderMappings(virtualKey.id)).map(
        (key) => key.providerApiKeyId,
      ),
    ).toEqual([override.id, later.id]);
    await LlmProviderApiKeyModel.update(later.id, { isPrimary: false });
    const replacement = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "gemini",
      isPrimary: true,
    });
    expect(
      (await resolveVirtualKeyProviderMappings(virtualKey.id)).map(
        (key) => key.providerApiKeyId,
      ),
    ).toEqual([override.id, replacement.id]);
    expect((await VirtualApiKeyModel.validateToken(value))?.virtualKey.id).toBe(
      virtualKey.id,
    );
    expect(
      (await resolveVirtualKeyProviderMappings(virtualKey.id)).some(
        (key) => key.providerApiKeyId === primary.id,
      ),
    ).toBe(false);
  });

  test("excludes other organizations, personal keys, subscription credentials, nonprimaries and unusable endpoints", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const owner = await makeUser();
    const secret = await makeSecret();
    const subscription = await makeSecret({
      secret: {
        apiKey: encodeOpenAiCodexCredential({
          refreshToken: "test-refresh",
          accountId: "test-account",
        }),
      },
    });
    const shared = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      isPrimary: true,
    });
    await makeLlmProviderApiKey(otherOrg.id, secret.id, {
      provider: "gemini",
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "gemini",
      userId: owner.id,
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, subscription.id, {
      provider: "openai",
      userId: null,
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "groq",
      isPrimary: false,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "vllm",
      isPrimary: true,
    });
    const { virtualKey } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Automatic",
      authorId: owner.id,
      includeFutureProviders: true,
      providerApiKeys: [],
    });
    expect(await resolveVirtualKeyProviderMappings(virtualKey.id)).toEqual([
      expect.objectContaining({ providerApiKeyId: shared.id }),
    ]);
    const fixed = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Selected",
      authorId: owner.id,
      providerApiKeys: [],
    });
    expect(
      await resolveVirtualKeyProviderMappings(fixed.virtualKey.id),
    ).toEqual([]);
  });
});
