import { describe, expect, it } from "vitest";
import {
  buildConfiguredParameters,
  canFilterFreeModelsForApiKey,
  EMPTY_CONFIGURED_PARAMETERS,
  filterModelsForPage,
  getConfiguredParameterDefaults,
  type ModelsPageAvailableApiKey,
  type ModelsPageFilterableModel,
  resolveDisplayContextLength,
  validateConfiguredParameter,
} from "./models-page-utils";

const availableApiKeys = [
  { id: "openrouter-key", provider: "openrouter" },
  { id: "openai-key", provider: "openai" },
] as const satisfies readonly ModelsPageAvailableApiKey[];

const models = [
  {
    modelId: "openrouter/free",
    provider: "openrouter",
    apiKeys: [{ id: "openrouter-key" }],
    embeddingDimensions: null,
    isFree: true,
  },
  {
    modelId: "openrouter/paid",
    provider: "openrouter",
    apiKeys: [{ id: "openrouter-key" }],
    embeddingDimensions: null,
    isFree: false,
  },
  {
    modelId: "gpt-4o",
    provider: "openai",
    apiKeys: [{ id: "openai-key" }],
    embeddingDimensions: null,
    isFree: false,
  },
] as const satisfies readonly ModelsPageFilterableModel[];

describe("canFilterFreeModelsForApiKey", () => {
  it("allows the free-model filter only for all models with OpenRouter or a selected OpenRouter key", () => {
    expect(
      canFilterFreeModelsForApiKey({
        availableApiKeys,
        apiKeyFilter: "all",
      }),
    ).toBe(true);
    expect(
      canFilterFreeModelsForApiKey({
        availableApiKeys,
        apiKeyFilter: "openrouter-key",
      }),
    ).toBe(true);
    expect(
      canFilterFreeModelsForApiKey({
        availableApiKeys,
        apiKeyFilter: "openai-key",
      }),
    ).toBe(false);
    expect(
      canFilterFreeModelsForApiKey({
        availableApiKeys,
        apiKeyFilter: "unknown-key",
      }),
    ).toBe(false);
  });
});

describe("filterModelsForPage", () => {
  it("does not apply a stale free-model filter to a selected non-OpenRouter API key", () => {
    const canFilterFreeModels = canFilterFreeModelsForApiKey({
      availableApiKeys,
      apiKeyFilter: "openai-key",
    });

    const result = filterModelsForPage({
      models,
      search: "",
      apiKeyFilter: "openai-key",
      modelTypeFilter: "all",
      freeOnly: true,
      canFilterFreeModels,
    });

    expect(result.map((model) => model.modelId)).toEqual(["gpt-4o"]);
  });

  it("applies the free-model filter to a selected OpenRouter API key", () => {
    const canFilterFreeModels = canFilterFreeModelsForApiKey({
      availableApiKeys,
      apiKeyFilter: "openrouter-key",
    });

    const result = filterModelsForPage({
      models,
      search: "",
      apiKeyFilter: "openrouter-key",
      modelTypeFilter: "all",
      freeOnly: true,
      canFilterFreeModels,
    });

    expect(result.map((model) => model.modelId)).toEqual(["openrouter/free"]);
  });
});

describe("configured parameters round-trip", () => {
  it("survives defaults -> build -> defaults unchanged", () => {
    const saved = {
      num_ctx: 8192,
      num_predict: 1024,
      top_k: 40,
      top_p: 0.9,
      repeat_penalty: 1.1,
      temperature: 0.7,
      seed: 42,
      stop: ["END", "STOP"],
      reasoning_effort: "medium" as const,
    };

    const formValues = getConfiguredParameterDefaults({
      configuredParameters: saved,
    });
    const rebuilt = buildConfiguredParameters(formValues, saved);

    // The update route replaces configuredParameters wholesale, so any field
    // these two disagree on is silently dropped the next time the dialog is
    // opened and saved.
    expect(rebuilt).toEqual(saved);
  });

  it("preserves a persisted seed the form no longer renders", () => {
    // `seed` was removed from the dialog, but the route replaces the object
    // wholesale — without carrying it through, editing the temperature would
    // silently delete a seed an admin set earlier.
    const saved = { temperature: 0.7, seed: 42 };

    const rebuilt = buildConfiguredParameters(
      getConfiguredParameterDefaults({ configuredParameters: saved }),
      saved,
    );

    expect(rebuilt).toEqual(saved);
  });

  it("does not invent a seed when none was persisted", () => {
    expect(
      buildConfiguredParameters(
        getConfiguredParameterDefaults({ configuredParameters: { top_k: 40 } }),
        { top_k: 40 },
      ),
    ).toEqual({ top_k: 40 });
  });

  it("preserves a stop sequence containing a comma", () => {
    const saved = { stop: ["Human:, please", "END"] };

    const rebuilt = buildConfiguredParameters(
      getConfiguredParameterDefaults({ configuredParameters: saved }),
    );

    // Comma-delimiting split this in two on any unrelated save, so generations
    // ran past where they should have stopped.
    expect(rebuilt).toEqual(saved);
  });

  it("keeps falsy numeric values through the round-trip", () => {
    const saved = { temperature: 0, top_p: 0, seed: 0, top_k: 0 };

    expect(
      buildConfiguredParameters(
        getConfiguredParameterDefaults({ configuredParameters: saved }),
        saved,
      ),
    ).toEqual(saved);
  });

  it("clears the override when every field is empty", () => {
    expect(buildConfiguredParameters(EMPTY_CONFIGURED_PARAMETERS)).toBeNull();
    expect(
      getConfiguredParameterDefaults({ configuredParameters: null }),
    ).toEqual(EMPTY_CONFIGURED_PARAMETERS);
  });
});

