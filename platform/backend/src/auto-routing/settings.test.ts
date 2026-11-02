import { randomUUID } from "node:crypto";
import config from "@/config";
import AgentModel from "@/models/agent";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import ModelModel from "@/models/model";
import OrganizationModel from "@/models/organization";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting, setOrganizationTrio } from "@/test/auto-routing";
import { ApiError } from "@/types";
import {
  getAutoRoutingSettings,
  updateAutoRoutingSettings,
  writeOrganizationTrio,
} from "./settings";

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
    await setOrganizationTrio(organizationId, { fast, normal, smart });

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

  test("counts the agents on the organization default, which routing applies to", async ({
    makeOrganization,
    makeAgent,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const [, normal] = await configureAutoRouting(organizationId);
    const secret = await makeSecret({ secret: { apiKey: "sk-test" } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id);
    const agent = (overrides: Parameters<typeof makeAgent>[0] = {}) =>
      makeAgent({ organizationId, agentType: "agent", ...overrides });
    const count = async () =>
      (await getAutoRoutingSettings(organizationId)).routedAgentCount;
    const before = await count();
    await agent();
    await agent();
    await agent({ llmApiKeyId: key.id, modelId: normal.id });
    await AgentModel.delete((await agent()).id);
    await makeAgent({ organizationId, agentType: "mcp_gateway" });

    expect(await count()).toBe(before + 2);
  });
});

describe("writeOrganizationTrio", () => {
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  const patchTrio = (
    organizationId: string,
    patch: { fastModelId: string | null },
  ) =>
    writeOrganizationTrio({
      organizationId,
      patch,
      write: (tx) =>
        OrganizationModel.patchInTransaction({
          id: organizationId,
          data: { defaultFastModelId: patch.fastModelId },
          tx,
        }),
    });

  test("auto routing reads a changed tier from the organization and re-plans", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const [fast] = await configureAutoRouting(organizationId);
    const before = await AutoRoutingSettingsModel.find(organizationId);
    const cheaper = await ModelModel.create({
      externalId: `openai/cheaper-${randomUUID()}`,
      provider: "openai",
      modelId: `cheaper-${randomUUID()}`,
      inputModalities: ["text"],
      outputModalities: ["text"],
      customPricePerMillionInput: fast.customPricePerMillionInput,
      customPricePerMillionOutput: fast.customPricePerMillionOutput,
    });

    await patchTrio(organizationId, { fastModelId: cheaper.id });

    const after = await AutoRoutingSettingsModel.find(organizationId);
    expect(after?.fastModelId).toBe(cheaper.id);
    expect(after?.generation).toBe((before?.generation ?? 0) + 1);
  });

  test("clearing a tier while auto routing is enabled is refused", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const [fast] = await configureAutoRouting(organizationId);

    const error = await patchTrio(organizationId, { fastModelId: null }).catch(
      (reason) => reason,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 400 });
    expect(
      (await OrganizationModel.getById(organizationId))?.defaultFastModelId,
    ).toBe(fast.id);
  });

  test("a disabled organization may change its trio freely", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await configureAutoRouting(organizationId);
    await AutoRoutingSettingsModel.update(organizationId, { enabled: false });

    await patchTrio(organizationId, { fastModelId: null });

    expect(
      (await AutoRoutingSettingsModel.find(organizationId))?.fastModelId,
    ).toBeNull();
  });

  test("with auto routing off for the deployment, an enabled organization may change its trio freely", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await configureAutoRouting(organizationId);
    config.autoRouting.enabled = false;

    await patchTrio(organizationId, { fastModelId: null });

    expect(await AutoRoutingSettingsModel.find(organizationId)).toMatchObject({
      enabled: true,
      fastModelId: null,
    });
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
