import RoutingScorerVersionModel from "@/models/routing-scorer-version";
import type {
  RoutingDecisionFeatures,
  RoutingSessionFeatures,
} from "@/types/auto-routing";
import { type JevSessionReading, JevSessionSource } from "./jev-session";
import { JEV_SESSION_SPEC, type ScorerSpec, specHash } from "./spec";
import type { PreRunInput } from "./types";

/** The decision model a new auto router starts with. */
export const DEFAULT_SCORER_MODEL = JEV_SESSION_SPEC.model;

/**
 * The pre-run signal source asked with `scorerModel`. A router picks its
 * decision model, so plans and history are keyed on the version of the spec
 * with that model.
 */
export function preRunSource(scorerModel: string = DEFAULT_SCORER_MODEL) {
  return new JevSessionSource({ ...JEV_SESSION_SPEC, model: scorerModel });
}

const SOURCE_ID = preRunSource().id;

/**
 * The source version of the running spec asked with `scorerModel`. Upserted
 * by spec hash, so every replica converges on one row; read per new session
 * rather than memoized, as the row is what each decision references.
 */
export function activeSourceVersion(scorerModel?: string) {
  const spec: ScorerSpec = preRunSource(scorerModel).spec;
  return RoutingScorerVersionModel.upsert({
    name: spec.name,
    model: spec.model,
    spec,
    specHash: specHash(spec),
  });
}

export function decisionFeatures(params: {
  version: string;
  reading: JevSessionReading;
  input: Pick<PreRunInput, "client">;
}): RoutingDecisionFeatures {
  return {
    signals: {
      [SOURCE_ID]: {
        version: params.version,
        tier_needed: params.reading.tierNeeded,
        p_long: params.reading.pLong,
      },
    },
    client: params.input.client ?? "unknown",
    scorerUsage: {
      inputTokens: params.reading.inputTokens,
      outputTokens: params.reading.outputTokens,
    },
  };
}

/** router-core's input: it reads the Jev signal and the request metadata only. */
export function routerFeatures(
  features: RoutingDecisionFeatures,
): RoutingSessionFeatures {
  const { tier_needed, p_long } = features.signals[SOURCE_ID];
  return { tier_needed, p_long, source: features.client };
}
