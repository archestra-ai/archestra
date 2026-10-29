import { randomUUID } from "node:crypto";
import config from "@/config";
import db, { schema } from "@/database";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import ModelModel from "@/models/model";
import OrganizationModel from "@/models/organization";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting, makeRoutingModel } from "@/test/auto-routing";
import type { InsertAgent, Model } from "@/types";
import { applyPendingNormalTiers } from "./pending-normal-tier";

const CODEX_RUNTIME: NonNullable<InsertAgent["runtime"]> = {
  image: "example.com/coding-agent:latest",
  command: ["archestra-codex"],
  inferenceProtocol: "openai_responses",
  backend: "kubernetes",
  steerMode: "pipe",
  privileged: false,
  resources: null,
  environment: null,
  credentials: null,
  ttlHours: null,
  maxCostUsd: null,
  idleTimeoutMinutes: null,
};

describe("applyPendingNormalTiers", () => {
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  test("a tier the inheriting runtime agents can run becomes the default and auto routing comes back", async ({
    makeOrganization,
    makeAgent,
    makeLlmProviderApiKey,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await configureAutoRouting(organizationId);
    await AutoRoutingSettingsModel.update(organizationId, { enabled: false });
    await makeAgent({
      organizationId,
      agentType: "agent",
      runtime: CODEX_RUNTIME,
    });
    const tier = await makeRoutingModel();
    const key = await makeLlmProviderApiKey(organizationId, null, {
      provider: "openai",
    });
    await stash({ organizationId, tier, apiKeyId: key.id });

    await applyPendingNormalTiers();

    expect(await OrganizationModel.getById(organizationId)).toMatchObject({
      defaultModelId: tier.id,
      defaultLlmApiKeyId: key.id,
    });
    expect(await AutoRoutingSettingsModel.find(organizationId)).toMatchObject({
      enabled: true,
      normalModelId: tier.id,
    });
    expect(await pendingTiers()).toEqual([]);
  });

  test("a tier an inheriting runtime agent cannot run is dropped and auto routing stays off", async ({
    makeOrganization,
    makeAgent,
    makeLlmProviderApiKey,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const [, normal] = await configureAutoRouting(organizationId);
    await AutoRoutingSettingsModel.update(organizationId, { enabled: false });
    await makeAgent({
      organizationId,
      agentType: "agent",
      runtime: CODEX_RUNTIME,
    });
    const tier = await ModelModel.create({
      externalId: `gemini/normal-${randomUUID()}`,
      provider: "gemini",
      modelId: `normal-${randomUUID()}`,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    const key = await makeLlmProviderApiKey(organizationId, null, {
      provider: "gemini",
    });
    await stash({ organizationId, tier, apiKeyId: key.id });

    await applyPendingNormalTiers();

    expect(await OrganizationModel.getById(organizationId)).toMatchObject({
      defaultModelId: normal.id,
      defaultLlmApiKeyId: null,
    });
    expect((await AutoRoutingSettingsModel.find(organizationId))?.enabled).toBe(
      false,
    );
    expect(await pendingTiers()).toEqual([]);
  });
});

async function stash(params: {
  organizationId: string;
  tier: Pick<Model, "id">;
  apiKeyId: string;
}) {
  await db.insert(schema.orgTrioPendingNormalTierTable).values({
    organizationId: params.organizationId,
    normalModelId: params.tier.id,
    apiKeyId: params.apiKeyId,
    autoRoutingWasEnabled: true,
  });
}

function pendingTiers() {
  return db.select().from(schema.orgTrioPendingNormalTierTable);
}
