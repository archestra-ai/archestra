import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useMcpServersMock } = vi.hoisted(() => ({
  useMcpServersMock: vi.fn(),
}));

vi.mock("@/lib/mcp/mcp-registry.query", () => ({
  useMcpCatalogDirectory: () => ({
    data: [
      { id: "cat-github", name: "github", serverType: "local", icon: null },
      { id: "cat-other", name: "other", serverType: "remote", icon: null },
      { id: "cat-gh", name: "GitHub Cloud", serverType: "local", icon: null },
    ],
  }),
}));
vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: useMcpServersMock,
  useMcpDeploymentStatuses: () => ({ statuses: {}, state: "ready" }),
}));
vi.mock("@/app/mcp/registry/_parts/mcp-logs-dialog", () => ({
  McpLogsDialog: () => null,
}));

import { ToolErrorLogsButton } from "./tool-error-logs-button";

/** Every enabled install request names a catalog: never the whole list. */
function expectNoFullInstallList() {
  for (const [params] of useMcpServersMock.mock.calls) {
    if (params.enabled === false) continue;
    expect(params.catalogId ?? params.catalogSlug).toBeTruthy();
  }
}

describe("ToolErrorLogsButton", () => {
  beforeEach(() => {
    useMcpServersMock.mockReset();
  });

  it("loads only the installs of the catalog item the tool's server prefix names", () => {
    useMcpServersMock.mockReturnValue({
      data: [
        {
          id: "srv-1",
          name: "github-me",
          serverType: "local",
          canUseCredential: true,
        },
      ],
    });

    render(<ToolErrorLogsButton toolName="github__create_issue" />);

    expect(
      screen.getByRole("button", { name: "View Server Logs" }),
    ).toBeInTheDocument();
    expect(useMcpServersMock).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: "cat-github", enabled: true }),
    );
  });

  it("finds the installs of a catalog item the viewer cannot see by its slug", () => {
    // A team install of an item outside the viewer's registry: not in the
    // directory, but its install is readable, and asked for by name only.
    useMcpServersMock.mockImplementation(
      (params: { catalogSlug?: string; enabled?: boolean }) => ({
        data:
          params.enabled !== false && params.catalogSlug === "team-jira"
            ? [
                {
                  id: "srv-team",
                  name: "team-jira",
                  catalogName: "team-jira",
                  serverType: "local",
                  canUseCredential: false,
                },
              ]
            : undefined,
      }),
    );

    render(<ToolErrorLogsButton toolName="team-jira__search" />);

    expect(
      screen.getByRole("button", { name: "View Server Logs" }),
    ).toBeInTheDocument();
    expectNoFullInstallList();
  });

  it("asks for no installs for a delegation to another agent", () => {
    useMcpServersMock.mockReturnValue({ data: undefined });

    render(<ToolErrorLogsButton toolName="agent__delegate_to_researcher" />);

    expect(screen.queryByRole("button")).toBeNull();
    for (const [params] of useMcpServersMock.mock.calls) {
      expect(params.enabled).toBe(false);
    }
  });

  it("shows nothing when no install has the tool's server prefix", () => {
    useMcpServersMock.mockReturnValue({ data: [] });

    render(<ToolErrorLogsButton toolName="unknown__tool" />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("resolves a catalog name with capitals and spaces from its tool prefix", () => {
    useMcpServersMock.mockImplementation(
      (params: { catalogId?: string; enabled?: boolean }) => ({
        data:
          params.catalogId === "cat-gh" && params.enabled !== false
            ? [
                {
                  id: "srv-gh",
                  name: "gh",
                  serverType: "local",
                  canUseCredential: true,
                },
              ]
            : undefined,
      }),
    );

    // Tool names carry the server name slugified: lowercase, spaces as "_".
    render(<ToolErrorLogsButton toolName="github_cloud__create_issue" />);

    expect(
      screen.getByRole("button", { name: "View Server Logs" }),
    ).toBeInTheDocument();
    expectNoFullInstallList();
  });
});
