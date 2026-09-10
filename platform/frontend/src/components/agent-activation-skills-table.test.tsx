import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentActivationSkills } from "@/lib/agent-skills.query";
import { AgentActivationSkillsTable } from "./agent-activation-skills-table";

vi.mock("next/navigation");
vi.mock("@/lib/agent-skills.query", () => ({
  useAgentActivationSkills: vi.fn(),
}));

const mockUseAgentActivationSkills = vi.mocked(useAgentActivationSkills);

describe("AgentActivationSkillsTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
    vi.mocked(usePathname).mockReturnValue("/agents/agent-1");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the current page and requests the next one", async () => {
    mockUseAgentActivationSkills.mockReturnValue({
      data: {
        enabled: true,
        data: [
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
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 12,
          totalPages: 2,
          hasNext: true,
          hasPrev: false,
        },
      },
      isPending: false,
      isFetching: false,
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
      limit: 10,
      offset: 0,
      search: undefined,
    });

    await userEvent.click(
      screen.getAllByRole("button", { name: "Go to next page" })[0],
    );
    expect(mockUseAgentActivationSkills).toHaveBeenLastCalledWith({
      agentId: "agent-1",
      environmentId: "environment-1",
      limit: 10,
      offset: 10,
      search: undefined,
    });
  });

  it("searches the full catalog and resets pagination", async () => {
    vi.useFakeTimers();
    mockUseAgentActivationSkills.mockReturnValue({
      data: {
        enabled: true,
        data: [],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
      isPending: false,
      isFetching: false,
      isError: false,
    } as unknown as ReturnType<typeof useAgentActivationSkills>);

    render(<AgentActivationSkillsTable agentId="agent-1" />);
    fireEvent.change(
      screen.getByPlaceholderText(
        "Search skills by name, description, and provider",
      ),
      { target: { value: "writing" } },
    );
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(mockUseAgentActivationSkills).toHaveBeenLastCalledWith({
      agentId: "agent-1",
      environmentId: undefined,
      limit: 10,
      offset: 0,
      search: "writing",
    });

    fireEvent.change(
      screen.getByPlaceholderText(
        "Search skills by name, description, and provider",
      ),
      { target: { value: "   " } },
    );
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(mockUseAgentActivationSkills).toHaveBeenLastCalledWith({
      agentId: "agent-1",
      environmentId: undefined,
      limit: 10,
      offset: 0,
      search: undefined,
    });
    expect(
      screen.getByText("No skills are available to you in this environment."),
    ).toBeVisible();
  });

  it("keeps the disabled state inside the table", () => {
    mockUseAgentActivationSkills.mockReturnValue({
      data: {
        enabled: false,
        data: [],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
      isPending: false,
      isFetching: false,
      isError: false,
    } as unknown as ReturnType<typeof useAgentActivationSkills>);

    render(<AgentActivationSkillsTable environmentId={null} />);

    expect(screen.getByRole("table")).toBeVisible();
    expect(
      screen.getByText("Skills are not enabled for this agent."),
    ).toBeVisible();
  });
});
