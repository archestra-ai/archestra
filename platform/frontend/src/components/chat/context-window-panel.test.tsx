import type { ContextWindowBreakdown } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  ContextWindowDialog,
  ContextWindowPanel,
} from "./context-window-panel";

// useAppName is used inside ContextWindowDialog for the empty-state copy
vi.mock("@/lib/hooks/use-app-name");

beforeEach(() => {
  vi.mocked(useAppName).mockReturnValue("Archestra");
});

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

describe("ContextWindowPanel", () => {
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

  it("gives headroom and the last compaction a block each", () => {
    const { container } = render(
      <ContextWindowPanel
        breakdown={makeBreakdown()}
        lastCompaction={{
          originalTokenEstimate: 50_000,
          compactedTokenEstimate: 12_000,
          trigger: "auto",
        }}
      />,
    );

    // Two separate statements about two separate moments — they must not be
    // crammed into one note, and each must carry its own icon.
    const notes = container.querySelectorAll(".rounded-md.border");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toHaveTextContent(
      "71% of context remaining until auto-compact.",
    );
    expect(notes[1]).toHaveTextContent(
      /Auto-compaction summarized earlier turns/,
    );
    for (const note of notes) {
      expect(note.querySelector("svg")).toBeInTheDocument();
    }
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

describe("ContextWindowDialog — fallback state", () => {
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

// ============================================================================
// ContextWindowDialog — manual compaction
// ============================================================================

describe("ContextWindowDialog — compact action", () => {
  async function openDialog(ui: React.ReactElement) {
    const user = userEvent.setup();
    render(ui);
    await user.click(screen.getByRole("button", { name: "Open" }));
    return user;
  }

  it("offers no compact action when the conversation cannot be compacted", async () => {
    await openDialog(
      <ContextWindowDialog
        breakdown={makeBreakdown()}
        tokensUsed={89_000}
        maxTokens={1_000_000}
      >
        <button type="button">Open</button>
      </ContextWindowDialog>,
    );

    expect(
      screen.queryByRole("button", { name: /compact now/i }),
    ).not.toBeInTheDocument();
  });

  it("compacts on demand", async () => {
    const onCompact = vi.fn();
    const user = await openDialog(
      <ContextWindowDialog
        breakdown={makeBreakdown()}
        tokensUsed={89_000}
        maxTokens={1_000_000}
        onCompact={onCompact}
      >
        <button type="button">Open</button>
      </ContextWindowDialog>,
    );

    await user.click(screen.getByRole("button", { name: /compact now/i }));

    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it("blocks re-entry while a compaction is already running", async () => {
    const onCompact = vi.fn();
    await openDialog(
      <ContextWindowDialog
        breakdown={makeBreakdown()}
        tokensUsed={89_000}
        maxTokens={1_000_000}
        onCompact={onCompact}
        isCompacting
      >
        <button type="button">Open</button>
      </ContextWindowDialog>,
    );

    const button = screen.getByRole("button", { name: /compacting/i });
    expect(button).toBeDisabled();
  });

  it("states headroom to auto-compaction in the same words as the indicator", async () => {
    await openDialog(
      <ContextWindowDialog
        breakdown={makeBreakdown()}
        tokensUsed={89_000}
        maxTokens={1_000_000}
        onCompact={vi.fn()}
      >
        <button type="button">Open</button>
      </ContextWindowDialog>,
    );

    // 8.9% used against an 80% trigger → 71 points of headroom.
    expect(
      screen.getByText("71% of context remaining until auto-compact."),
    ).toBeInTheDocument();
  });

  it("warns that auto-compaction is imminent once past the threshold", async () => {
    await openDialog(
      <ContextWindowDialog
        breakdown={makeBreakdown({
          usedTokens: 850_000,
          freeTokens: 150_000,
          usedPercent: 85,
        })}
        tokensUsed={850_000}
        maxTokens={1_000_000}
        onCompact={vi.fn()}
      >
        <button type="button">Open</button>
      </ContextWindowDialog>,
    );

    expect(
      screen.getByText("Auto-compact runs on your next message."),
    ).toBeInTheDocument();
  });

  it("invents no headroom when the model's window is unknown", async () => {
    await openDialog(
      <ContextWindowDialog
        breakdown={makeBreakdown({ contextLength: null, freeTokens: null })}
        tokensUsed={89_000}
        maxTokens={null}
        onCompact={vi.fn()}
      >
        <button type="button">Open</button>
      </ContextWindowDialog>,
    );

    // No window means no threshold to count down to, so the note that would
    // carry both the sentence and the action has nothing to say and is
    // dropped. The composer cannot reach this state anyway — its context ring
    // only renders once a window is known — and `/compact` still works.
    expect(
      screen.queryByText(/remaining until auto-compact/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /compact now/i }),
    ).not.toBeInTheDocument();
  });
});
