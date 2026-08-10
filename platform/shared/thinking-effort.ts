// How hard a model should reason before answering, as the product speaks of it.
//
// Provider-neutral on purpose: the levels a provider actually accepts differ
// (and are named differently), so each provider's catalog module owns the
// translation. What is shared is the vocabulary the column, the API and the
// composer all use.
//
// `low` is the shallowest a given model allows, not a fixed provider level —
// on a model that can skip reasoning entirely it means that, and on one that
// always reasons it means as little as it will do.

export const THINKING_EFFORTS = ["low", "medium", "high"] as const;

export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];
