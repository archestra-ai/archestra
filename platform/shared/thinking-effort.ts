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

/**
 * A conversation's stored depth, where `null` is "auto": nobody chose one, so
 * the request carries no reasoning field at all and the model applies its own
 * default.
 *
 * Auto exists because no single level can stand in for "unchanged". Model
 * defaults are not uniform and are not even all reasoning levels — gpt-5.1
 * through 5.4 default to `none`, gpt-5 and gpt-5.5+ to `medium`, Anthropic's
 * `output_config.effort` to `high`, Gemini flash to `medium` but flash-lite to
 * `minimal`. Picking any of ours as the column default would silently deepen
 * reasoning on some existing chats and shallow it on others, and charge for the
 * difference. Sending nothing is the only value that means "what this model
 * already did", for every model, including ones that do not exist yet.
 */
export type ThinkingEffortSetting = ThinkingEffort | null;

/** The composer's options: auto plus the explicit depths, in menu order. */
export const THINKING_EFFORT_OPTIONS = ["auto", ...THINKING_EFFORTS] as const;

export type ThinkingEffortOption = (typeof THINKING_EFFORT_OPTIONS)[number];

/**
 * Auto is `null` on the wire and in the column, but a radio group needs a
 * string, so the two representations are converted at the component boundary
 * rather than letting a sentinel string leak into what gets stored.
 */
export function toThinkingEffortOption(
  setting: ThinkingEffortSetting | undefined,
): ThinkingEffortOption {
  return setting ?? "auto";
}

export function fromThinkingEffortOption(
  option: ThinkingEffortOption,
): ThinkingEffortSetting {
  return option === "auto" ? null : option;
}
