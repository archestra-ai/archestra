import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  EMPTY_MODEL_TIERS,
  ModelTierPickers,
  type ModelTierSelection,
} from "@/components/model-tier-pickers";
import type { LlmModel } from "@/lib/llm-models.query";

const API_KEY_ID = "key-1";

function model(id: string, displayName: string): LlmModel {
  return {
    id,
    dbId: `db-${id}`,
    displayName,
    provider: "anthropic",
    isFree: false,
  };
}

const KEY_MODELS = [
  model("claude-haiku-5-5", "Claude Haiku 5.5"),
  model("claude-sonnet-5-5", "Claude Sonnet 5.5"),
  model("claude-opus-5-5", "Claude Opus 5.5"),
];

function renderPickers(inherited?: ModelTierSelection) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(["llm-models", API_KEY_ID], KEY_MODELS);
  render(
    <QueryClientProvider client={queryClient}>
      <ModelTierPickers
        apiKeyId={API_KEY_ID}
        provider="anthropic"
        value={EMPTY_MODEL_TIERS}
        onChange={() => {}}
        inherited={inherited}
      />
    </QueryClientProvider>,
  );
}

describe("ModelTierPickers unset label", () => {
  it("names the inherited organization tier when the key serves it", () => {
    renderPickers({ fast: "db-claude-sonnet-5-5", smart: null });

    expect(
      screen.getAllByText("Organization default (Claude Sonnet 5.5)").length,
    ).toBeGreaterThan(0);
    expect(screen.queryAllByText("Default (Claude Haiku 5.5)")).toHaveLength(0);
    expect(
      screen.getAllByText("Default (Claude Opus 5.5)").length,
    ).toBeGreaterThan(0);
  });

  it("falls back to the provider default when the key lacks the inherited tier", () => {
    renderPickers({ fast: "db-not-on-this-key", smart: null });

    expect(
      screen.getAllByText("Default (Claude Haiku 5.5)").length,
    ).toBeGreaterThan(0);
    expect(screen.queryAllByText(/^Organization default/)).toHaveLength(0);
  });
});
