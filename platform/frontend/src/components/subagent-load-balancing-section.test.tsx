import {
  orderSubagentsByLoadBalancing,
  StoredSubagentLoadBalancingConfigSchema,
  type SubagentLoadBalancingConfig,
  SubagentLoadBalancingConfigSchema,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";
import { SubagentLoadBalancingSection } from "./subagent-load-balancing-section";

vi.mock("@/lib/agent-options.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

const AGENT_A_ID = "00000000-0000-4000-8000-00000000000a";
const AGENT_B_ID = "00000000-0000-4000-8000-00000000000b";
const AGENT_C_ID = "00000000-0000-4000-8000-00000000000c";

function renderSection(
  initial: SubagentLoadBalancingConfig | null = null,
  selectedAgentIds: string[] = [AGENT_A_ID, AGENT_B_ID],
  extraProps: { isGateway?: boolean; isAllSubagentsMode?: boolean } = {},
) {
  const onChange = vi.fn<(value: SubagentLoadBalancingConfig | null) => void>();
  function Host() {
    const [value, setValue] = useState(initial);
    return (
      <SubagentLoadBalancingSection
        value={value}
        selectedAgentIds={selectedAgentIds}
        isGateway={extraProps.isGateway}
        isAllSubagentsMode={extraProps.isAllSubagentsMode}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
  return { onChange };
}

beforeEach(() => {
  vi.mocked(useAgentOptionsByIds).mockReturnValue({
    data: [
      {
        id: AGENT_A_ID,
        name: "Lobster Claude",
        description: null,
        runtime: {
          image: "ghcr.io/archestra-ai/agent-claude-code:latest",
          command: ["archestra-claude-code"],
        },
      },
      {
        id: AGENT_B_ID,
        name: "Lobster Codex",
        description: null,
        runtime: {
          image: "ghcr.io/archestra-ai/agent-codex:latest",
          command: ["archestra-codex"],
        },
      },
      {
        id: AGENT_C_ID,
        name: "Regular Chat Agent",
        description: null,
        runtime: null,
      },
    ],
  } as unknown as ReturnType<typeof useAgentOptionsByIds>);
});

describe("SubagentLoadBalancingSection", () => {
  it("enables load balancing with round-robin defaults and toggles off", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSection(null);

    const toggle = screen.getByRole("switch", {
      name: "Enable Load Balancing",
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    expect(toggle).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      algorithm: "round_robin",
      retries: 1,
      fallbackEnabled: true,
    });

    await user.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: false,
      }),
    );
  });

  it("allows configuring per-agent weights and retry/failover policy", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSection({
      enabled: true,
      algorithm: "weighted",
      retries: 1,
      fallbackEnabled: true,
    });

    const claudeWeightInput = screen.getByLabelText(
      "Weight for Lobster Claude",
    );
    expect(claudeWeightInput).toHaveValue(1);

    fireEvent.change(claudeWeightInput, { target: { value: "3" } });

    const latest = onChange.mock.calls.at(-1)?.[0];
    expect(latest).toMatchObject({
      enabled: true,
      algorithm: "weighted",
      weights: { [AGENT_A_ID]: 3 },
    });
    expect(SubagentLoadBalancingConfigSchema.safeParse(latest).success).toBe(
      true,
    );

    const failoverSwitch = screen.getByRole("switch", {
      name: "Fail over to other agents",
    });
    await user.click(failoverSwitch);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fallbackEnabled: false,
      }),
    );
  });

  it("orders subagents according to round-robin and weighted policies", () => {
    const ids = [AGENT_A_ID, AGENT_B_ID];

    expect(
      orderSubagentsByLoadBalancing(
        ids,
        {
          enabled: true,
          algorithm: "round_robin",
          retries: 1,
          fallbackEnabled: true,
        },
        { seed: 1 },
      ),
    ).toEqual([AGENT_B_ID, AGENT_A_ID]);

    expect(
      orderSubagentsByLoadBalancing(
        ids,
        {
          enabled: true,
          algorithm: "weighted",
          weights: { [AGENT_A_ID]: 1, [AGENT_B_ID]: 9 },
          retries: 1,
          fallbackEnabled: true,
        },
        { random: () => 0.5 },
      ),
    ).toEqual([AGENT_B_ID, AGENT_A_ID]);
  });

  it("renders regular agent copy and All-agents weighted notice", () => {
    renderSection(
      {
        enabled: true,
        algorithm: "weighted",
        retries: 1,
        fallbackEnabled: true,
      },
      [],
      { isGateway: false, isAllSubagentsMode: true },
    );

    expect(screen.getByText("Load Balancing")).toBeInTheDocument();
    expect(
      screen.getByText(
        "When this agent delegates to Agent Runtime subagents, choose how to split runs and handle failures. Other subagents run directly.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Subagent weights")).toBeInTheDocument();
    expect(
      screen.getByText(
        'In "All agents" mode, every Agent Runtime subagent gets weight 1. Switch to Manual mode above to set custom weights.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Retries on same subagent")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Fail over to other subagents" }),
    ).toBeInTheDocument();
  });

  it("renders gateway copy using agent terminology consistently", () => {
    renderSection(
      {
        enabled: true,
        algorithm: "weighted",
        retries: 1,
        fallbackEnabled: true,
      },
      [],
      { isGateway: true, isAllSubagentsMode: false },
    );

    expect(
      screen.getByText(
        "When clients run Agent Runtime agents through this gateway, choose how to split runs and handle failures. Other agents run directly.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Agent weights")).toBeInTheDocument();
    expect(
      screen.getByText("Assign agents above to set custom weights."),
    ).toBeInTheDocument();
    expect(screen.getByText("Retries on same agent")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Fail over to other agents" }),
    ).toBeInTheDocument();
  });

  it("shows each subagent's runtime chip or No runtime in weighted rows", () => {
    renderSection(
      {
        enabled: true,
        algorithm: "weighted",
        retries: 1,
        fallbackEnabled: true,
      },
      [AGENT_A_ID, AGENT_B_ID, AGENT_C_ID],
      { isGateway: false },
    );

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("No runtime")).toBeInTheDocument();
  });

  it("clamps stored retry counts above 3 on read so UI and supervisor agree", () => {
    const parsed = StoredSubagentLoadBalancingConfigSchema.parse({
      enabled: true,
      algorithm: "round_robin",
      retries: 5,
      fallbackEnabled: true,
    });
    expect(parsed.retries).toBe(3);
  });
});
