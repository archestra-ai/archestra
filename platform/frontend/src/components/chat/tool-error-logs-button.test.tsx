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

  it("finds the installs of a catalog item the viewer cannot see by their catalog name", () => {
    // A team install of an item outside the viewer's registry: not in the
    // directory, but its install is readable.
    useMcpServersMock.mockImplementation(
      (params: { catalogId?: string; enabled?: boolean }) => ({
        data:
          params.enabled === false || params.catalogId
            ? undefined
            : [
                {
                  id: "srv-team",
                  name: "team-jira",
                  catalogName: "team-jira",
                  serverType: "local",
                  canUseCredential: false,
                },
                {
                  id: "srv-x",
                  name: "x",
                  catalogName: "x",
                  serverType: "local",
                  canUseCredential: true,
                },
              ],
      }),
    );

    render(<ToolErrorLogsButton toolName="team-jira__search" />);

    expect(
      screen.getByRole("button", { name: "View Server Logs" }),
    ).toBeInTheDocument();
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
    // No full install list for a name the directory resolves.
    expect(useMcpServersMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: undefined, enabled: true }),
    );
  });
});
