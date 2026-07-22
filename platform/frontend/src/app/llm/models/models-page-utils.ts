import {
  type archestraApiTypes,
  compareModelsForDisplay,
} from "@archestra/shared";

export type ModelsPageModelTypeFilter = "all" | "chat" | "embedding";

/** The generated update-route payload shape — never re-declared by hand. */
type ConfiguredParametersBody =
  archestraApiTypes.UpdateModelData["body"]["configuredParameters"];

/**
 * String-typed form fields for the native Ollama configured parameters.
 *
 * `seed` is deliberately absent: it is not a knob worth exposing per model, and
 * a fixed seed is rarely what anyone wants across every turn. It still exists in
 * the backend schema, and {@link buildConfiguredParameters} carries any persisted
 * value through untouched rather than dropping it on the next save.
 */
export interface ConfiguredParametersFormValues {
  num_ctx: string;
  num_predict: string;
  top_k: string;
  top_p: string;
  repeat_penalty: string;
  temperature: string;
  stop: string;
  reasoning_effort: "" | "none" | "low" | "medium" | "high";
}

/** The subset of a model row these helpers read. */
export type ConfiguredParametersModel = {
  contextLength?: number | null;
  configuredParameters?: ConfiguredParametersBody;
};

export const EMPTY_CONFIGURED_PARAMETERS: ConfiguredParametersFormValues = {
  num_ctx: "",
  num_predict: "",
  top_k: "",
  top_p: "",
  repeat_penalty: "",
  temperature: "",
  stop: "",
  reasoning_effort: "",
};

/**
 * Bounds for each numeric parameter, mirroring the backend
 * `ConfiguredParametersSchema`. Without a client-side rule the backend's 400 is
 * the only feedback, and that 400 is easy to mistake for success.
 */
type NumericParameterRule = {
  min?: number;
  max?: number;
  integer?: boolean;
};

export const OLLAMA_NATIVE_PARAM_RULES: Record<
  keyof Omit<ConfiguredParametersFormValues, "reasoning_effort" | "stop">,
  NumericParameterRule
> = {
  num_ctx: { min: 1, integer: true },
  num_predict: { min: -2, integer: true },
  temperature: { min: 0 },
  top_p: { min: 0, max: 1 },
  top_k: { min: 0, integer: true },
  repeat_penalty: { min: 0 },
};

/**
 * Validate one numeric parameter field, returning `true` or a message in the
 * shape react-hook-form's `rules.validate` expects.
 *
 * `contextLength` additionally caps `num_ctx`: asking for more context than the
 * model architecturally has is rejected by the update route, and catching it
 * here explains the limit instead of surfacing a bare 400.
 */
export function validateConfiguredParameter(params: {
  name: keyof typeof OLLAMA_NATIVE_PARAM_RULES;
  value: string;
  contextLength?: number | null;
}): true | string {
  const { name, value, contextLength } = params;
  const trimmed = value.trim();
  if (!trimmed) return true;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return "Must be a number";

  const rule = OLLAMA_NATIVE_PARAM_RULES[name];
  if (rule.integer && !Number.isInteger(parsed)) {
    return "Must be a whole number";
  }
  if (rule.min !== undefined && parsed < rule.min) {
    return `Must be ${rule.min} or greater`;
  }
  if (rule.max !== undefined && parsed > rule.max) {
    return `Must be ${rule.max} or less`;
  }
  if (
    name === "num_ctx" &&
    contextLength !== null &&
    contextLength !== undefined &&
    parsed > contextLength
  ) {
    return `Cannot exceed the model's context length of ${contextLength}`;
  }
  return true;
}

/**
 * Model row → form values. Inverse of {@link buildConfiguredParameters}; the
 * pair must round-trip, or reopening the dialog silently rewrites the saved
 * configuration.
 */
export function getConfiguredParameterDefaults(
  model: ConfiguredParametersModel,
): ConfiguredParametersFormValues {
  const cp = model.configuredParameters;
  if (!cp) return { ...EMPTY_CONFIGURED_PARAMETERS };
  const numToStr = (v: number | null | undefined) =>
    v === null || v === undefined ? "" : String(v);
  return {
    num_ctx: numToStr(cp.num_ctx),
    num_predict: numToStr(cp.num_predict),
    top_k: numToStr(cp.top_k),
    top_p: numToStr(cp.top_p),
    repeat_penalty: numToStr(cp.repeat_penalty),
    temperature: numToStr(cp.temperature),
    stop: cp.stop?.join("\n") ?? "",
    reasoning_effort: cp.reasoning_effort ?? "",
  };
}

