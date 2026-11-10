import { randomUUID } from "node:crypto";
import config from "@/config";
import AgentModel from "@/models/agent";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import OrganizationModel from "@/models/organization";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting, setAutoRoutingTiers } from "@/test/auto-routing";
import { ApiError } from "@/types";
import { getAutoRoutingSettings, updateAutoRoutingSettings } from "./settings";
import { sharedLongContextThreshold, tiersFingerprint } from "./tiers";

describe("updateAutoRoutingSettings", () => {
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  test("enabling is refused while the organization trio has different long-context thresholds", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const [fast, normal, smart] = [
      await withThreshold(128_000),
      await withThreshold(200_000),
      await withThreshold(128_000),
    ];
    await setAutoRoutingTiers(organizationId, { fast, normal, smart });

    const error = await updateAutoRoutingSettings(organizationId, {
      enabled: true,
      budgetUsdPerDay: 10,
    }).catch((reason) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 400 });
    expect((await AutoRoutingSettingsModel.find(organizationId))?.enabled).toBe(
      false,
    );
  });
});

describe("getAutoRoutingSettings", () => {
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  test("counts the agents set to auto, apart from the organization default", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await configureAutoRouting(organizationId);
    const agent = (overrides: Parameters<typeof makeAgent>[0] = {}) =>
      makeAgent({ organizationId, agentType: "agent", ...overrides });
    await agent({ autoModel: true });
    await agent({ autoModel: true });
    await agent();
    await AgentModel.delete((await agent({ autoModel: true })).id);
    await OrganizationModel.patch(organizationId, { defaultAutoModel: true });

    const { usage, tiers } = await getAutoRoutingSettings(organizationId);

    expect(usage).toEqual({ agentCount: 2, organizationDefault: true });
    expect(tiers.normal?.apiKey.name).toMatch(/^Auto routing openai/);
  });
});

describe("tier updates", () => {
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  test("tiers are their own: changing the organization's default trio leaves them", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const [fast] = await configureAutoRouting(organizationId);
    const other = await withThreshold(128_000);

    await OrganizationModel.patch(organizationId, {
      defaultFastModelId: other.id,
    });

    expect(
      (await AutoRoutingSettingsModel.find(organizationId))?.fastModelId,
    ).toBe(fast.id);
  });

  test("saving tiers on organization-wide keys serving their models re-plans", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const [fast, normal, smart] = await configureAutoRouting(organizationId);
    const before = await AutoRoutingSettingsModel.find(organizationId);
    const key = await makeLlmProviderApiKey(organizationId, null, {
      provider: "openai",
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      fast.id,
      normal.id,
      smart.id,
    ]);
    const on = (model: { id: string }) => ({
      modelId: model.id,
      providerApiKeyId: key.id,
    });

    const saved = await updateAutoRoutingSettings(organizationId, {
      tiers: { fast: on(normal), normal: on(normal), smart: on(smart) },
    });

    expect(saved.tiers.fast).toMatchObject({
      id: normal.id,
      apiKey: { id: key.id },
    });
    expect(
      (await AutoRoutingSettingsModel.find(organizationId))?.generation,
    ).toBeGreaterThan(before?.generation ?? 0);
  });

  test("a tier on a key not shared with the whole organization is refused", async ({
    makeOrganization,
    makeUser,
    makeLlmProviderApiKey,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const [fast, normal, smart] = await configureAutoRouting(organizationId);
    const user = await makeUser();
    const personal = await makeLlmProviderApiKey(organizationId, null, {
      provider: "openai",
      userId: user.id,
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(personal.id, [
      fast.id,
    ]);
    const current = await getAutoRoutingSettings(organizationId);
    const keep = (tier: "normal" | "smart", model: { id: string }) => ({
      modelId: model.id,
      providerApiKeyId: current.tiers[tier]?.apiKey.id ?? "",
    });

    const error = await updateAutoRoutingSettings(organizationId, {
      tiers: {
        fast: { modelId: fast.id, providerApiKeyId: personal.id },
        normal: keep("normal", normal),
        smart: keep("smart", smart),
      },
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 400 });
  });

  test("a tier on a key that does not serve its model is refused", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const [fast, normal, smart] = await configureAutoRouting(organizationId);
    const unlinked = await makeLlmProviderApiKey(organizationId, null, {
      provider: "openai",
    });
    const on = (model: { id: string }) => ({
      modelId: model.id,
      providerApiKeyId: unlinked.id,
    });

    const error = await updateAutoRoutingSettings(organizationId, {
      tiers: { fast: on(fast), normal: on(normal), smart: on(smart) },
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ statusCode: 400 });
  });
});

function withThreshold(threshold: number) {
  return ModelModel.create({
    externalId: `openai/long-${randomUUID()}`,
    provider: "openai",
    modelId: `long-${randomUUID()}`,
    inputModalities: ["text"],
    outputModalities: ["text"],
    longContextThreshold: threshold,
    longContextPricePerMillionInput: "6",
    longContextPricePerMillionOutput: "22.5",
    longContextPricePerMillionCacheRead: "0.6",
    longContextPricePerMillionCacheWrite: "7.5",
  });
}

test("published thresholds and rates drive routing, while fully overridden prices remove the constraint", async () => {
  const haiku = await ModelModel.create({
    provider: "github-copilot",
    inputModalities: ["text"],
    outputModalities: ["text"],
    modelId: "claude-haiku-5.5",
    externalId: "github-copilot/claude-haiku-5.5",
  });
  const gpt = await ModelModel.create({
    provider: "github-copilot",
    inputModalities: ["text"],
    outputModalities: ["text"],
    modelId: "gpt-6.1-sol",
    externalId: "github-copilot/gpt-6.1-sol",
  });
  expect(sharedLongContextThreshold([haiku, gpt]).kind).toBe("mismatched");
  const fingerprint = tiersFingerprint([haiku, haiku, haiku]);
  expect(fingerprint.long_context_threshold).toBe(100000);
  expect(fingerprint.tiers[0]).toMatchObject({
    short: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
    long: { input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625 },
  });
  const custom = await ModelModel.update(haiku.id, {
    customPricePerMillionInput: "1",
    customPricePerMillionOutput: "2",
    customPricePerMillionCacheRead: "0.1",
    customPricePerMillionCacheWrite: "1.25",
  });
  if (!custom) throw new Error("Missing model");
  expect(ModelModel.getLongContextThreshold(custom)).toBeNull();
  expect(tiersFingerprint([custom, custom, custom]).tiers[0].long).toBeNull();
  const cleared = await ModelModel.update(haiku.id, {
    customPricePerMillionInput: null,
    customPricePerMillionOutput: null,
    customPricePerMillionCacheRead: null,
    customPricePerMillionCacheWrite: null,
  });
  if (!cleared) throw new Error("Missing model");
  expect(tiersFingerprint([cleared, cleared, cleared])).toEqual(fingerprint);
});