describe("validateConfiguredParameter", () => {
  it("accepts an empty field so the value is inherited", () => {
    expect(validateConfiguredParameter({ name: "num_ctx", value: "" })).toBe(
      true,
    );
    expect(
      validateConfiguredParameter({ name: "temperature", value: "  " }),
    ).toBe(true);
  });

  it("rejects unparseable input instead of dropping the field", () => {
    // buildConfiguredParameters omits anything non-finite, and the update route
    // replaces the object wholesale — so an unvalidated "0.7x" typed over a
    // saved temperature would delete it and still report success.
    expect(
      validateConfiguredParameter({ name: "temperature", value: "0.7x" }),
    ).toBe("Must be a number");
    expect(validateConfiguredParameter({ name: "top_k", value: "--3" })).toBe(
      "Must be a number",
    );
  });

  it("mirrors the backend bounds", () => {
    expect(validateConfiguredParameter({ name: "top_p", value: "2" })).toBe(
      "Must be 1 or less",
    );
    expect(validateConfiguredParameter({ name: "top_p", value: "0.9" })).toBe(
      true,
    );
    expect(validateConfiguredParameter({ name: "num_ctx", value: "0" })).toBe(
      "Must be 1 or greater",
    );
    expect(
      validateConfiguredParameter({ name: "num_ctx", value: "8192.5" }),
    ).toBe("Must be a whole number");
    expect(validateConfiguredParameter({ name: "top_k", value: "1.5" })).toBe(
      "Must be a whole number",
    );
    expect(
      validateConfiguredParameter({ name: "num_predict", value: "-1" }),
    ).toBe(true);
    expect(
      validateConfiguredParameter({ name: "num_predict", value: "-3" }),
    ).toBe("Must be -2 or greater");
  });

  it("caps num_ctx at the model's context length", () => {
    expect(
      validateConfiguredParameter({
        name: "num_ctx",
        value: "1310720",
        contextLength: 131072,
      }),
    ).toBe("Cannot exceed the model's context length of 131072");
    expect(
      validateConfiguredParameter({
        name: "num_ctx",
        value: "131072",
        contextLength: 131072,
      }),
    ).toBe(true);
    // An unknown context length cannot constrain anything.
    expect(
      validateConfiguredParameter({
        name: "num_ctx",
        value: "1310720",
        contextLength: null,
      }),
    ).toBe(true);
  });
});

describe("resolveDisplayContextLength", () => {
  it("shows the enforced window and flags it as capped", () => {
    // qwen3-8k: a 262K-capable model whose Modelfile pins num_ctx to 8192.
    expect(
      resolveDisplayContextLength({
        contextLength: 262144,
        effectiveContextLength: 8192,
      }),
    ).toEqual({ display: 8192, architectural: 262144, isCapped: true });
  });

  it("does not flag a model running at its architectural window", () => {
    expect(
      resolveDisplayContextLength({
        contextLength: 262144,
        effectiveContextLength: 262144,
      }),
    ).toEqual({ display: 262144, architectural: 262144, isCapped: false });
  });

  it("falls back to the architectural value when none was resolved", () => {
    // Providers other than Ollama never carry an effective value.
    expect(
      resolveDisplayContextLength({
        contextLength: 200000,
        effectiveContextLength: null,
      }),
    ).toEqual({ display: 200000, architectural: 200000, isCapped: false });
  });

  it("shows an enforced window even when the architectural one is unknown", () => {
    // Nothing to compare against, so the gap cannot be claimed.
    expect(
      resolveDisplayContextLength({
        contextLength: null,
        effectiveContextLength: 8192,
      }),
    ).toEqual({ display: 8192, architectural: null, isCapped: false });
  });

  it("reports nothing when neither value is known", () => {
    expect(resolveDisplayContextLength({})).toEqual({
      display: null,
      architectural: null,
      isCapped: false,
    });
  });
});