/**
 * Parse the string-typed form fields into a ConfiguredParameters payload.
 * Empty fields are omitted so they inherit Ollama's own default; an entirely
 * empty form clears the override (null).
 *
 * The update route replaces `configuredParameters` wholesale rather than
 * merging, which is what makes "clear a field" work — and also what makes a
 * dropped field destructive. Field-level validation therefore has to run before
 * this: an unparseable value must never reach here and quietly vanish.
 *
 * `stop` is newline-delimited. Comma-delimiting split any stop sequence
 * containing a comma in two on the next unrelated save.
 *
 * `persisted` carries forward fields the form no longer renders — today just
 * `seed`. Because the route replaces the object wholesale, omitting it here
 * would delete a saved seed the moment anything else was edited.
 */
export function buildConfiguredParameters(
  values: ConfiguredParametersFormValues,
  persisted?: ConfiguredParametersBody,
): ConfiguredParametersBody {
  const result: NonNullable<ConfiguredParametersBody> = {};
  if (persisted?.seed !== undefined && persisted.seed !== null) {
    result.seed = persisted.seed;
  }
  const num = (s: string): number | undefined => {
    const trimmed = s.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const numCtx = num(values.num_ctx);
  if (numCtx !== undefined) result.num_ctx = numCtx;
  const numPredict = num(values.num_predict);
  if (numPredict !== undefined) result.num_predict = numPredict;
  const topK = num(values.top_k);
  if (topK !== undefined) result.top_k = topK;
  const topP = num(values.top_p);
  if (topP !== undefined) result.top_p = topP;
  const repeatPenalty = num(values.repeat_penalty);
  if (repeatPenalty !== undefined) result.repeat_penalty = repeatPenalty;
  const temperature = num(values.temperature);
  if (temperature !== undefined) result.temperature = temperature;
  const stop = values.stop
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (stop.length > 0) result.stop = stop;
  if (values.reasoning_effort)
    result.reasoning_effort = values.reasoning_effort;

  return Object.keys(result).length > 0 ? result : null;
}

export type ModelsPageAvailableApiKey = {
  readonly id: string;
  readonly provider: string;
};

export const OBSERVED_MODEL_SOURCE_LABEL = "Observed in requests";
export const OBSERVED_MODEL_SOURCE_DESCRIPTION =
  "This model was first seen in traffic through a model gateway. It may not appear in a provider catalog.";

export type ModelsPageFilterableModel = {
  modelId: string;
  provider: string;
  apiKeys: readonly { id: string }[];
  embeddingDimensions: number | null;
  isFree: boolean;
  isBest?: boolean | null;
};

export function canFilterFreeModelsForApiKey(params: {
  availableApiKeys: readonly ModelsPageAvailableApiKey[];
  apiKeyFilter: string;
}): boolean {
  const { availableApiKeys, apiKeyFilter } = params;

  if (apiKeyFilter === "all") {
    return availableApiKeys.some((key) => key.provider === "openrouter");
  }

  const selectedApiKey = availableApiKeys.find(
    (key) => key.id === apiKeyFilter,
  );
  return selectedApiKey?.provider === "openrouter";
}

export function filterModelsForPage<
  T extends ModelsPageFilterableModel,
>(params: {
  models: readonly T[];
  search: string;
  apiKeyFilter: string;
  modelTypeFilter: ModelsPageModelTypeFilter;
  freeOnly: boolean;
  canFilterFreeModels: boolean;
}): T[] {
  const {
    models,
    search,
    apiKeyFilter,
    modelTypeFilter,
    freeOnly,
    canFilterFreeModels,
  } = params;
  let result = models;

  if (search) {
    const query = search.toLowerCase();
    result = result.filter((model) =>
      model.modelId.toLowerCase().includes(query),
    );
  }
  if (apiKeyFilter !== "all") {
    result = result.filter((model) =>
      model.apiKeys.some((key) => key.id === apiKeyFilter),
    );
  }
  if (modelTypeFilter === "embedding") {
    result = result.filter((model) => model.embeddingDimensions !== null);
  } else if (modelTypeFilter === "chat") {
    result = result.filter((model) => model.embeddingDimensions === null);
  }
  if (freeOnly && canFilterFreeModels) {
    result = result.filter((model) => model.isFree);
  }

  return [...result].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) || compareModelsForDisplay(a, b),
  );
}
