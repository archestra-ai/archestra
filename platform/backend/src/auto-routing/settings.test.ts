import { randomUUID } from "node:crypto";
import config from "@/config";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import ModelModel from "@/models/model";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting } from "@/test/auto-routing";
import { ApiError } from "@/types";
import { updateAutoRoutingSettings } from "./settings";
import { sharedLongContextThreshold } from "./tiers";

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
