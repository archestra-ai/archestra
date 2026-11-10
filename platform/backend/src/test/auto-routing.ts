import { randomUUID } from "node:crypto";
import { plan as fitPlan } from "@archestra/router-rs";
import { and, eq } from "drizzle-orm";
import { activeSourceVersion } from "@/auto-routing/signals";
import { type Trio, tiersFingerprint } from "@/auto-routing/tiers";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import RoutingPlanModel from "@/models/routing-plan";
import RoutingScorerVersionModel from "@/models/routing-scorer-version";
import { accessGrants } from "@/test/access-grants";
import type { Model } from "@/types";
import {
  FEATURES_SCHEMA_VERSION,
  type InsertRoutingDecision,
  type RoutingFit,
  type RoutingSessionKey,
} from "@/types/auto-routing";

export async function makeRoutingModel(modelId = `model-${randomUUID()}`) {
  return ModelModel.create({
    externalId: `openai/${modelId}`,
    provider: "openai",
    modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
}

export async function makeScorerVersion(name = `scorer-${randomUUID()}`) {
  return RoutingScorerVersionModel.upsert({
    name,
    model: "jev-1.13.0",
    spec: { name },
    specHash: randomUUID(),
  });
}

/** A planned decision for `sessionKey`, routed to tier 1. */
export function plannedDecision(params: {
  organizationId: string;
  sessionKey: RoutingSessionKey;
  modelId: string;
  scorerVersionId: string;
  tierIndex?: number;
}): InsertRoutingDecision {
  return {
    organizationId: params.organizationId,
    sessionKey: params.sessionKey,
    tierIndex: params.tierIndex ?? 1,
    modelId: params.modelId,
    propensity: 1,
    u: 0.5,
    planId: randomUUID(),
    reason: "planned",
    scorerVersionId: params.scorerVersionId,
    features: {
      signals: {
        "jev-session": {
          version: params.scorerVersionId,
          tier_needed: [0.2, 0.5, 0.3],
          p_long: 0.1,
        },
      },
      client: "claude-code",
    },
    featuresSchemaVersion: FEATURES_SCHEMA_VERSION,
    coreVersion: "0.1.0",
    planFormatVersion: 1,
  };
}

/** A successful fit over `inputWatermark` at `generation`. */
export function activeFit(params: {
  organizationId: string;
  scorerVersionId: string;
  generation: number;
  inputWatermark: Date;
  label?: string;
}): RoutingFit {
  return {
    organizationId: params.organizationId,
    trigger: "nightly",
    generation: params.generation,
    inputWatermark: params.inputWatermark,
    tiersFingerprint: { tiers: [] },
    budgetUsdPerDay: "25.00",
    scorerVersionId: params.scorerVersionId,
    coreVersion: "0.1.0",
    planFormatVersion: 1,
    outcome: {
      status: "active",
      plan: { label: params.label ?? "plan" },
      summary: null,
      diagnostics: null,
    },
  };
}

/** Fits a real plan for `trio` over synthetic history and publishes it for the running scorer version. */
export async function publishFittedPlan(params: {
  organizationId: string;
  trio: Trio;
  /** Defaults to the running scorer version. */
  scorerVersionId?: string;
}) {
  const scorerVersionId =
    params.scorerVersionId ?? (await activeSourceVersion()).id;
  await AutoRoutingSettingsModel.activateScorerVersion(
    params.organizationId,
    scorerVersionId,
  );
  const settings = await AutoRoutingSettingsModel.find(params.organizationId);
  if (!settings) throw new Error("organization has no LLM Proxy");
  const fingerprint = tiersFingerprint(params.trio);
  const features = {
    tier_needed: [0.4, 0.3, 0.3],
    p_long: 0,
    source: "unknown",
  };
  const planJson = await fitPlan(
    JSON.stringify({
      history: Array.from({ length: 40 }, (_, i) => ({
        features,
        short: {
          input: 1_000 + 37 * i,
          cache_read: 20_000 + 101 * i,
          cache_write: 2_000,
          output: 500 + 11 * i,
        },
        long: { input: 0, cache_read: 0, cache_write: 0, output: 0 },
        timestamp_ms: i * 86_400_000,
        weight: 1,
      })),
      tiers: fingerprint,
      budget: 10_000,
      volume: { kind: "flat", sessions_per_day: 40, tokens_per_day: 1e6 },
      baseline_source: "unknown",
    }),
  );
  const published = await RoutingPlanModel.publish({
    organizationId: params.organizationId,
    trigger: "manual",
    generation: settings.generation,
    inputWatermark: new Date(),
    tiersFingerprint: fingerprint,
    budgetUsdPerDay: "10000",
    scorerVersionId,
    coreVersion: "0.1.0",
    planFormatVersion: 1,
    outcome: {
      status: "active",
      plan: JSON.parse(planJson),
      summary: { expected_spend_usd_per_day: 12.5 },
      diagnostics: { holdout_sessions: 4 },
    },
  });
  if (published.kind !== "recorded") throw new Error("plan was not published");
  return published.plan;
}

/** Gives the organization an LLM Proxy with auto routing enabled over three fresh, priced models. */
export async function configureAutoRouting(organizationId: string) {
  await AgentModel.getOrgLlmProxy(organizationId);
  const suffix = randomUUID().slice(0, 8);
  const priced = (tier: string, input: string, output: string) =>
    ModelModel.create({
      externalId: `openai/${tier}-${suffix}`,
      provider: "openai",
      modelId: `${tier}-${suffix}`,
      inputModalities: ["text"],
      outputModalities: ["text"],
      customPricePerMillionInput: input,
      customPricePerMillionOutput: output,
    });
  const trio = [
    await priced("fast", "1.00", "5.00"),
    await priced("normal", "3.00", "15.00"),
    await priced("smart", "15.00", "75.00"),
  ] as const satisfies Trio;
  await setAutoRoutingTiers(organizationId, {
    fast: trio[0],
    normal: trio[1],
    smart: trio[2],
  });
  await AutoRoutingSettingsModel.update(organizationId, {
    enabled: true,
    budgetUsdPerDay: "50.00",
  });
  return trio;
}

/**
 * Makes `trio` the organization's auto-routing tiers, each on an
 * organization-wide key of its provider; a null tier is removed.
 */
export async function setAutoRoutingTiers(
  organizationId: string,
  trio: {
    fast?: Pick<Model, "id" | "provider"> | null;
    normal?: Pick<Model, "id" | "provider"> | null;
    smart?: Pick<Model, "id" | "provider"> | null;
  },
) {
  for (const tier of ["fast", "normal", "smart"] as const) {
    const model = trio[tier];
    if (model === undefined) continue;
    await db
      .delete(schema.autoRoutingTiersTable)
      .where(
        and(
          eq(schema.autoRoutingTiersTable.organizationId, organizationId),
          eq(schema.autoRoutingTiersTable.tier, tier),
        ),
      );
    if (model === null) continue;
    const key = await organizationKey(organizationId, model.provider);
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    await db.insert(schema.autoRoutingTiersTable).values({
      organizationId,
      tier,
      providerApiKeyId: key.id,
      modelId: model.id,
    });
  }
}

/** An organization-wide key of `provider`, made on first use. */
async function organizationKey(
  organizationId: string,
  provider: Model["provider"],
) {
  const existing = await LlmProviderApiKeyModel.findOrganizationWideKey(
    organizationId,
    provider,
  );
  if (existing) return existing;
  return LlmProviderApiKeyModel.create(
    {
      organizationId,
      secretId: null,
      name: `Auto routing ${provider} ${randomUUID().slice(0, 8)}`,
      provider,
      scope: "org",
      userId: null,
      baseUrl: null,
      inferenceBaseUrl: null,
    },
    accessGrants("org"),
  );
}
