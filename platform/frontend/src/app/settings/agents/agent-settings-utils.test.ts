// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ModelTierSelection } from "@/components/model-tier-pickers";
import {
  buildSavePayload,
  detectChanges,
  resolveInitialState,
} from "./agent-settings-utils";

const NO_TIERS: ModelTierSelection = { fast: null, smart: null };

const apiKeys = [
  { id: "key-1", provider: "openai", name: "OpenAI Key", scope: "org" },
  {
    id: "key-2",
    provider: "anthropic",
    name: "Anthropic Key",
    scope: "org",
  },
  {
    id: "key-3",
    provider: "anthropic",
    name: "Anthropic Key 2",
    scope: "org",
  },
];

describe("resolveInitialState", () => {
  it("resolves the API key and model from the org defaults", () => {
    const org = {
      defaultModelId: "model-uuid-1",
      defaultLlmApiKeyId: "key-1",
      defaultAgentId: "agent-1",
    };
    const state = resolveInitialState(org, apiKeys);
    expect(state).toEqual({
      selectedApiKeyId: "key-1",
      defaultModel: "model-uuid-1",
      tiers: { fast: null, smart: null },
      defaultAgentId: "agent-1",
    });
  });

  it("resolves the fast and smart tiers from the org defaults", () => {
    const state = resolveInitialState(
      {
        defaultModelId: "model-uuid-1",
        defaultLlmApiKeyId: "key-1",
        defaultFastModelId: "model-uuid-fast",
        defaultSmartModelId: null,
      },
      apiKeys,
    );
    expect(state.tiers).toEqual({ fast: "model-uuid-fast", smart: null });
  });

  it("handles null/undefined org fields", () => {
    const org = {
      defaultModelId: null,
      defaultLlmApiKeyId: null,
      defaultAgentId: null,
    };
    const state = resolveInitialState(org, apiKeys);
    expect(state).toEqual({
      selectedApiKeyId: "",
      defaultModel: "",
      tiers: { fast: null, smart: null },
      defaultAgentId: "",
    });
  });

  it("leaves the API key empty when the configured key was deleted", () => {
    const org = {
      defaultModelId: "model-uuid-1",
      defaultLlmApiKeyId: "deleted-key",
      defaultAgentId: null,
    };
    const state = resolveInitialState(org, apiKeys);
    expect(state.selectedApiKeyId).toBe("");
  });

  it("handles an empty api keys list", () => {
    const org = {
      defaultModelId: "model-uuid-1",
      defaultLlmApiKeyId: "key-1",
    };
    const state = resolveInitialState(org, []);
    expect(state.selectedApiKeyId).toBe("");
  });
});

describe("detectChanges", () => {
  const saved = {
    selectedApiKeyId: "key-1",
    defaultModel: "model-uuid-a",
    tiers: NO_TIERS,
    defaultAgentId: "agent-1",
  };

  it("detects no changes when state matches saved", () => {
    const result = detectChanges({ ...saved }, saved);
    expect(result).toEqual({
      hasModelChanges: false,
      hasAgentChanges: false,
      hasChanges: false,
    });
  });

  it("detects model change", () => {
    const result = detectChanges(
      { ...saved, defaultModel: "model-uuid-b" },
      saved,
    );
    expect(result).toEqual({
      hasModelChanges: true,
      hasAgentChanges: false,
      hasChanges: true,
    });
  });

  it("detects a tier change as a model change", () => {
    const result = detectChanges(
      { ...saved, tiers: { fast: "model-uuid-fast", smart: null } },
      saved,
    );
    expect(result.hasModelChanges).toBe(true);
    expect(result.hasChanges).toBe(true);
  });

  it("detects agent change", () => {
    const result = detectChanges(
      { ...saved, defaultAgentId: "agent-2" },
      saved,
    );
    expect(result).toEqual({
      hasModelChanges: false,
      hasAgentChanges: true,
      hasChanges: true,
    });
  });

  it("detects both model and agent changes", () => {
    const result = detectChanges(
      {
        ...saved,
        defaultModel: "model-uuid-b",
        tiers: NO_TIERS,
        defaultAgentId: "agent-2",
      },
      saved,
    );
    expect(result).toEqual({
      hasModelChanges: true,
      hasAgentChanges: true,
      hasChanges: true,
    });
  });

  it("detects change when clearing a previously set model", () => {
    const result = detectChanges(
      {
        selectedApiKeyId: "",
        defaultModel: "",
        tiers: NO_TIERS,
        defaultAgentId: "",
      },
      {
        selectedApiKeyId: "key-1",
        defaultModel: "model-uuid-a",
        tiers: NO_TIERS,
        defaultAgentId: "",
      },
    );
    expect(result.hasModelChanges).toBe(true);
    expect(result.hasChanges).toBe(true);
  });

  it("detects an API key change even when the model is the same", () => {
    const result = detectChanges(
      { ...saved, selectedApiKeyId: "key-2" },
      saved,
    );
    expect(result.hasModelChanges).toBe(true);
    expect(result.hasChanges).toBe(true);
  });
});

