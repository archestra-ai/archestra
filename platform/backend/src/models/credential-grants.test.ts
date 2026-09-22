// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { enterpriseTier } from "@/enterprise-tier";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { ResourcePermissions } from "@/services/resource-permissions";
import { expect, test } from "@/test";
import LlmProviderApiKeyModel from "./llm-provider-api-key";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import VirtualApiKeyModel from "./virtual-api-key";

test("provider read grants permit discovery but never model invocation; use grants and revocations drive key resolution", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeSecret,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser();
  const reader = await makeUser();
  const outsider = await makeUser();
  for (const user of [owner, reader, outsider])
    await makeMember(user.id, org.id);
  const secret = await makeSecret({
    secret: { apiKey: "synthetic-provider-token" },
  });
  const key = await LlmProviderApiKeyModel.create(
    {
      organizationId: org.id,
      userId: owner.id,
      scope: "personal",
      name: "Shared provider",
      provider: "anthropic",
      secretId: secret.id,
    },
    {
      initialPermissionGrants: [
        { subject: { type: "user", id: reader.id }, actions: ["read"] },
      ],
    },
  );
  const current = () =>
    LlmProviderApiKeyModel.getCurrentApiKey({
      organizationId: org.id,
      userId: reader.id,
      userTeamIds: [],
      provider: "anthropic",
      conversationId: null,
    });
  expect(
    (
      await LlmProviderApiKeyModel.getVisibleKeys(org.id, reader.id, [], false)
    ).map((item) => item.id),
  ).toContain(key.id);
  expect(await LlmProviderApiKeyModel.canUseKey(key, reader.id, [])).toBe(
    false,
  );
  expect(
    await LlmProviderApiKeyModel.getAvailableKeysForUser(org.id, reader.id, []),
  ).toEqual([]);
  expect(await current()).toBeNull();
  const policy = {
    organizationId: org.id,
    resource: "llmProviderApiKey" as const,
    scope: key.id,
  };
  await ResourcePermissionPolicyModel.replace({
    ...policy,
    revision: 1,
    grants: [
      { subject: { type: "user", id: reader.id }, actions: ["read", "use"] },
    ],
  });
  expect(await LlmProviderApiKeyModel.canUseKey(key, reader.id, [])).toBe(true);
  expect(
    (
      await LlmProviderApiKeyModel.getAvailableKeysForUser(
        org.id,
        reader.id,
        [],
      )
    ).map((item) => item.id),
  ).toContain(key.id);
  expect((await current())?.id).toBe(key.id);
  expect(
    await LlmProviderApiKeyModel.getVisibleKeys(org.id, outsider.id, [], false),
  ).toEqual([]);
  await ResourcePermissionPolicyModel.replace({
    ...policy,
    revision: 2,
    grants: [],
  });
  expect(
    await LlmProviderApiKeyModel.getVisibleKeys(org.id, reader.id, [], false),
  ).toEqual([]);
  expect(await current()).toBeNull();
  expect(await LlmProviderApiKeyModel.canUseKey(key, owner.id, [])).toBe(false);
});

test("provider grants never bypass organization membership, even for a named recipient or legacy organization visibility", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeSecret,
}) => {
  const org = await makeOrganization();
  const foreignOrg = await makeOrganization();
  const owner = await makeUser();
  const foreignUser = await makeUser();
  await makeMember(owner.id, org.id);
  await makeMember(foreignUser.id, foreignOrg.id);
  const secret = await makeSecret({
    secret: { apiKey: "synthetic-provider-token" },
  });
  const key = await LlmProviderApiKeyModel.create(
    {
      organizationId: org.id,
      userId: owner.id,
      scope: "org",
      name: "Restricted organization key",
      provider: "anthropic",
      secretId: secret.id,
    },
    {
      initialPermissionGrants: [
        {
          subject: { type: "user", id: foreignUser.id },
          actions: ["read", "use"],
        },
      ],
    },
  );
  expect(
    await LlmProviderApiKeyModel.getVisibleKeys(
      org.id,
      foreignUser.id,
      [],
      true,
    ),
  ).toEqual([]);
  expect(
    await LlmProviderApiKeyModel.getAvailableKeysForUser(
      org.id,
      foreignUser.id,
      [],
    ),
  ).toEqual([]);
  expect(await LlmProviderApiKeyModel.canUseKey(key, foreignUser.id, [])).toBe(
    false,
  );
  expect(
    await LlmProviderApiKeyModel.getVisibleKeys(
      foreignOrg.id,
      owner.id,
      [],
      true,
    ),
  ).toEqual([]);
});

