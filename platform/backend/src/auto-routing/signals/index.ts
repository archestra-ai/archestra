import RoutingScorerVersionModel from "@/models/routing-scorer-version";
import type {
  RoutingDecisionFeatures,
  RoutingSessionFeatures,
} from "@/types/auto-routing";
import { type JevSessionReading, JevSessionSource } from "./jev-session";
import { type ScorerSpec, specHash } from "./spec";
import type { PreRunInput } from "./types";

/** The one pre-run signal source today; plans and history are keyed on its version. */
export const preRunSource = new JevSessionSource();

/**
 * The source version of the running spec. Upserted by spec hash, so every
 * replica converges on one row; read per new session rather than memoized,
 * as the row is what each decision references.
 */
export function activeSourceVersion() {
  const spec: ScorerSpec = preRunSource.spec;
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
      [preRunSource.id]: {
        version: params.version,
        tier_needed: params.reading.tierNeeded,
        p_long: params.reading.pLong,
      },
    },
    client: params.input.client ?? "unknown",
  };
}

/** router-core's input: it reads the Jev signal and the request metadata only. */
export function routerFeatures(
  features: RoutingDecisionFeatures,
): RoutingSessionFeatures {
  const { tier_needed, p_long } = features.signals[preRunSource.id];
  return { tier_needed, p_long, source: features.client };
}
