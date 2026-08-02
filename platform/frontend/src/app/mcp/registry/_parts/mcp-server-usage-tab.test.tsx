import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { McpServerUsageTab } from "./mcp-server-usage-tab";

type ServerArg = Parameters<
  typeof McpServerUsageTab
>[0]["serversForCatalog"][number];

const agent = (
  overrides: Partial<{
    id: string;
    name: string;
    agentType: "agent" | "mcp_gateway" | "llm_proxy" | "profile";
    scope: "org" | "team" | "personal";
    ownerEmail: string | null;
  }> = {},
) => ({
  id: "a1",
  name: "Agent",
  agentType: "agent" as const,
  scope: "org" as const,
  ownerEmail: null,
  ...overrides,
});

const server = (
  assignedAgents: ReturnType<typeof agent>[],
  autoModeAgents: ReturnType<typeof agent>[] = [],
) => ({ assignedAgents, autoModeAgents }) as unknown as ServerArg;

describe("McpServerUsageTab", () => {
  it("tells same-named personal agents apart by owner", () => {
    render(
      <McpServerUsageTab
        serversForCatalog={[
          server([
            agent({
              id: "1",
              name: "My Assistant",
              scope: "personal",
              ownerEmail: "alice@example.com",
            }),
            agent({
              id: "2",
              name: "My Assistant",
              scope: "personal",
              ownerEmail: "bob@example.com",
            }),
          ]),
        ]}
      />,
    );

    expect(screen.getAllByText("My Assistant")).toHaveLength(2);
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("labels how each agent reaches the server", () => {
    render(
      <McpServerUsageTab
        serversForCatalog={[
          server(
            [agent({ id: "1", name: "Pinned Agent" })],
            [agent({ id: "2", name: "Roaming Gateway" })],
          ),
        ]}
      />,
    );

    const pinnedRow = screen.getByText("Pinned Agent").closest("tr");
    const roamingRow = screen.getByText("Roaming Gateway").closest("tr");

    expect(
      within(pinnedRow as HTMLElement).getByText("Assigned tools"),
    ).toBeInTheDocument();
    expect(
      within(roamingRow as HTMLElement).getByText("Auto — all tools"),
    ).toBeInTheDocument();
  });

  it("lists an agent once when it is both assigned and in auto mode", () => {
    const hybrid = agent({ id: "1", name: "Hybrid" });

    render(
      <McpServerUsageTab serversForCatalog={[server([hybrid], [hybrid])]} />,
    );

    expect(screen.getAllByText("Hybrid")).toHaveLength(1);
    expect(screen.getByText("Assigned tools")).toBeInTheDocument();
  });

  it("dedupes an agent that reaches the catalog through several installs", () => {
    const shared = agent({ id: "1", name: "Support Bot" });

    render(
      <McpServerUsageTab
        serversForCatalog={[server([shared]), server([shared])]}
      />,
    );

    expect(screen.getAllByText("Support Bot")).toHaveLength(1);
  });

  it("explains the empty case instead of rendering a bare table", () => {
    render(<McpServerUsageTab serversForCatalog={[server([], [])]} />);

    expect(
      screen.getByText("No agents use this server yet"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