test("virtual key discovery uses explicit recipients and revocation instead of personal or organization visibility", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeSecret,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser();
  const reader = await makeUser();
  const outsider = await makeUser();
  const nonmember = await makeUser();
  for (const user of [owner, reader, outsider])
    await makeMember(user.id, org.id);
  const secret = await makeSecret({
    secret: { apiKey: "synthetic-provider-token" },
  });
  const provider = await LlmProviderApiKeyModel.create(
    {
      organizationId: org.id,
      userId: owner.id,
      scope: "personal",
      name: "Provider",
      provider: "anthropic",
      secretId: secret.id,
    },
    { initialPermissionGrants: [] },
  );
  for (const scope of ["personal", "org"] as const) {
    const { virtualKey } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: `Explicit ${scope} key`,
      scope,
      authorId: owner.id,
      providerApiKeys: [
        { provider: "anthropic", providerApiKeyId: provider.id },
      ],
      initialPermissionGrants: [reader, nonmember].map((user) => ({
        subject: { type: "user", id: user.id },
        actions: ["read"],
      })),
    });
    const find = (userId: string) =>
      VirtualApiKeyModel.findVisibleById({
        id: virtualKey.id,
        organizationId: org.id,
        userId,
        getUserTeamIds: async () => [],
        getIsAdmin: async () => false,
      });
    const list = (userId: string) =>
      VirtualApiKeyModel.findAllByOrganization({
        organizationId: org.id,
        userId,
        isAdmin: false,
        pagination: { limit: 10, offset: 0 },
      });
    expect((await find(reader.id))?.id).toBe(virtualKey.id);
    expect((await list(reader.id)).data.map((item) => item.id)).toContain(
      virtualKey.id,
    );
    expect(await find(outsider.id)).toBeNull();
    expect(await find(nonmember.id)).toBeNull();
    await ResourcePermissionPolicyModel.replace({
      organizationId: org.id,
      resource: "llmVirtualKey",
      scope: virtualKey.id,
      revision: 1,
      grants: [],
    });
    expect(await find(reader.id)).toBeNull();
    expect((await list(reader.id)).data).toEqual([]);
    expect(await find(owner.id)).toBeNull();
  }
});

for (const provider of ["github-copilot", "openai"] as const) {
  test(`${provider} personal credentials stay isolated under wildcard grants and honor owner revocation`, async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
  }) => {
    enterpriseTier.setUserCountForTesting(0);
    const org = await makeOrganization();
    const owner = await makeUser();
    const other = await makeUser();
    for (const user of [owner, other]) await makeMember(user.id, org.id);
    const secret = await makeSecret({
      secret: {
        apiKey:
          provider === "openai"
            ? encodeOpenAiCodexCredential({
                refreshToken: "synthetic-refresh",
                accountId: "synthetic-account",
              })
            : "synthetic-copilot-token",
      },
    });
    const key = await LlmProviderApiKeyModel.create(
      {
        organizationId: org.id,
        userId: owner.id,
        scope: "personal",
        name: "Personal subscription",
        provider,
        secretId: secret.id,
      },
      { initialPermissionGrants: [] },
    );
    const policy = {
      organizationId: org.id,
      resource: "llmProviderApiKey" as const,
      scope: key.id,
    };
    await ResourcePermissionPolicyModel.replace({
      ...policy,
      scope: "*",
      revision: 1,
      grants: [
        {
          subject: { type: "organization", id: "*" },
          actions: ["read", "use"],
        },
      ],
    });
    const current = (userId: string) =>
      LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: org.id,
        userId,
        userTeamIds: [],
        provider,
        conversationId: null,
      });
    expect(
      await LlmProviderApiKeyModel.getAvailableKeysForUser(
        org.id,
        other.id,
        [],
        provider,
      ),
    ).toEqual([]);
    expect(await LlmProviderApiKeyModel.canUseKey(key, other.id, [])).toBe(
      false,
    );
    expect(await current(other.id)).toBeNull();
    expect((await current(owner.id))?.id).toBe(key.id);
    await expect(
      ResourcePermissions.updatePolicy({
        ...policy,
        userId: owner.id,
        revision: 1,
        grants: [
          {
            subject: { type: "organization", id: "*" },
            actions: ["read", "use"],
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await ResourcePermissionPolicyModel.replace({
      ...policy,
      scope: "*",
      revision: 2,
      grants: [],
    });
    await ResourcePermissionPolicyModel.replace({
      ...policy,
      revision: 1,
      grants: [],
    });
    expect(await current(owner.id)).toBeNull();
    if (provider === "openai")
      expect(
        await LlmProviderApiKeyModel.findPersonalSubscriptionKey({
          organizationId: org.id,
          userId: owner.id,
          kind: "chatgpt",
        }),
      ).toBeNull();
  });
}
