// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { __test } from "./routes";

describe("choosing a provider key for a chat", () => {
  test("needs a use grant on the key, whatever its retired scope says", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const secret = await makeSecret({
      secret: { apiKey: "synthetic-provider-token" },
    });
    // Organization-wide by the retired field, shared with nobody by grant.
    const key = await LlmProviderApiKeyModel.create(
      {
        organizationId: org.id,
        userId: null,
        scope: "org",
        name: "Org key",
        provider: "anthropic",
        secretId: secret.id,
      },
      { initialPermissionGrants: [] },
    );
    const check = () =>
      __test.validateChatApiKeyAccess(key.id, user.id, org.id);

    await expect(check()).rejects.toMatchObject({ statusCode: 403 });

    const scope = {
      organizationId: org.id,
      resource: "llmProviderApiKey" as const,
      scope: key.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(scope);
    await ResourcePermissionPolicyModel.replace({
      ...scope,
      revision: policy?.revision ?? 0,
      grants: [
        { subject: { type: "user", id: user.id }, actions: ["read", "use"] },
      ],
    });
    await expect(check()).resolves.toBeUndefined();
  });
});
