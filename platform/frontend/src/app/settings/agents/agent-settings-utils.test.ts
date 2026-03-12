import { describe, expect, it } from "vitest";
import {
  buildSavePayload,
  detectChanges,
  resolveInitialState,
} from "./agent-settings-utils";

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
  it("resolves API key from provider", () => {
    const org = {
      defaultLlmModel: "gpt-4o",
      defaultLlmProvider: "openai",
      defaultAgentId: "agent-1",
    };
    const state = resolveInitialState(org, apiKeys);
    expect(state).toEqual({
      selectedApiKeyId: "key-1",
      defaultModel: "gpt-4o",
      defaultAgentId: "agent-1",
    });
  });

  it("resolves anthropic provider", () => {
    const org = {
      defaultLlmModel: "claude-sonnet-4-20250514",
      defaultLlmProvider: "anthropic",
      defaultAgentId: null,
    };
    const state = resolveInitialState(org, apiKeys);
    expect(state).toEqual({
      selectedApiKeyId: "key-2",
      defaultModel: "claude-sonnet-4-20250514",
      defaultAgentId: "",
    });
  });

  it("handles null/undefined org fields", () => {
    const org = {
      defaultLlmModel: null,
      defaultLlmProvider: null,
      defaultAgentId: null,
    };
    const state = resolveInitialState(org, apiKeys);
    expect(state).toEqual({
      selectedApiKeyId: "",
      defaultModel: "",
      defaultAgentId: "",
    });
  });

  it("handles missing provider in api keys", () => {
    const org = {
      defaultLlmModel: "gpt-4o",
      defaultLlmProvider: "azure",
      defaultAgentId: null,
    };
    const state = resolveInitialState(org, apiKeys);
    expect(state.selectedApiKeyId).toBe("");
  });

  it("prefers exact API key ID over provider-based lookup", () => {
    const org = {
      defaultLlmModel: "claude-haiku-3",
      defaultLlmProvider: "anthropic",
      defaultLlmApiKeyId: "key-3",
      defaultAgentId: null,
    };
    const state = resolveInitialState(org, apiKeys);
    expect(state).toEqual({
      selectedApiKeyId: "key-3",
      defaultModel: "claude-haiku-3",
      defaultAgentId: "",
    });
  });

  it("falls back to provider when API key ID not found", () => {
    const org = {
      defaultLlmModel: "claude-haiku-3",
      defaultLlmProvider: "anthropic",
      defaultLlmApiKeyId: "deleted-key",
      defaultAgentId: null,
    };
    const state = resolveInitialState(org, apiKeys);
    expect(state.selectedApiKeyId).toBe("key-2");
  });

  it("handles empty api keys list", () => {
    const org = {
      defaultLlmModel: "gpt-4o",
      defaultLlmProvider: "openai",
    };
    const state = resolveInitialState(org, []);
    expect(state.selectedApiKeyId).toBe("");
  });
});

describe("detectChanges", () => {
  const saved = {
    selectedApiKeyId: "key-1",
    defaultModel: "gpt-4o",
    defaultAgentId: "agent-1",
  };

  it("detects no changes when state matches saved", () => {
    const result = detectChanges(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o",
        defaultAgentId: "agent-1",
      },
      saved,
    );
    expect(result).toEqual({
      hasModelChanges: false,
      hasAgentChanges: false,
      hasChanges: false,
    });
  });

  it("detects model change", () => {
    const result = detectChanges(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o-mini",
        defaultAgentId: "agent-1",
      },
      saved,
    );
    expect(result).toEqual({
      hasModelChanges: true,
      hasAgentChanges: false,
      hasChanges: true,
    });
  });

  it("detects agent change", () => {
    const result = detectChanges(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o",
        defaultAgentId: "agent-2",
      },
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
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o-mini",
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

  it("treats empty saved state as no changes when local is also empty", () => {
    const result = detectChanges(
      { selectedApiKeyId: "", defaultModel: "", defaultAgentId: "" },
      { selectedApiKeyId: "", defaultModel: "", defaultAgentId: "" },
    );
    expect(result.hasChanges).toBe(false);
  });

  it("detects change when clearing a previously set model", () => {
    const result = detectChanges(
      { selectedApiKeyId: "", defaultModel: "", defaultAgentId: "" },
      { selectedApiKeyId: "key-1", defaultModel: "gpt-4o", defaultAgentId: "" },
    );
    expect(result.hasModelChanges).toBe(true);
    expect(result.hasChanges).toBe(true);
  });

  it("detects API key change even when model name is the same", () => {
    const result = detectChanges(
      {
        selectedApiKeyId: "key-2",
        defaultModel: "gpt-4o",
        defaultAgentId: "agent-1",
      },
      saved,
    );
    expect(result.hasModelChanges).toBe(true);
    expect(result.hasChanges).toBe(true);
  });

  it("detects change between two keys with same provider", () => {
    const savedAnthropic = {
      selectedApiKeyId: "key-2",
      defaultModel: "claude-haiku-3",
      defaultAgentId: "",
    };
    const result = detectChanges(
      {
        selectedApiKeyId: "key-3",
        defaultModel: "claude-haiku-3",
        defaultAgentId: "",
      },
      savedAnthropic,
    );
    expect(result.hasModelChanges).toBe(true);
    expect(result.hasChanges).toBe(true);
  });
});

