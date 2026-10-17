import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { secretManager } from "@/secrets-manager";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { describe, expect, test } from "@/test";
import LlmProviderApiKeyModel from "./llm-provider-api-key";
import SecretModel from "./secret";

const subscriptionValue = () =>
  encodeOpenAiCodexCredential({
    refreshToken: "synthetic-refresh",
    accountId: "synthetic-account",
  });

describe("LLM provider key credential kind", () => {
  async function sharedKey(params: {
    organizationId: string;
    apiKeyValue: string;
    /** Omitted: a row written before the kind was recorded. */
    recordKind?: boolean;
  }) {
    const secret = await SecretModel.create({
      name: "test-key",
      secret: { apiKey: params.apiKeyValue },
    });
    return LlmProviderApiKeyModel.create(
      {
        organizationId: params.organizationId,
        name: "Shared OpenAI",
        provider: "openai",
        secretId: secret.id,
        scope: "org",
        userId: null,
        teamId: null,
      },
      {
        publishToOrganization: true,
        ...(params.recordKind === false
          ? {}
          : { apiKeyValue: params.apiKeyValue }),
      },
    );
  }

  async function storedKind(id: string) {
    const [row] = await db
      .select({ kind: schema.llmProviderApiKeysTable.credentialKind })
      .from(schema.llmProviderApiKeysTable)
      .where(eq(schema.llmProviderApiKeysTable.id, id));
    return row?.kind;
  }

  test("listing decides from the recorded kind without reading the secret", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const apiKey = await sharedKey({
      organizationId: org.id,
      apiKeyValue: "sk-shared-metered",
    });
    const subscription = await sharedKey({
      organizationId: org.id,
      apiKeyValue: subscriptionValue(),
    });
    expect(await storedKind(apiKey.id)).toBe("api_key");
    expect(await storedKind(subscription.id)).toBe("chatgpt");
    const getSecret = vi.spyOn(secretManager(), "getSecret");

    const visible = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      org.id,
      member.id,
      [],
    );

    // A subscription is somebody's account, so a shared reader never gets it.
    expect(visible.map((key) => key.id)).toEqual([apiKey.id]);
    expect(getSecret).not.toHaveBeenCalled();

    // The recorded kind is what decides: a row whose value says otherwise is
    // still listed by its record, which shows the value was not consulted.
    await db
      .update(schema.secretsTable)
      .set({ secret: { apiKey: "sk-now-a-plain-key" } })
      .where(eq(schema.secretsTable.id, subscription.secretId as string));
    const again = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      org.id,
      member.id,
      [],
    );
    expect(again.map((key) => key.id)).toEqual([apiKey.id]);
  });

  test("a row from before the kind was recorded is classified once and stored", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const legacy = await sharedKey({
      organizationId: org.id,
      apiKeyValue: subscriptionValue(),
      recordKind: false,
    });
    expect(await storedKind(legacy.id)).toBeNull();

    const visible = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      org.id,
      member.id,
      [],
    );

    expect(visible).toEqual([]);
    expect(await storedKind(legacy.id)).toBe("chatgpt");
  });

  test("recording a new value updates the kind", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const key = await sharedKey({
      organizationId: org.id,
      apiKeyValue: "sk-metered",
    });

    await LlmProviderApiKeyModel.recordCredentialKind({
      id: key.id,
      apiKeyValue: subscriptionValue(),
    });

    expect(await storedKind(key.id)).toBe("chatgpt");
  });
});
