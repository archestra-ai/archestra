import { fireEvent, render, screen, within } from "@testing-library/react";
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
          total: 42,
          totalPages: 3,
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

    // Names and sources in the list; the first skill read in full beside it.
    const list = screen.getByRole("list", { name: "Skills" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("Skill library")).toBeVisible();
    expect(within(list).getByText("Research Server · MCP")).toBeVisible();
    expect(within(list).getByText("Writing Plugin · Plugin")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "incident-response" }),
    ).toBeVisible();
    expect(screen.getByText("Respond to incidents")).toBeVisible();
    await userEvent.click(within(list).getByText("research"));
    expect(screen.getByRole("heading", { name: "research" })).toBeVisible();
    expect(screen.getByText("Research a topic")).toBeVisible();
    expect(mockUseAgentActivationSkills).toHaveBeenCalledWith({
      agentId: "agent-1",
      environmentId: "environment-1",
      limit: 20,
      offset: 0,
      search: undefined,
    });

    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(mockUseAgentActivationSkills).toHaveBeenLastCalledWith({
      agentId: "agent-1",
      environmentId: "environment-1",
      limit: 20,
      offset: 20,
      search: undefined,
    });
  });

  it("shows no pager when one page holds every skill", () => {
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
        ],
        pagination: {
          currentPage: 1,
          limit: 20,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
      isPending: false,
      isFetching: false,
      isError: false,
    } as unknown as ReturnType<typeof useAgentActivationSkills>);

    render(<AgentActivationSkillsTable agentId="agent-1" />);
    expect(screen.getByText("1 skill")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
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
    fireEvent.change(screen.getByPlaceholderText("Search skills"), {
      target: { value: "writing" },
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(mockUseAgentActivationSkills).toHaveBeenLastCalledWith({
      agentId: "agent-1",
      environmentId: undefined,
      limit: 20,
      offset: 0,
      search: "writing",
    });

    fireEvent.change(screen.getByPlaceholderText("Search skills"), {
      target: { value: "   " },
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(mockUseAgentActivationSkills).toHaveBeenLastCalledWith({
      agentId: "agent-1",
      environmentId: undefined,
      limit: 20,
      offset: 0,
      search: undefined,
    });
    expect(
      screen.getByText("No skills are available to you in this environment."),
    ).toBeVisible();
  });

  it("keeps the disabled state inside the list frame", () => {
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

    expect(
      screen.getByText("Skills are not enabled for this agent."),
    ).toBeVisible();
  });
});
