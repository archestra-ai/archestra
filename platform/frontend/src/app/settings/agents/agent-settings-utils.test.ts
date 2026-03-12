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
  it("detects no changes when state matches server", () => {
    const org = { defaultLlmModel: "gpt-4o", defaultAgentId: "agent-1" };
    const result = detectChanges(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o",
        defaultAgentId: "agent-1",
      },
      org,
    );
    expect(result).toEqual({
      hasModelChanges: false,
      hasAgentChanges: false,
      hasChanges: false,
    });
  });

  it("detects model change", () => {
    const org = { defaultLlmModel: "gpt-4o", defaultAgentId: "agent-1" };
    const result = detectChanges(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o-mini",
        defaultAgentId: "agent-1",
      },
      org,
    );
    expect(result).toEqual({
      hasModelChanges: true,
      hasAgentChanges: false,
      hasChanges: true,
    });
  });

  it("detects agent change", () => {
    const org = { defaultLlmModel: "gpt-4o", defaultAgentId: "agent-1" };
    const result = detectChanges(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o",
        defaultAgentId: "agent-2",
      },
      org,
    );
    expect(result).toEqual({
      hasModelChanges: false,
      hasAgentChanges: true,
      hasChanges: true,
    });
  });

  it("detects both model and agent changes", () => {
    const org = { defaultLlmModel: "gpt-4o", defaultAgentId: "agent-1" };
    const result = detectChanges(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o-mini",
        defaultAgentId: "agent-2",
      },
      org,
    );
    expect(result).toEqual({
      hasModelChanges: true,
      hasAgentChanges: true,
      hasChanges: true,
    });
  });

  it("treats null server model as empty string", () => {
    const org = { defaultLlmModel: null, defaultAgentId: null };
    const result = detectChanges(
      { selectedApiKeyId: "", defaultModel: "", defaultAgentId: "" },
      org,
    );
    expect(result.hasChanges).toBe(false);
  });

  it("detects change when clearing a previously set model", () => {
    const org = { defaultLlmModel: "gpt-4o", defaultAgentId: null };
    const result = detectChanges(
      { selectedApiKeyId: "", defaultModel: "", defaultAgentId: "" },
      org,
    );
    expect(result.hasModelChanges).toBe(true);
    expect(result.hasChanges).toBe(true);
  });
});

describe("buildSavePayload", () => {
  it("builds payload with model change only", () => {
    const org = { defaultLlmModel: "gpt-4o", defaultAgentId: "agent-1" };
    const payload = buildSavePayload(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o-mini",
        defaultAgentId: "agent-1",
      },
      org,
      apiKeys,
    );
    expect(payload).toEqual({
      defaultLlmModel: "gpt-4o-mini",
      defaultLlmProvider: "openai",
    });
  });

  it("builds payload with agent change only", () => {
    const org = { defaultLlmModel: "gpt-4o", defaultAgentId: "agent-1" };
    const payload = buildSavePayload(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o",
        defaultAgentId: "agent-2",
      },
      org,
      apiKeys,
    );
    expect(payload).toEqual({
      defaultAgentId: "agent-2",
    });
  });

  it("builds payload with both changes", () => {
    const org = { defaultLlmModel: "gpt-4o", defaultAgentId: "agent-1" };
    const payload = buildSavePayload(
      {
        selectedApiKeyId: "key-2",
        defaultModel: "claude-sonnet-4-20250514",
        defaultAgentId: "",
      },
      org,
      apiKeys,
    );
    expect(payload).toEqual({
      defaultLlmModel: "claude-sonnet-4-20250514",
      defaultLlmProvider: "anthropic",
      defaultAgentId: null,
    });
  });

  it("returns empty payload when no changes", () => {
    const org = { defaultLlmModel: "gpt-4o", defaultAgentId: "agent-1" };
    const payload = buildSavePayload(
      {
        selectedApiKeyId: "key-1",
        defaultModel: "gpt-4o",
        defaultAgentId: "agent-1",
      },
      org,
      apiKeys,
    );
    expect(payload).toEqual({});
  });

  it("sets provider to null when model is cleared", () => {
    const org = { defaultLlmModel: "gpt-4o", defaultAgentId: null };
    const payload = buildSavePayload(
      { selectedApiKeyId: "key-1", defaultModel: "", defaultAgentId: "" },
      org,
      apiKeys,
    );
    expect(payload).toEqual({
      defaultLlmModel: null,
      defaultLlmProvider: null,
    });
  });

  it("sets defaultAgentId to null when clearing agent", () => {
    const org = { defaultLlmModel: "gpt-4o", defaultAgentId: "agent-1" };
    const payload = buildSavePayload(
      { selectedApiKeyId: "key-1", defaultModel: "gpt-4o", defaultAgentId: "" },
      org,
      apiKeys,
    );
    expect(payload).toEqual({
      defaultAgentId: null,
    });
  });
});
