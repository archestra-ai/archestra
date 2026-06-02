import type { ContextWindowBreakdown } from "@shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextWindowPanel } from "./context-window-panel";

function makeBreakdown(
  overrides: Partial<ContextWindowBreakdown> = {},
): ContextWindowBreakdown {
  return {
    provider: "anthropic",
    model: "claude-opus-4-8",
    contextLength: 1_000_000,
    usedTokens: 89_000,
    freeTokens: 911_000,
    usedPercent: 8.9,
    estimatedInputCostUsd: 0.12,
    segments: [
      { category: "system_prompt", tokens: 3_000 },
      {
        category: "tools",
        tokens: 6_100,
        items: [
          { label: "search_knowledge_base", tokens: 4_000 },
          { label: "list_agents", tokens: 2_100 },
        ],
      },
      { category: "messages", tokens: 76_700 },
      { category: "tool_results", tokens: 3_200 },
    ],
    ...overrides,
  };
}

describe("ContextWindowPanel", () => {
  it("renders the model, provider, every category label, and free space", () => {
    render(<ContextWindowPanel breakdown={makeBreakdown()} />);

    expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getByText("System prompt")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Messages")).toBeInTheDocument();
    expect(screen.getByText("Tool results")).toBeInTheDocument();
    expect(screen.getByText("Free space")).toBeInTheDocument();
  });

  it("formats token counts compactly", () => {
    render(<ContextWindowPanel breakdown={makeBreakdown()} />);

    // messages segment: 76_700 -> "76.7k"
    expect(screen.getByText("76.7k")).toBeInTheDocument();
    // free space: 911_000 -> "911.0k"
    expect(screen.getByText("911.0k")).toBeInTheDocument();
  });

  it("shows the estimated per-turn cost", () => {
    render(<ContextWindowPanel breakdown={makeBreakdown()} />);
    expect(screen.getByText(/\$0\.12\/turn/)).toBeInTheDocument();
  });

  it("renders a compaction marker when tokens were freed", () => {
    render(
      <ContextWindowPanel
        breakdown={makeBreakdown()}
        lastCompaction={{
          originalTokenEstimate: 50_000,
          compactedTokenEstimate: 12_000,
          trigger: "auto",
        }}
      />,
    );

    expect(screen.getByText(/Auto-compaction/)).toBeInTheDocument();
    // 50_000 - 12_000 = 38_000 -> "38.0k"
    expect(screen.getByText(/38\.0k tokens/)).toBeInTheDocument();
  });

  it("omits free space and percentages when context length is unknown", () => {
    render(
      <ContextWindowPanel
        breakdown={makeBreakdown({
          contextLength: null,
          freeTokens: null,
          usedPercent: null,
          estimatedInputCostUsd: null,
        })}
      />,
    );

    expect(screen.queryByText("Free space")).not.toBeInTheDocument();
    expect(screen.getByText("Messages")).toBeInTheDocument();
  });
});