describe("buildSavePayload", () => {
  it("builds payload with model change only", () => {
    const saved = {
      selectedApiKeyId: "key-1",
      defaultModel: "gpt-4o",
      defaultAgentId: "agent-1",
    };
    const payload = buildSavePayload(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o-mini",
        defaultAgentId: "agent-1",
      },
      saved,
      apiKeys,
    );
    expect(payload).toEqual({
      defaultLlmModel: "gpt-4o-mini",
      defaultLlmProvider: "openai",
      defaultLlmApiKeyId: "key-1",
    });
  });

  it("builds payload with agent change only", () => {
    const saved = {
      selectedApiKeyId: "key-1",
      defaultModel: "gpt-4o",
      defaultAgentId: "agent-1",
    };
    const payload = buildSavePayload(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o",
        defaultAgentId: "agent-2",
      },
      saved,
      apiKeys,
    );
    expect(payload).toEqual({
      defaultAgentId: "agent-2",
    });
  });

  it("builds payload with both changes", () => {
    const saved = {
      selectedApiKeyId: "key-1",
      defaultModel: "gpt-4o",
      defaultAgentId: "agent-1",
    };
    const payload = buildSavePayload(
      {
        selectedApiKeyId: "key-2",
        defaultModel: "claude-sonnet-4-20250514",
        defaultAgentId: "",
      },
      saved,
      apiKeys,
    );
    expect(payload).toEqual({
      defaultLlmModel: "claude-sonnet-4-20250514",
      defaultLlmProvider: "anthropic",
      defaultLlmApiKeyId: "key-2",
      defaultAgentId: null,
    });
  });

  it("builds payload when only API key changes (same model name)", () => {
    const saved = {
      selectedApiKeyId: "key-2",
      defaultModel: "claude-haiku-3",
      defaultAgentId: "",
    };
    const payload = buildSavePayload(
      {
        selectedApiKeyId: "key-3",
        defaultModel: "claude-haiku-3",
        defaultAgentId: "",
      },
      saved,
      apiKeys,
    );
    expect(payload).toEqual({
      defaultLlmModel: "claude-haiku-3",
      defaultLlmProvider: "anthropic",
      defaultLlmApiKeyId: "key-3",
    });
  });

  it("returns empty payload when no changes", () => {
    const saved = {
      selectedApiKeyId: "key-1",
      defaultModel: "gpt-4o",
      defaultAgentId: "agent-1",
    };
    const payload = buildSavePayload(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o",
        defaultAgentId: "agent-1",
      },
      saved,
      apiKeys,
    );
    expect(payload).toEqual({});
  });

  it("sets provider to null when model is cleared", () => {
    const saved = {
      selectedApiKeyId: "key-1",
      defaultModel: "gpt-4o",
      defaultAgentId: "",
    };
    const payload = buildSavePayload(
      { selectedApiKeyId: "key-1", defaultModel: "", defaultAgentId: "" },
      saved,
      apiKeys,
    );
    expect(payload).toEqual({
      defaultLlmModel: null,
      defaultLlmProvider: null,
      defaultLlmApiKeyId: null,
    });
  });

  it("sets defaultAgentId to null when clearing agent", () => {
    const saved = {
      selectedApiKeyId: "key-1",
      defaultModel: "gpt-4o",
      defaultAgentId: "agent-1",
    };
    const payload = buildSavePayload(
      { selectedApiKeyId: "key-1", defaultModel: "gpt-4o", defaultAgentId: "" },
      saved,
      apiKeys,
    );
    expect(payload).toEqual({
      defaultAgentId: null,
    });
  });
});
