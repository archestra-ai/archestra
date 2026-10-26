import { randomUUID } from "node:crypto";
import ModelModel from "@/models/model";
import RoutingScorerVersionModel from "@/models/routing-scorer-version";
import type {
  InsertRoutingDecision,
  RoutingFit,
  RoutingSessionKey,
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
      tier_needed: [0.2, 0.5, 0.3],
      p_long: 0.1,
      kind: "main",
      source: "claude-code",
    },
    featuresSchemaVersion: 1,
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
