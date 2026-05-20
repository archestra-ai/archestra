import { describe, expect, test } from "vitest";
import {
  OPENROUTER_AUTO_MODEL_ID,
  OPENROUTER_FREE_MODEL_ID,
} from "./model-constants";
import {
  compareModelsForDisplay,
  type DisplayOrderModel,
  deriveModelSource,
  isFreeModel,
  type ModelSelection,
  type ModelSource,
  pickBestModel,
  type RankedModel,
  resolveModelSelection,
} from "./model-resolution";

describe("resolveModelSelection", () => {
  // conversation -> member -> agent -> organization
  const conv: ModelSelection = { modelId: "conv-model", apiKeyId: "conv-key" };
  const member: ModelSelection = {
    modelId: "member-model",
    apiKeyId: "mem-key",
  };
  const agent: ModelSelection = {
    modelId: "agent-model",
    apiKeyId: "agent-key",
  };
  const org: ModelSelection = { modelId: "org-model", apiKeyId: "org-key" };
  const none: ModelSelection = { modelId: null, apiKeyId: null };

  const available: RankedModel[] = [
    { modelId: "cheap-model", apiKeyId: "key-a" },
    { modelId: "best-model", apiKeyId: "key-b", isBest: true },
  ];

  const cases: Array<{
    name: string;
    levels: ModelSelection[];
    availableModels: RankedModel[];
    expected: ModelSelection | null;
  }> = [
    {
      name: "conversation wins over every lower level",
      levels: [conv, member, agent, org],
      availableModels: available,
      expected: { modelId: "conv-model", apiKeyId: "conv-key" },
    },
    {
      name: "member wins when conversation is empty",
      levels: [none, member, agent, org],
      availableModels: available,
      expected: { modelId: "member-model", apiKeyId: "mem-key" },
    },
    {
      name: "agent wins when conversation and member are empty",
      levels: [none, none, agent, org],
      availableModels: available,
      expected: { modelId: "agent-model", apiKeyId: "agent-key" },
    },
    {
      name: "organization wins when only it is configured",
      levels: [none, none, none, org],
      availableModels: available,
      expected: { modelId: "org-model", apiKeyId: "org-key" },
    },
    {
      name: "falls back to the best available model when nothing is configured",
      levels: [none, none, none, none],
      availableModels: available,
      expected: { modelId: "best-model", apiKeyId: "key-b" },
    },
    {
      name: "fallback picks the first model when none is marked best",
      levels: [none, none, none, none],
      availableModels: [
        { modelId: "cheap-model", apiKeyId: "key-a" },
        { modelId: "other-model", apiKeyId: "key-b" },
      ],
      expected: { modelId: "cheap-model", apiKeyId: "key-a" },
    },
    {
      name: "returns null when nothing is configured and nothing is available",
      levels: [none, none, none, none],
      availableModels: [],
      expected: null,
    },
    {
      name: "a level with a model but no key is skipped (falls back, no derivation)",
      levels: [{ modelId: "agent-model", apiKeyId: null }],
      availableModels: available,
      expected: { modelId: "best-model", apiKeyId: "key-b" },
    },
    {
      name: "a level with a key but no model is skipped",
      levels: [{ modelId: null, apiKeyId: "lonely-key" }],
      availableModels: available,
      expected: { modelId: "best-model", apiKeyId: "key-b" },
    },
    {
      name: "a half-configured level wins for neither id when nothing is available",
      levels: [{ modelId: "agent-model", apiKeyId: null }],
      availableModels: [],
      expected: null,
    },
    {
      name: "a half-configured level falls through to a lower complete level",
      levels: [{ modelId: "agent-model", apiKeyId: null }, org],
      availableModels: available,
      expected: { modelId: "org-model", apiKeyId: "org-key" },
    },
    {
      name: "a configured model is used as-is even when not in the available list",
      // FK guarantees the row exists; availability is not re-checked here.
      levels: [{ modelId: "pinned-model", apiKeyId: "pinned-key" }],
      availableModels: available,
      expected: { modelId: "pinned-model", apiKeyId: "pinned-key" },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        resolveModelSelection({
          levels: c.levels,
          availableModels: c.availableModels,
        }),
      ).toEqual(c.expected);
    });
  }
});

