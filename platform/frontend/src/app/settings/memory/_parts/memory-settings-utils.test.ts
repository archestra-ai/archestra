import { describe, expect, it } from "vitest";
import {
  buildSavePayload,
  detectChanges,
  resolveInitialState,
  type MemorySettingsState,
} from "./memory-settings-utils";

describe("memory-settings-utils", () => {
  it("maps memoryExtractorPrompt in resolveInitialState", () => {
    const state = resolveInitialState({
      memoryExtractorPrompt: "Use concise extraction wording.",
    });

    expect(state.memoryExtractorPrompt).toBe("Use concise extraction wording.");
  });

  it("does not include prompt changes in buildSavePayload", () => {
    const saved = resolveInitialState({
      memoryExtractionEnabled: true,
      memoryInjectionEnabled: true,
      memoryIdleDelaySeconds: 300,
      memoryExtractorMaxTokens: 800,
      memoryExtractorModel: "gpt-4.1-mini",
      memoryExtractorPrompt: null,
      memoryExtractorChatApiKeyId: null,
      memoryInjectionTokenBudget: 600,
      memoryInjectionTopK: 10,
      memoryTombstoneTtlDays: 90,
      memoryCandidateTtlDays: 30,
      memoryMaxContentLength: 500,
      memoryMaxCandidatesPerExtraction: 5,
    });

    const current: MemorySettingsState = {
      ...saved,
      memoryExtractorPrompt: "Prioritize durable preferences.",
    };

    expect(buildSavePayload(current, saved)).toEqual({});
  });

  it("does not treat prompt-only changes as dirty state", () => {
    const saved: MemorySettingsState = {
      ...resolveInitialState({}),
      memoryExtractorPrompt: "Keep long-lived facts only.",
    };

    const current: MemorySettingsState = {
      ...saved,
      memoryExtractorPrompt: "   ",
    };

    expect(buildSavePayload(current, saved)).toEqual({});
    expect(detectChanges(current, saved)).toBe(false);
  });
});