describe("buildSavePayload", () => {
  const saved = {
    selectedApiKeyId: "key-1",
    defaultModel: "model-uuid-a",
    tiers: NO_TIERS,
    defaultAgentId: "agent-1",
  };

  it("sends the model and key together on a model change", () => {
    const payload = buildSavePayload(
      { ...saved, selectedApiKeyId: "key-2", defaultModel: "model-uuid-b" },
      saved,
    );
    expect(payload).toEqual({
      defaultModelId: "model-uuid-b",
      defaultLlmApiKeyId: "key-2",
      defaultFastModelId: null,
      defaultSmartModelId: null,
    });
  });

  it("sends the whole trio with its key on a tier change", () => {
    const payload = buildSavePayload(
      {
        ...saved,
        tiers: { fast: "model-uuid-fast", smart: "model-uuid-smart" },
      },
      saved,
    );
    expect(payload).toEqual({
      defaultModelId: "model-uuid-a",
      defaultLlmApiKeyId: "key-1",
      defaultFastModelId: "model-uuid-fast",
      defaultSmartModelId: "model-uuid-smart",
    });
  });

  it("clears the tiers together with an incomplete model selection", () => {
    const payload = buildSavePayload(
      {
        ...saved,
        defaultModel: "",
        tiers: { fast: "model-uuid-fast", smart: null },
      },
      saved,
    );
    expect(payload).toEqual({
      defaultModelId: null,
      defaultLlmApiKeyId: null,
      defaultFastModelId: null,
      defaultSmartModelId: null,
    });
  });

  it("builds payload with agent change only", () => {
    const payload = buildSavePayload(
      { ...saved, defaultAgentId: "agent-2" },
      saved,
    );
    expect(payload).toEqual({ defaultAgentId: "agent-2" });
  });

  it("builds payload with both model and agent changes", () => {
    const payload = buildSavePayload(
      {
        selectedApiKeyId: "key-2",
        defaultModel: "model-uuid-b",
        tiers: NO_TIERS,
        defaultAgentId: "",
      },
      saved,
    );
    expect(payload).toEqual({
      defaultModelId: "model-uuid-b",
      defaultLlmApiKeyId: "key-2",
      defaultFastModelId: null,
      defaultSmartModelId: null,
      defaultAgentId: null,
    });
  });

  it("returns an empty payload when nothing changed", () => {
    const payload = buildSavePayload({ ...saved }, saved);
    expect(payload).toEqual({});
  });

  it("clears both the model and key when the model is cleared", () => {
    const payload = buildSavePayload(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "",
        tiers: NO_TIERS,
        defaultAgentId: "",
      },
      {
        selectedApiKeyId: "key-1",
        defaultModel: "model-uuid-a",
        tiers: NO_TIERS,
        defaultAgentId: "",
      },
    );
    expect(payload).toEqual({
      defaultModelId: null,
      defaultLlmApiKeyId: null,
      defaultFastModelId: null,
      defaultSmartModelId: null,
    });
  });

  it("clears both when only a key is set without a model", () => {
    const payload = buildSavePayload(
      {
        selectedApiKeyId: "key-2",
        defaultModel: "",
        tiers: NO_TIERS,
        defaultAgentId: "",
      },
      {
        selectedApiKeyId: "key-1",
        defaultModel: "model-uuid-a",
        tiers: NO_TIERS,
        defaultAgentId: "",
      },
    );
    expect(payload).toEqual({
      defaultModelId: null,
      defaultLlmApiKeyId: null,
      defaultFastModelId: null,
      defaultSmartModelId: null,
    });
  });

  it("sets defaultAgentId to null when clearing the agent", () => {
    const payload = buildSavePayload({ ...saved, defaultAgentId: "" }, saved);
    expect(payload).toEqual({ defaultAgentId: null });
  });
});