describe("pickBestModel", () => {
  test("returns undefined for an empty list", () => {
    expect(pickBestModel([])).toBeUndefined();
  });

  test("returns the model marked best", () => {
    const models: RankedModel[] = [
      { modelId: "a", apiKeyId: "k", isBest: false },
      { modelId: "b", apiKeyId: "k", isBest: true },
      { modelId: "c", apiKeyId: "k", isBest: false },
    ];
    expect(pickBestModel(models)).toEqual(models[1]);
  });

  test("returns the first model when none is marked best", () => {
    const models: RankedModel[] = [
      { modelId: "a", apiKeyId: "k" },
      { modelId: "b", apiKeyId: "k" },
    ];
    expect(pickBestModel(models)).toEqual(models[0]);
  });
});

describe("deriveModelSource", () => {
  const cases: Array<{
    name: string;
    selectedModelId: string | null;
    agentModelId: string | null;
    orgModelId: string | null;
    expected: ModelSource | null;
  }> = [
    {
      name: "null when no model is selected",
      selectedModelId: null,
      agentModelId: "a",
      orgModelId: "o",
      expected: null,
    },
    {
      name: "'agent' when the model matches the agent default",
      selectedModelId: "a",
      agentModelId: "a",
      orgModelId: "o",
      expected: "agent",
    },
    {
      name: "'organization' when the model matches the org default",
      selectedModelId: "o",
      agentModelId: null,
      orgModelId: "o",
      expected: "organization",
    },
    {
      name: "'user' when the model matches neither default",
      selectedModelId: "x",
      agentModelId: "a",
      orgModelId: "o",
      expected: "user",
    },
    {
      name: "agent takes precedence over the org default",
      selectedModelId: "same",
      agentModelId: "same",
      orgModelId: "same",
      expected: "agent",
    },
    {
      name: "null when nothing is configured (no default to override)",
      selectedModelId: "x",
      agentModelId: null,
      orgModelId: null,
      expected: null,
    },
    {
      name: "'user' when an org default exists but the model differs",
      selectedModelId: "x",
      agentModelId: null,
      orgModelId: "o",
      expected: "user",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        deriveModelSource({
          selectedModelId: c.selectedModelId,
          agentModelId: c.agentModelId,
          orgModelId: c.orgModelId,
        }),
      ).toBe(c.expected);
    });
  }
});

describe("isFreeModel", () => {
  test("is true only when both prices are known and zero", () => {
    expect(
      isFreeModel({ promptPricePerToken: "0", completionPricePerToken: "0" }),
    ).toBe(true);
    expect(
      isFreeModel({
        promptPricePerToken: "0.000000000000",
        completionPricePerToken: "0",
      }),
    ).toBe(true);
  });

  test("is false for paid, dynamic, or unknown pricing", () => {
    expect(
      isFreeModel({
        promptPricePerToken: "0.0000015",
        completionPricePerToken: "0",
      }),
    ).toBe(false);
    // openrouter/auto reports dynamic pricing as -1.
    expect(
      isFreeModel({ promptPricePerToken: "-1", completionPricePerToken: "-1" }),
    ).toBe(false);
    expect(
      isFreeModel({ promptPricePerToken: null, completionPricePerToken: "0" }),
    ).toBe(false);
  });
});

describe("compareModelsForDisplay", () => {
  test("orders routers, then recommended, then the rest alphabetically", () => {
    const models: DisplayOrderModel[] = [
      { modelId: "zzz/model" },
      { modelId: "aaa/model" },
      { modelId: OPENROUTER_AUTO_MODEL_ID },
      { modelId: "openai/gpt-5.5", isBest: true },
      { modelId: OPENROUTER_FREE_MODEL_ID },
      { modelId: "anthropic/claude", isBest: true },
    ];
    expect(
      [...models].sort(compareModelsForDisplay).map((m) => m.modelId),
    ).toEqual([
      OPENROUTER_FREE_MODEL_ID,
      OPENROUTER_AUTO_MODEL_ID,
      "anthropic/claude",
      "openai/gpt-5.5",
      "aaa/model",
      "zzz/model",
    ]);
  });
});
