import { randomUUID } from "node:crypto";
import { plan as fitPlan } from "@archestra/router-rs";
import { and, eq } from "drizzle-orm";
import {
  activeSourceVersion,
  DEFAULT_SCORER_MODEL,
} from "@/auto-routing/signals";
import { type Trio, tiersFingerprint } from "@/auto-routing/tiers";
import db, { schema } from "@/database";
import AutoRouterModel from "@/models/auto-router";
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
  routerId: string;
  sessionKey: RoutingSessionKey;
  modelId: string;
  scorerVersionId: string;
  tierIndex?: number;
}): InsertRoutingDecision {
  return {
    organizationId: params.organizationId,
    routerId: params.routerId,
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
  routerId: string;
  scorerVersionId: string;
  generation: number;
  inputWatermark: Date;
  label?: string;
}): RoutingFit {
  return {
    organizationId: params.organizationId,
    routerId: params.routerId,
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
  /** Defaults to the organization's `auto` router. */
  routerId?: string;
  trio: Trio;
  /** Defaults to the running scorer version. */
  scorerVersionId?: string;
}) {
  const scorerVersionId =
    params.scorerVersionId ?? (await activeSourceVersion()).id;
  const routerId =
    params.routerId ?? (await ensureAutoRouter(params.organizationId)).id;
  await AutoRouterModel.activateScorerVersion(routerId, scorerVersionId);
  const settings = await AutoRouterModel.find(routerId);
  if (!settings) throw new Error("auto router does not exist");
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
    routerId,
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

/**
 * The organization's router named `name`, made on first use with no tiers.
 * The first one, `auto`, learns from past sessions like the one that existed
 * before an organization could have several.
 */
export async function ensureAutoRouter(
  organizationId: string,
  name = "auto",
  options: { usesPastSessions?: boolean } = {},
) {
  const existing = await AutoRouterModel.findByName(organizationId, name);
  if (existing) return existing;
  const [row] = await db
    .insert(schema.autoRoutersTable)
    .values({
      organizationId,
      name,
      scorerModel: DEFAULT_SCORER_MODEL,
      generation: 1,
      usesPastSessions: options.usesPastSessions ?? name === "auto",
    })
    .returning({ id: schema.autoRoutersTable.id });
  const router = await AutoRouterModel.find(row.id);
  if (!router) throw new Error("auto router was not created");
  return router;
}

/** Creates the organization's router `name` over three fresh, priced models, as `configureAutoRouting` does for `auto`. */
export async function configureAutoRouter(
  organizationId: string,
  name = "auto",
  options: { usesPastSessions?: boolean } = {},
) {
  const router = await ensureAutoRouter(organizationId, name, options);
  const trio = await makePricedTrio();
  await setAutoRoutingTiers(
    organizationId,
    { fast: trio[0], normal: trio[1], smart: trio[2] },
    router.id,
  );
  await db
    .update(schema.autoRoutersTable)
    .set({ budgetUsdPerDay: "50.00" })
    .where(eq(schema.autoRoutersTable.id, router.id));
  await setAutoRoutingEnabled(organizationId, true);
  return { router, trio };
}

/** Turns auto routing on or off for the whole organization. */
export async function setAutoRoutingEnabled(
  organizationId: string,
  enabled: boolean,
) {
  await db
    .update(schema.organizationsTable)
    .set({ autoRoutingEnabled: enabled })
    .where(eq(schema.organizationsTable.id, organizationId));
}

/** Enables auto routing for the organization over its `auto` router and three fresh, priced models. */
export async function configureAutoRouting(organizationId: string) {
  const { trio } = await configureAutoRouter(organizationId);
  return trio;
}

/** The id of the organization's router `name`, made on first use. */
export async function autoRouterId(organizationId: string, name = "auto") {
  return (await ensureAutoRouter(organizationId, name)).id;
}

async function makePricedTrio() {
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
  return [
    await priced("fast", "1.00", "5.00"),
    await priced("normal", "3.00", "15.00"),
    await priced("smart", "15.00", "75.00"),
  ] as const satisfies Trio;
}

/**
 * Makes `trio` the tiers of the router (default: the organization's `auto`
 * router), each on an organization-wide key of its provider; a null tier is
 * removed.
 */
export async function setAutoRoutingTiers(
  organizationId: string,
  trio: {
    fast?: Pick<Model, "id" | "provider"> | null;
    normal?: Pick<Model, "id" | "provider"> | null;
    smart?: Pick<Model, "id" | "provider"> | null;
  },
  routerId?: string,
) {
  const targetId = routerId ?? (await ensureAutoRouter(organizationId)).id;
  for (const tier of ["fast", "normal", "smart"] as const) {
    const model = trio[tier];
    if (model === undefined) continue;
    await db
      .delete(schema.autoRoutingTiersTable)
      .where(
        and(
          eq(schema.autoRoutingTiersTable.routerId, targetId),
          eq(schema.autoRoutingTiersTable.tier, tier),
        ),
      );
    if (model === null) continue;
    const key = await organizationKey(organizationId, model.provider);
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    await db.insert(schema.autoRoutingTiersTable).values({
      routerId: targetId,
      tier,
      providerApiKeyId: key.id,
      modelId: model.id,
    });
  }
}

/**
 * The body of a router's `tiers`: each model on an organization-wide key of
 * its provider, which is made on first use and made to serve the model.
 */
export async function tiersBody(
  organizationId: string,
  trio: {
    fast: Pick<Model, "id" | "provider">;
    normal: Pick<Model, "id" | "provider">;
    smart: Pick<Model, "id" | "provider">;
  },
) {
  const setting = async (model: Pick<Model, "id" | "provider">) => {
    const key = await organizationKey(organizationId, model.provider);
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    return { modelId: model.id, providerApiKeyId: key.id };
  };
  return {
    fast: await setting(trio.fast),
    normal: await setting(trio.normal),
    smart: await setting(trio.smart),
  };
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
