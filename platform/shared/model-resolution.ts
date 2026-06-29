/**
 * Pure model-resolution core.
 *
 * No React, no fetch, no database — imported by both the frontend and the
 * backend so the client and the server resolve the effective model
 * identically. Every function here is pure and total.
 *
 * Resolution is a plain priority chain over foreign-key columns:
 *
 *   conversation -> member -> agent -> organization -> best available model
 *
 * Because each level stores a real FK (`ON DELETE SET NULL`), a deleted model
 * simply becomes NULL and the chain falls through — there is no orphaned-string
 * handling to do here.
 */

import {
  OPENROUTER_AUTO_MODEL_ID,
  OPENROUTER_FREE_MODEL_ID,
  OPENROUTER_LATEST_ALIAS_PREFIX,
  type SupportedProvider,
} from "./model-constants";

/** A (model, key) pair stored at one level of the resolution chain. */
export interface ModelSelection {
  modelId: string | null | undefined;
  apiKeyId: string | null | undefined;
}

/** A selection with both ids present — the only shape that can be resolved. */
export interface CompleteModelSelection {
  modelId: string;
  apiKeyId: string;
}

/** Type guard narrowing a {@link ModelSelection} to {@link CompleteModelSelection}. */
export function isCompleteModelSelection(
  selection: ModelSelection,
): selection is CompleteModelSelection {
  return Boolean(selection.modelId) && Boolean(selection.apiKeyId);
}

/**
 * A (model, key) selection is complete only when both ids are set or both are
 * empty. A half-configured selection — a model with no key, or a key with no
 * model — must never be persisted: the key cannot be inferred from the model
 * (see `resolveModelSelection`), so a half pair is an unresolvable state.
 */
export function isModelSelectionComplete(selection: ModelSelection): boolean {
  return Boolean(selection.modelId) === Boolean(selection.apiKeyId);
}

/** A model the actor can currently use, with the provider's "best" marker. */
export interface RankedModel {
  modelId: string;
  /** The API key that makes this model available. */
  apiKeyId: string;
  isBest?: boolean;
}

/** Where the selected model came from, relative to the configured defaults. */
export type ModelSource = "agent" | "organization" | "user";

/**
 * Resolve the effective model from the priority chain.
 *
 * `levels` must already be ordered most- to least-specific
 * (conversation -> member -> agent -> organization). A level wins only when it
 * carries *both* a `modelId` and an `apiKeyId`: a model is meaningless without
 * the key it runs through, so a half-configured level (e.g. a model pinned
 * with no key) is skipped and the chain falls through to the next level. When
 * no level is complete, falls back to the "best available" model across every
 * key the actor can use.
 *
 * There is no key derivation: the key is never inferred from the model. The
 * same model can be reached through many keys, so a `(model, key)` pair is the
 * only unambiguous unit of selection.
 *
 * Returns null only when nothing is configured and no models are available.
 */
export function resolveModelSelection(params: {
  levels: ModelSelection[];
  availableModels: RankedModel[];
}): ModelSelection | null {
  const { levels, availableModels } = params;

  for (const level of levels) {
    if (level.modelId && level.apiKeyId) {
      return { modelId: level.modelId, apiKeyId: level.apiKeyId };
    }
  }

  const best = pickBestModel(availableModels);
  return best ? { modelId: best.modelId, apiKeyId: best.apiKeyId } : null;
}

/**
 * Pick the "best" model from a list: the one the provider marked best, else
 * the first. Shared so every fallback honors the marker instead of whatever
 * happens to sort first.
 */
export function pickBestModel<T extends { isBest?: boolean }>(
  models: T[],
): T | undefined {
  return models.find((m) => m.isBest) ?? models[0];
}

/** Per-token USD prices for a model, as stored on the `models` table. */
export interface ModelPricing {
  promptPricePerToken: string | null;
  completionPricePerToken: string | null;
}

/**
 * A model is "free" only when both per-token prices are known and exactly zero.
 * Null pricing means unknown, not free. Shared by the backend (auto-default) and
 * the frontend (badge, filter).
 */
export function isFreeModel(model: ModelPricing): boolean {
  if (
    model.promptPricePerToken == null ||
    model.completionPricePerToken == null
  ) {
    return false;
  }
  return (
    Number(model.promptPricePerToken) === 0 &&
    Number(model.completionPricePerToken) === 0
  );
}

/**
 * True for OpenRouter "latest" alias ids (`~vendor/model-latest`) that always
 * track the newest model in a family. Shared by every picker for the badge.
 */
export function isOpenRouterLatestAlias(
  provider: SupportedProvider,
  modelId: string,
): boolean {
  return (
    provider === "openrouter" &&
    modelId.startsWith(OPENROUTER_LATEST_ALIAS_PREFIX)
  );
}

/** A model as it appears in a selection list, for display ordering. */
export interface DisplayOrderModel {
  modelId: string;
  isBest?: boolean | null;
}

/**
 * Comparator for ordering models in selection UIs. Shared so every picker —
 * chat selector, settings selects, the models management table — lists models
 * identically: routers first (free, then auto), then provider-recommended
 * models, then the rest, each tier sorted alphabetically by model id.
 */
export function compareModelsForDisplay(
  a: DisplayOrderModel,
  b: DisplayOrderModel,
): number {
  const rankDiff = displayOrderRank(a) - displayOrderRank(b);
  return rankDiff !== 0 ? rankDiff : a.modelId.localeCompare(b.modelId);
}

function displayOrderRank(model: DisplayOrderModel): number {
  if (model.modelId === OPENROUTER_FREE_MODEL_ID) return 0;
  if (model.modelId === OPENROUTER_AUTO_MODEL_ID) return 1;
  return model.isBest ? 2 : 3;
}

/**
 * Determine where the selected model came from, purely by comparison with the
 * configured defaults — no stored state.
 *
 * Returns null when there is nothing to compare against (no model, or no
 * agent/organization default) — there is no default to "override", so no
 * badge is shown.
 */
export function deriveModelSource(params: {
  selectedModelId: string | null | undefined;
  agentModelId: string | null | undefined;
  orgModelId: string | null | undefined;
}): ModelSource | null {
  const { selectedModelId, agentModelId, orgModelId } = params;
  if (!selectedModelId) {
    return null;
  }
  if (agentModelId && selectedModelId === agentModelId) {
    return "agent";
  }
  if (orgModelId && selectedModelId === orgModelId) {
    return "organization";
  }
  // No configured default anywhere — nothing to override.
  if (!agentModelId && !orgModelId) {
    return null;
  }
  return "user";
}
