import { describe, expect, test } from "@/test";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";

describe("resolveProviderApiKey", () => {
  test("resolves personal key for user", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-personal-key" } });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: user.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "openai",
    });

    expect(result.apiKey).toBe("sk-personal-key");
    expect(result.source).toBe("personal");
    expect(result.chatApiKeyId).toBeDefined();
    expect(result.baseUrl).toBeNull();
  });

  test("resolves org key when no user provided", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-org-key" } });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      scope: "org",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      provider: "anthropic",
    });

    expect(result.apiKey).toBe("sk-org-key");
    expect(result.source).toBe("org");
    expect(result.chatApiKeyId).toBeDefined();
  });

  test("returns baseUrl when key has custom base URL", async ({
    makeOrganization,
    makeUser,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-custom-base" } });

    const { LlmProviderApiKeyModel } = await import("@/models");
    await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "Custom Base URL Key",
      provider: "openai",
      scope: "personal",
      userId: user.id,
      baseUrl: "https://my-proxy.example.com/v1",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "openai",
    });

    expect(result.apiKey).toBe("sk-custom-base");
    expect(result.baseUrl).toBe("https://my-proxy.example.com/v1");
  });

  test("returns undefined apiKey when no key configured and no env var", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "cerebras",
    });

    expect(result.source).toBe("environment");
    expect(result.baseUrl).toBeNull();
  });

  test("personal key takes priority over org", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const orgSecret = await makeSecret({ secret: { apiKey: "sk-org-wide" } });
    await makeLlmProviderApiKey(org.id, orgSecret.id, {
      provider: "anthropic",
      scope: "org",
    });

    const personalSecret = await makeSecret({
      secret: { apiKey: "sk-personal" },
    });
    await makeLlmProviderApiKey(org.id, personalSecret.id, {
      provider: "anthropic",
      scope: "personal",
      userId: user.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "anthropic",
    });

    expect(result.apiKey).toBe("sk-personal");
    expect(result.source).toBe("personal");
  });

  test("team key takes priority over org when user is in team", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeTeamMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id, { name: "Test Team" });
    await makeTeamMember(team.id, user.id);

    const orgSecret = await makeSecret({ secret: { apiKey: "sk-org-wide" } });
    await makeLlmProviderApiKey(org.id, orgSecret.id, {
      provider: "openai",
      scope: "org",
    });

    const teamSecret = await makeSecret({ secret: { apiKey: "sk-team" } });
    await makeLlmProviderApiKey(org.id, teamSecret.id, {
      provider: "openai",
      scope: "team",
      teamId: team.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "openai",
    });

    expect(result.apiKey).toBe("sk-team");
    expect(result.source).toBe("team");
  });

  test("supports legacy secret formats (anthropicApiKey)", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { anthropicApiKey: "sk-legacy-key" },
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      scope: "org",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      provider: "anthropic",
    });

    expect(result.apiKey).toBe("sk-legacy-key");
  });
});
