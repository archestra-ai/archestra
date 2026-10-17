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

  it("shows nothing when no catalog item has the tool's server prefix", () => {
    useMcpServersMock.mockReturnValue({ data: undefined });

    render(<ToolErrorLogsButton toolName="unknown__tool" />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(useMcpServersMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });
});
