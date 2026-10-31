import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
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

  test("auto routing that fails to come back after the move is re-enabled at the next startup", async ({
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
    // The settings write's first read fails like a dropped connection.
    const settingsRead = vi
      .spyOn(AgentModel, "getOrgLlmProxy")
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));

    try {
      await applyPendingNormalTiers();

      expect(settingsRead).toHaveBeenCalled();
      expect(await OrganizationModel.getById(organizationId)).toMatchObject({
        defaultModelId: tier.id,
        defaultLlmApiKeyId: key.id,
      });
      expect(
        (await AutoRoutingSettingsModel.find(organizationId))?.enabled,
      ).toBe(false);

      await applyPendingNormalTiers();
    } finally {
      settingsRead.mockRestore();
    }

    expect(await AutoRoutingSettingsModel.find(organizationId)).toMatchObject({
      enabled: true,
      normalModelId: tier.id,
    });
    expect(await pendingTiers()).toEqual([]);
  });

  test("a moved tier whose auto routing an admin changed meanwhile is dropped without re-enabling", async ({
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
    const settingsRead = vi
      .spyOn(AgentModel, "getOrgLlmProxy")
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    try {
      await applyPendingNormalTiers();
    } finally {
      settingsRead.mockRestore();
    }
    const chosen = await makeRoutingModel();
    await OrganizationModel.patch(organizationId, {
      defaultModelId: chosen.id,
      defaultLlmApiKeyId: key.id,
    });

    await applyPendingNormalTiers();

    expect((await AutoRoutingSettingsModel.find(organizationId))?.enabled).toBe(
      false,
    );
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

  test("a default model an admin changed since the migration is kept and the tier dropped", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await configureAutoRouting(organizationId);
    await AutoRoutingSettingsModel.update(organizationId, { enabled: false });
    const tier = await makeRoutingModel();
    const key = await makeLlmProviderApiKey(organizationId, null, {
      provider: "openai",
    });
    await stash({ organizationId, tier, apiKeyId: key.id });
    const chosen = await makeRoutingModel();
    await OrganizationModel.patch(organizationId, {
      defaultModelId: chosen.id,
      defaultLlmApiKeyId: key.id,
    });

    await applyPendingNormalTiers();

    expect(await OrganizationModel.getById(organizationId)).toMatchObject({
      defaultModelId: chosen.id,
      defaultLlmApiKeyId: key.id,
    });
    expect((await AutoRoutingSettingsModel.find(organizationId))?.enabled).toBe(
      false,
    );
    expect(await pendingTiers()).toEqual([]);
  });

  test("auto routing an admin turned back on since the migration keeps its trio and the tier is dropped", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const [, normal] = await configureAutoRouting(organizationId);
    const tier = await makeRoutingModel();
    const key = await makeLlmProviderApiKey(organizationId, null, {
      provider: "openai",
    });
    await stash({ organizationId, tier, apiKeyId: key.id });

    await applyPendingNormalTiers();

    expect(await AutoRoutingSettingsModel.find(organizationId)).toMatchObject({
      enabled: true,
      normalModelId: normal.id,
    });
    expect(await pendingTiers()).toEqual([]);
  });

  test("a move that fails leaves the tier for the next startup", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const [, normal] = await configureAutoRouting(organizationId);
    await AutoRoutingSettingsModel.update(organizationId, { enabled: false });
    const tier = await makeRoutingModel();
    // No such key: the default's key reference rejects the write.
    await stash({ organizationId, tier, apiKeyId: randomUUID() });

    await applyPendingNormalTiers();

    expect(
      (await OrganizationModel.getById(organizationId))?.defaultModelId,
    ).toBe(normal.id);
    expect(await pendingTiers()).toMatchObject([{ organizationId }]);
  });
});

/** Stashes `tier` as the migration does, over the organization's current default. */
async function stash(params: {
  organizationId: string;
  tier: Pick<Model, "id">;
  apiKeyId: string;
}) {
  const organization = await OrganizationModel.getById(params.organizationId);
  await db.insert(schema.orgTrioPendingNormalTierTable).values({
    organizationId: params.organizationId,
    normalModelId: params.tier.id,
    apiKeyId: params.apiKeyId,
    autoRoutingWasEnabled: true,
    expectedDefaultModelId: organization?.defaultModelId ?? null,
    expectedDefaultLlmApiKeyId: organization?.defaultLlmApiKeyId ?? null,
  });
}

function pendingTiers() {
  return db.select().from(schema.orgTrioPendingNormalTierTable);
}
