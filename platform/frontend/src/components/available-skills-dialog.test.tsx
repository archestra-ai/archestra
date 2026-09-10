import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentActivationSkills } from "@/lib/agent-skills.query";
import { useSkillsPaginated } from "@/lib/skills/skill.query";
import { AvailableSkillsDialog } from "./available-skills-dialog";

vi.mock("@/lib/agent-skills.query", () => ({
  useAgentActivationSkills: vi.fn(),
}));
vi.mock("@/lib/skills/skill.query", () => ({
  useSkillsPaginated: vi.fn(),
}));
vi.mock("@/components/agent-activation-skills-table", () => ({
  AgentActivationSkillsTable: () => <div>agent skills table</div>,
}));
vi.mock("@/components/gateway-published-skills-table", () => ({
  GatewayPublishedSkillsTable: () => <div>gateway skills table</div>,
}));

describe("AvailableSkillsDialog", () => {
  beforeEach(() => {
    vi.mocked(useAgentActivationSkills).mockReturnValue({
      data: { pagination: { total: 2 } },
    } as never);
    vi.mocked(useSkillsPaginated).mockReturnValue({
      data: { pagination: { total: 3 } },
    } as never);
  });

  it("uses the same discovery copy for an internal agent", async () => {
    const user = userEvent.setup();
    render(
      <AvailableSkillsDialog
        source={{ kind: "agent", agentId: "agent-1", environmentId: "env-1" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "View all 2 skills" }));
    expect(
      screen.getByRole("heading", { name: "Skills available in All mode" }),
    ).toBeVisible();
    expect(screen.getByText("agent skills table")).toBeVisible();
    expect(useAgentActivationSkills).toHaveBeenCalledWith({
      agentId: "agent-1",
      environmentId: "env-1",
      limit: 1,
      offset: 0,
      view: "eligible",
      enabled: true,
    });
  });

  it("uses the saved gateway's eligible count and table", async () => {
    const user = userEvent.setup();
    render(
      <AvailableSkillsDialog
        source={{
          kind: "gateway",
          gatewayId: "gateway-1",
          environmentId: "env-1",
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "View all 3 skills" }));
    expect(
      screen.getByRole("heading", { name: "Skills available in All mode" }),
    ).toBeVisible();
    expect(screen.getByText("gateway skills table")).toBeVisible();
    expect(useSkillsPaginated).toHaveBeenCalledWith(
      {
        forAgentId: "gateway-1",
        mcpGatewayEnvironment: "env-1",
        limit: 1,
        offset: 0,
        sortBy: "name",
        sortDirection: "asc",
        agentSkillView: "eligible",
      },
      { enabled: true, toastOnError: false },
    );
  });

  it("previews the selected environment for a draft gateway", () => {
    render(
      <AvailableSkillsDialog
        source={{ kind: "gateway", environmentId: "env-1" }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "View all 3 skills" }),
    ).toBeVisible();
    expect(useSkillsPaginated).toHaveBeenCalledWith(
      {
        forAgentId: undefined,
        mcpGatewayEnvironment: "env-1",
        limit: 1,
        offset: 0,
        sortBy: "name",
        sortDirection: "asc",
        agentSkillView: "eligible",
      },
      { enabled: true, toastOnError: false },
    );
  });
});
