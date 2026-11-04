import {
  orderSubagentsByLoadBalancing,
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

const AGENT_A_ID = "00000000-0000-4000-8000-00000000000a";
const AGENT_B_ID = "00000000-0000-4000-8000-00000000000b";

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
      { id: AGENT_A_ID, name: "Lobster Claude", description: null },
      { id: AGENT_B_ID, name: "Lobster Codex", description: null },
    ],
  } as unknown as ReturnType<typeof useAgentOptionsByIds>);
});

describe("SubagentLoadBalancingSection", () => {
  it("enables load balancing with round-robin defaults and toggles off", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSection(null);

    const toggle = screen.getByRole("switch", {
      name: "Enable load balancing",
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    expect(toggle).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      algorithm: "round_robin",
      retries: 1,
      fallbackEnabled: true,
      maxFallbacks: null,
    });

    await user.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: false,
      }),
    );
  });

  it("allows configuring per-subagent weights and retry/fallback policy", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSection({
      enabled: true,
      algorithm: "weighted",
      retries: 1,
      fallbackEnabled: true,
      maxFallbacks: null,
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

    const maxFallbacksInput = screen.getByLabelText(
      "Maximum fallback subagents",
    );
    fireEvent.change(maxFallbacksInput, { target: { value: "2" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maxFallbacks: 2,
      }),
    );

    const fallbackSwitch = screen.getByRole("switch", {
      name: "Fall back to other subagents",
    });
    await user.click(fallbackSwitch);
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
        maxFallbacks: null,
      },
      [],
      { isGateway: false, isAllSubagentsMode: true },
    );

    expect(
      screen.getByText(/subagents assigned to this agent/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /In "All agents" mode, all accessible runtime subagents receive equal weight/i,
      ),
    ).toBeInTheDocument();
  });
});
