import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentAccessBadges, AgentLastUsedFooter } from "./agent-card-meta";

const tool = () => ({ delegateToAgentId: null });
const subagent = (id: string) => ({ delegateToAgentId: id });

function renderBadges(
  agent: React.ComponentProps<typeof AgentAccessBadges>["agent"],
) {
  return render(<AgentAccessBadges agent={agent} />);
}

describe("AgentAccessBadges", () => {
  it("names the Auto-mode set instead of counting rows that aren't there", () => {
    // An Auto-mode agent reaches its whole catalogue while storing no per-tool
    // rows, so counting them would advertise "0 tools" for the agent with the
    // most access.
    renderBadges({
      accessAllTools: true,
      accessAllSubagents: true,
      tools: [],
    });

    expect(screen.getByText("All tools")).toBeInTheDocument();
    expect(screen.getByText("All subagents")).toBeInTheDocument();
  });

  it("splits delegation rows out of the tool count", () => {
    // Both live in `tools`; only the ones carrying a delegate target are
    // subagents, and counting the array twice would double-count them.
    renderBadges({
      accessAllTools: false,
      accessAllSubagents: false,
      tools: [tool(), tool(), tool(), subagent("a"), subagent("b")],
    });

    expect(screen.getByText("3 tools")).toBeInTheDocument();
    expect(screen.getByText("2 subagents")).toBeInTheDocument();
  });

  it("counts an empty set as zero rather than hiding the badge", () => {
    renderBadges({
      accessAllTools: false,
      accessAllSubagents: false,
      tools: [],
    });

    expect(screen.getByText("0 tools")).toBeInTheDocument();
    expect(screen.getByText("0 subagents")).toBeInTheDocument();
  });

  it("says one tool, not 1 tools", () => {
    renderBadges({
      accessAllTools: false,
      accessAllSubagents: false,
      tools: [tool(), subagent("a")],
    });

    expect(screen.getByText("1 tool")).toBeInTheDocument();
    expect(screen.getByText("1 subagent")).toBeInTheDocument();
  });

  it("can name one set and count the other", () => {
    // The two modes are independent settings; a gateway commonly exposes every
    // tool while delegating to a hand-picked few agents.
    renderBadges({
      accessAllTools: true,
      accessAllSubagents: false,
      tools: [subagent("a")],
    });

    expect(screen.getByText("All tools")).toBeInTheDocument();
    expect(screen.getByText("1 subagent")).toBeInTheDocument();
  });
});

describe("AgentLastUsedFooter", () => {
  it("reads as a sentence when the agent was never used", () => {
    // The shared date helper capitalises its default, which reads as "Last
    // used Never" mid-sentence.
    render(<AgentLastUsedFooter lastUsedAt={null} />);

    expect(screen.getByText(/Last used never/)).toBeInTheDocument();
  });

  it("reports how long ago the agent was last used", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    render(<AgentLastUsedFooter lastUsedAt={twoHoursAgo.toISOString()} />);

    expect(screen.getByText(/Last used about 2 hours ago/)).toBeInTheDocument();
  });
});
