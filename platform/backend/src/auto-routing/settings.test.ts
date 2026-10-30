import { randomUUID } from "node:crypto";
import config from "@/config";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import ModelModel from "@/models/model";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting } from "@/test/auto-routing";
import { ApiError } from "@/types";
import { updateAutoRoutingSettings } from "./settings";
import { sharedLongContextThreshold, tiersFingerprint } from "./tiers";

describe("updateAutoRoutingSettings", () => {
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  test("concurrent partial updates cannot jointly store tiers with different long-context thresholds", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await configureAutoRouting(organizationId);
    const fast = await withThreshold(128_000);
    const normal = await withThreshold(200_000);

    const results = await Promise.allSettled([
      updateAutoRoutingSettings(organizationId, { fastModelId: fast.id }),
      updateAutoRoutingSettings(organizationId, { normalModelId: normal.id }),
    ]);

    const rejected = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(ApiError);
    expect(rejected[0]).toMatchObject({ statusCode: 400 });
    const settings = await AutoRoutingSettingsModel.find(organizationId);
    if (!settings) throw new Error("settings missing");
    const stored = await ModelModel.findByIds(
      [
        settings.fastModelId,
        settings.normalModelId,
        settings.smartModelId,
      ].filter((id): id is string => id !== null),
    );
    expect(sharedLongContextThreshold(stored).kind).toBe("ok");
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
