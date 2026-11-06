import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_MODEL_TIERS,
  ModelTierPickers,
  type ModelTierSelection,
} from "@/components/model-tier-pickers";
import type { LlmModel } from "@/lib/llm-models.query";
import { llmModelsQueryKey } from "@/lib/llm-models-query-keys";
import { useOrganization } from "@/lib/organization.query";

vi.mock("next/image", () => ({
  default: ({ alt, src }: { alt: string; src: string }) => (
    <img alt={alt} src={src} />
  ),
}));

vi.mock("@/lib/organization.query");

HTMLElement.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useOrganization>);
});

function model(
  id: string,
  displayName: string,
  provider: LlmModel["provider"],
  supportsToolCalling: boolean | null = true,
): LlmModel {
  return {
    id,
    dbId: `db-${id}`,
    displayName,
    provider,
    isFree: false,
    capabilities: {
      contextLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling,
      supportsReasoningEffort: null,
      recommendedForAgents: null,
      pricePerMillionInput: null,
      pricePerMillionOutput: null,
      isCustomPrice: false,
      priceSource: "default",
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      cachePriceSource: "default",
      mediaPricing: null,
    },
  };
}

const CATALOG = [
  model("claude-haiku-5-5", "Claude Haiku 5.5", "anthropic"),
  model("gpt-6-mini", "GPT-6 Mini", "openai"),
  model("gemini-4-pro", "Gemini 4 Pro", "gemini"),
  model("text-only", "Text Only", "openai", false),
];

function renderPickers(value: ModelTierSelection = EMPTY_MODEL_TIERS) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(llmModelsQueryKey(null), CATALOG);
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <ModelTierPickers value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe("ModelTierPickers", () => {
  it("offers tool-capable models of every provider for a tier", async () => {
    const user = userEvent.setup();
    const onChange = renderPickers();

    const [fastPicker] = screen.getAllByRole("combobox");
    await user.click(fastPicker);
    screen.getByRole("option", { name: /Claude Haiku 5.5/ });
    screen.getByRole("option", { name: /Gemini 4 Pro/ });
    expect(
      screen.queryByRole("option", { name: /Text Only/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /GPT-6 Mini/ }));
    expect(onChange).toHaveBeenCalledWith({
      fast: "db-gpt-6-mini",
      smart: null,
    });
  });

  it("keeps a saved model without tool calling selectable to clear it", async () => {
    const user = userEvent.setup();
    renderPickers({ fast: null, smart: "db-text-only" });

    const [, smartPicker] = screen.getAllByRole("combobox");
    await user.click(smartPicker);
    expect(screen.getByRole("option", { name: /Text Only/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
