import {
  orderSubagentsByLoadBalancing,
  StoredSubagentLoadBalancingConfigSchema,
  type SubagentLoadBalancingConfig,
  SubagentLoadBalancingConfigSchema,
} from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SubagentLoadBalancingSection } from "./subagent-load-balancing-section";

beforeAll(() => {
  // Radix Select calls pointer-capture and scrollIntoView APIs absent in jsdom.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

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
  render(<Host />);
  return { onChange };
}

describe("SubagentLoadBalancingSection", () => {
  it("selects an algorithm from the Agent Runtime Delegation dropdown and switches back to Direct", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSection(null);

    const select = screen.getByRole("combobox", {
      name: "Agent Runtime Delegation",
    });
    expect(select).toHaveTextContent("Direct");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    await user.click(select);
    expect(screen.getByRole("option", { name: /Direct/ })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Round robin/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Weighted/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Random/ })).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /Round robin/ }));
    expect(select).toHaveTextContent("Round robin");
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      algorithm: "round_robin",
    });

    await user.click(select);
    await user.click(screen.getByRole("option", { name: /Weighted/ }));
    expect(select).toHaveTextContent("Weighted");
    const weightedCall = onChange.mock.calls.at(-1)?.[0];
    expect(weightedCall).toEqual({
      enabled: true,
      algorithm: "weighted",
    });
    expect(
      SubagentLoadBalancingConfigSchema.safeParse(weightedCall).success,
    ).toBe(true);

    await user.click(select);
    await user.click(screen.getByRole("option", { name: /Direct/ }));
    expect(select).toHaveTextContent("Direct");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: false,
      }),
    );
  });

  it("does not render a duplicate agent list or retry/failover controls when Weighted is active with assigned agents", () => {
    renderSection(
      {
        enabled: true,
        algorithm: "weighted",
      },
      [AGENT_A_ID, AGENT_B_ID],
      { isGateway: false },
    );

    expect(screen.queryByText(/Subagent weights/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Retries on same/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: /Fail over/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("orders subagents according to round-robin and weighted policies", () => {
    const ids = [AGENT_A_ID, AGENT_B_ID];

    expect(
      orderSubagentsByLoadBalancing(
        ids,
        {
          enabled: true,
          algorithm: "round_robin",
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
        },
        { random: () => 0.5 },
      ),
    ).toEqual([AGENT_B_ID, AGENT_A_ID]);
  });

  it("renders regular agent copy and All-agents weighted notice without Beta badge", () => {
    renderSection(
      {
        enabled: true,
        algorithm: "weighted",
      },
      [],
      { isGateway: false, isAllSubagentsMode: true },
    );

    expect(screen.getByText("Agent Runtime Delegation")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Load balance Agent Runtime subagents runs or invoke directly.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'In "All agents" mode, every runtime subagent gets weight 1. Switch to Manual mode above to set custom weights.',
      ),
    ).toBeInTheDocument();
  });

  it("renders gateway copy and empty-assignment weighted notice using agent terminology", () => {
    renderSection(
      {
        enabled: true,
        algorithm: "weighted",
      },
      [],
      { isGateway: true, isAllSubagentsMode: false },
    );

    expect(
      screen.getByText(
        "Load balance Agent Runtime agents runs or invoke directly.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Assign agents above to set custom weights."),
    ).toBeInTheDocument();
  });

  it("strips legacy retry and failover fields on read", () => {
    const parsed = StoredSubagentLoadBalancingConfigSchema.parse({
      enabled: true,
      algorithm: "round_robin",
      retries: 5,
      fallbackEnabled: false,
    });
    expect(parsed).toEqual({
      enabled: true,
      algorithm: "round_robin",
    });
  });
});
