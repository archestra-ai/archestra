import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentActivationSkills } from "@/lib/agent-skills.query";
import { AgentActivationSkillsTable } from "./agent-activation-skills-table";

vi.mock("@/lib/agent-skills.query", () => ({
  useAgentActivationSkills: vi.fn(),
}));

const mockUseAgentActivationSkills = vi.mocked(useAgentActivationSkills);

describe("AgentActivationSkillsTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders every source in a table with its visibility scope", () => {
    mockUseAgentActivationSkills.mockReturnValue({
      data: {
        enabled: true,
        skills: [
          {
            reference: { source: "native", skillId: "skill-1" },
            name: "incident-response",
            activationName: "incident-response",
            description: "Respond to incidents",
            scope: "org",
            providerName: null,
          },
          {
            reference: {
              source: "external_mcp",
              mcpServerId: "server-1",
              uri: "skill://research",
            },
            name: "research",
            activationName: "research",
            description: "Research a topic",
            scope: "team",
            providerName: "Research Server",
          },
          {
            reference: {
              source: "plugin",
              pluginId: "plugin-1",
              skillPath: "skills/writing",
            },
            name: "writing",
            activationName: "writing",
            description: "Write clearly",
            scope: "personal",
            providerName: "Writing Plugin",
          },
        ],
      },
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useAgentActivationSkills>);

    render(
      <AgentActivationSkillsTable
        agentId="agent-1"
        environmentId="environment-1"
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Skill" })).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Source" })).toBeNull();
    expect(
      screen.getByRole("columnheader", { name: "Visibility" }),
    ).toBeVisible();
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText("Skill library")).toBeVisible();
    expect(screen.getByText("Research Server")).toBeVisible();
    expect(screen.getByText("MCP")).toBeVisible();
    expect(screen.getByText("Writing Plugin")).toBeVisible();
    expect(screen.getByText("Organization")).toBeVisible();
    expect(screen.getByText("Team")).toBeVisible();
    expect(screen.getByText("Personal")).toBeVisible();
    expect(mockUseAgentActivationSkills).toHaveBeenCalledWith({
      agentId: "agent-1",
      environmentId: "environment-1",
    });
  });

  it("keeps the disabled state inside the table", () => {
    mockUseAgentActivationSkills.mockReturnValue({
      data: { enabled: false, skills: [] },
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useAgentActivationSkills>);

    render(<AgentActivationSkillsTable environmentId={null} />);

    expect(screen.getByRole("table")).toBeVisible();
    expect(
      screen.getByText("Skills are not enabled for this agent."),
    ).toBeVisible();
  });
});
