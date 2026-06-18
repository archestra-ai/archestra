import type { ContextWindowBreakdown } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ContextWindowDialog,
  ContextWindowPanel,
} from "./context-window-panel";

// useAppName is used inside ContextWindowDialog for the empty-state copy
vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

// ============================================================================
// Fixtures
// ============================================================================

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

// ============================================================================
// ContextWindowPanel — breakdown present
// ============================================================================

describe.skip("ContextWindowPanel", () => {
  it("renders the model name and provider badge", () => {
    render(<ContextWindowPanel breakdown={makeBreakdown()} />);

    expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
  });

  it("renders one gauge row per non-empty segment in canonical order", () => {
    render(<ContextWindowPanel breakdown={makeBreakdown()} />);

    // All four non-empty category labels must be present
    expect(screen.getByText("System prompt")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Messages")).toBeInTheDocument();
    expect(screen.getByText("Tool results")).toBeInTheDocument();
    // Files segment was omitted from the fixture — must not appear
    expect(screen.queryByText("Files")).not.toBeInTheDocument();
  });

  it("renders Free space when contextLength is known", () => {
    render(<ContextWindowPanel breakdown={makeBreakdown()} />);
    expect(screen.getByText("Free space")).toBeInTheDocument();
  });

  it("omits Free space when contextLength is null", () => {
    render(
      <ContextWindowPanel
        breakdown={makeBreakdown({
          contextLength: null,
          freeTokens: null,
          usedPercent: null,
        })}
      />,
    );
    expect(screen.queryByText("Free space")).not.toBeInTheDocument();
  });

  it("formats token counts compactly", () => {
    render(<ContextWindowPanel breakdown={makeBreakdown()} />);

    // messages segment 76_700 → "76.7k"
    expect(screen.getByText("76.7k")).toBeInTheDocument();
    // free space 911_000 → "911.0k"
    expect(screen.getByText("911.0k")).toBeInTheDocument();
  });

  it("shows the estimated per-turn cost when estimatedInputCostUsd is present", () => {
    render(<ContextWindowPanel breakdown={makeBreakdown()} />);
    expect(screen.getByText(/\$0\.12\/turn/)).toBeInTheDocument();
  });

  it("omits the cost row when estimatedInputCostUsd is null", () => {
    render(
      <ContextWindowPanel
        breakdown={makeBreakdown({ estimatedInputCostUsd: null })}
      />,
    );
    expect(screen.queryByText(/\/turn/)).not.toBeInTheDocument();
  });

  it("omits the percentage block when usedPercent is null", () => {
    render(
      <ContextWindowPanel
        breakdown={makeBreakdown({ contextLength: null, usedPercent: null })}
      />,
    );
    expect(screen.queryByText("used")).not.toBeInTheDocument();
  });

  it("shows 'Auto-compaction' note when trigger is 'auto'", () => {
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
    expect(screen.queryByText(/^Compaction /)).not.toBeInTheDocument();
    // 50_000 - 12_000 = 38_000 → "38.0k"
    expect(screen.getByText(/38\.0k tokens/)).toBeInTheDocument();
  });

  it("shows 'Compaction' (not 'Auto-compaction') note when trigger is 'manual'", () => {
    render(
      <ContextWindowPanel
        breakdown={makeBreakdown()}
        lastCompaction={{
          originalTokenEstimate: 50_000,
          compactedTokenEstimate: 12_000,
          trigger: "manual",
        }}
      />,
    );

    // Must start with "Compaction" not "Auto-compaction"
    expect(screen.getByText(/^Compaction /)).toBeInTheDocument();
    expect(screen.queryByText(/Auto-compaction/)).not.toBeInTheDocument();
    expect(screen.getByText(/38\.0k tokens/)).toBeInTheDocument();
  });

  it("defaults to 'Auto-compaction' copy when trigger is undefined", () => {
    render(
      <ContextWindowPanel
        breakdown={makeBreakdown()}
        lastCompaction={{
          originalTokenEstimate: 50_000,
          compactedTokenEstimate: 12_000,
        }}
      />,
    );

    expect(screen.getByText(/Auto-compaction/)).toBeInTheDocument();
  });

  it("hides the compaction note when no tokens were freed", () => {
    render(
      <ContextWindowPanel breakdown={makeBreakdown()} lastCompaction={null} />,
    );
    expect(screen.queryByText(/Auto-compaction/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Compaction /)).not.toBeInTheDocument();
  });

  it("hides the compaction note when compacted estimate equals original", () => {
    render(
      <ContextWindowPanel
        breakdown={makeBreakdown()}
        lastCompaction={{
          originalTokenEstimate: 30_000,
          compactedTokenEstimate: 30_000,
        }}
      />,
    );
    expect(screen.queryByText(/Auto-compaction/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Compaction /)).not.toBeInTheDocument();
  });

  it("renders the estimate footnote", () => {
    render(<ContextWindowPanel breakdown={makeBreakdown()} />);
    expect(screen.getByText(/Estimated before sending/)).toBeInTheDocument();
  });

  it("drill-down expands to show top contributors when clicked", async () => {
    const user = userEvent.setup();
    render(<ContextWindowPanel breakdown={makeBreakdown()} />);

    // Contributors are not yet visible
    expect(screen.queryByText("search_knowledge_base")).not.toBeInTheDocument();

    // Click the Tools collapsible trigger
    await user.click(
      screen.getByRole("button", {
        name: /Tools.*expand to see top contributors/i,
      }),
    );

    expect(screen.getByText("search_knowledge_base")).toBeInTheDocument();
    expect(screen.getByText("list_agents")).toBeInTheDocument();
  });

  it("drill-down collapses again on second click", async () => {
    const user = userEvent.setup();
    render(<ContextWindowPanel breakdown={makeBreakdown()} />);

    const trigger = screen.getByRole("button", {
      name: /Tools.*expand to see top contributors/i,
    });
    await user.click(trigger);
    expect(screen.getByText("search_knowledge_base")).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.queryByText("search_knowledge_base")).not.toBeInTheDocument();
  });
});

// ============================================================================
// ContextWindowDialog — empty / loading state
// ============================================================================

describe.skip("ContextWindowDialog — fallback state", () => {
  it("shows a seed view with token counts when breakdown is null but tokens are known", async () => {
    const user = userEvent.setup();
    render(
      <ContextWindowDialog
        breakdown={null}
        tokensUsed={42_000}
        maxTokens={200_000}
      >
        <button type="button">Open</button>
      </ContextWindowDialog>,
    );

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.getByText(/42\.0k/)).toBeInTheDocument();
    expect(screen.getByText(/200\.0k/)).toBeInTheDocument();
    expect(
      screen.getByText(/Send a message to see the full per-category breakdown/),
    ).toBeInTheDocument();
  });

  it("shows a generic invite when no token data is available", async () => {
    const user = userEvent.setup();
    render(
      <ContextWindowDialog breakdown={null} tokensUsed={0} maxTokens={null}>
        <button type="button">Open</button>
      </ContextWindowDialog>,
    );

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(
      screen.getByText(/Send a message to see how Archestra fills/),
    ).toBeInTheDocument();
  });

  it("renders the full panel when a breakdown is provided", async () => {
    const user = userEvent.setup();
    render(
      <ContextWindowDialog
        breakdown={makeBreakdown()}
        tokensUsed={89_000}
        maxTokens={1_000_000}
      >
        <button type="button">Open</button>
      </ContextWindowDialog>,
    );

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
    expect(screen.getByText("Messages")).toBeInTheDocument();
  });
});
