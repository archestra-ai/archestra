import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query", () => ({ useSession: vi.fn() }));

import { useSession } from "@/lib/auth/auth.query";
import { McpServerUsageTab } from "./mcp-server-usage-tab";

const VIEWER_ID = "viewer-1";

beforeEach(() => {
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: VIEWER_ID } },
  } as ReturnType<typeof useSession>);
});

type ServerArg = Parameters<
  typeof McpServerUsageTab
>[0]["serversForCatalog"][number];

const agent = (
  overrides: Partial<{
    id: string;
    name: string;
    agentType: "agent" | "mcp_gateway" | "llm_proxy" | "profile";
    scope: "org" | "team" | "personal";
    ownerId: string | null;
    ownerEmail: string | null;
  }> = {},
) => ({
  id: "a1",
  name: "Agent",
  agentType: "agent" as const,
  scope: "org" as const,
  ownerId: null,
  ownerEmail: null,
  ...overrides,
});

const server = (assignedAgents: ReturnType<typeof agent>[]) =>
  ({ assignedAgents }) as unknown as ServerArg;

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
              ownerId: "alice",
              ownerEmail: "alice@example.com",
            }),
            agent({
              id: "2",
              name: "My Assistant",
              scope: "personal",
              ownerId: "bob",
              ownerEmail: "bob@example.com",
            }),
          ]),
        ]}
        autoModeAgents={[]}
      />,
    );

    expect(screen.getAllByText("My Assistant")).toHaveLength(2);
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("spells out the scope of an ownerless agent instead of the raw enum", () => {
    render(
      <McpServerUsageTab
        serversForCatalog={[
          server([agent({ id: "1", name: "Org Agent", scope: "org" })]),
        ]}
        autoModeAgents={[]}
      />,
    );

    const row = screen.getByText("Org Agent").closest("tr") as HTMLElement;

    expect(within(row).getByText("Organization")).toBeInTheDocument();
    expect(within(row).queryByText("org")).not.toBeInTheDocument();
  });

  it("names the viewer as the owner of their own personal agents", () => {
    render(
      <McpServerUsageTab
        serversForCatalog={[
          server([
            agent({
              id: "1",
              name: "My Assistant",
              scope: "personal",
              ownerId: VIEWER_ID,
              ownerEmail: "me@example.com",
            }),
          ]),
        ]}
        autoModeAgents={[]}
      />,
    );

    const row = screen.getByText("My Assistant").closest("tr") as HTMLElement;

    expect(within(row).getByText("You")).toBeInTheDocument();
    expect(within(row).queryByText("Personal")).not.toBeInTheDocument();
  });

  it("says the author's account was deleted rather than calling the agent 'Personal'", () => {
    render(
      <McpServerUsageTab
        serversForCatalog={[
          server([
            agent({
              id: "1",
              name: "Nightly Backlog Groomer",
              scope: "personal",
              ownerId: null,
              ownerEmail: null,
            }),
          ]),
        ]}
        autoModeAgents={[]}
      />,
    );

    const row = screen
      .getByText("Nightly Backlog Groomer")
      .closest("tr") as HTMLElement;

    expect(within(row).getByText("Deleted user")).toBeInTheDocument();
    // The bug: a missing owner used to fall back to the scope, so a row whose
    // owner was gone was worded exactly like the viewer's own.
    expect(within(row).queryByText("Personal")).not.toBeInTheDocument();
    expect(within(row).queryByText("You")).not.toBeInTheDocument();
  });

  it("labels how each agent reaches the server", () => {
    render(
      <McpServerUsageTab
        serversForCatalog={[server([agent({ id: "1", name: "Pinned Agent" })])]}
        autoModeAgents={[agent({ id: "2", name: "Roaming Gateway" })]}
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
      <McpServerUsageTab
        serversForCatalog={[server([hybrid])]}
        autoModeAgents={[hybrid]}
      />,
    );

    expect(screen.getAllByText("Hybrid")).toHaveLength(1);
    expect(screen.getByText("Assigned tools")).toBeInTheDocument();
  });

  it("dedupes an agent that reaches the catalog through several installs", () => {
    const shared = agent({ id: "1", name: "Support Bot" });

    render(
      <McpServerUsageTab
        serversForCatalog={[server([shared]), server([shared])]}
        autoModeAgents={[]}
      />,
    );

    expect(screen.getAllByText("Support Bot")).toHaveLength(1);
  });

  it("explains the empty case instead of rendering a bare table", () => {
    render(
      <McpServerUsageTab
        serversForCatalog={[server([])]}
        autoModeAgents={[]}
      />,
    );

    expect(
      screen.getByText("No agents use this server yet"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
