"use client";

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getServerApiHeadersMock, getAgentsMock, getTeamsMock } = vi.hoisted(
  () => ({
    getServerApiHeadersMock: vi.fn(),
    getAgentsMock: vi.fn(),
    getTeamsMock: vi.fn(),
  }),
);
const { serverCanAccessPageMock, serverHasPermissionsMock } = vi.hoisted(
  () => ({
    serverCanAccessPageMock: vi.fn(),
    serverHasPermissionsMock: vi.fn(),
  }),
);

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getAgents: getAgentsMock,
    getTeams: getTeamsMock,
  },
  DocsPage: { PlatformOrchestrator: "platform-orchestrator" },
  getDocsUrl: () => "/docs/platform-orchestrator",
}));

vi.mock("@/lib/utils/server", () => ({
  getServerApiHeaders: getServerApiHeadersMock,
}));

vi.mock("@/lib/auth/auth.server", () => ({
  serverCanAccessPage: serverCanAccessPageMock,
  serverHasPermissions: serverHasPermissionsMock,
}));

vi.mock("./page.client", () => ({
  default: ({ initialData }: { initialData: unknown }) => (
    <div data-testid="agents-page">{JSON.stringify(initialData)}</div>
  ),
}));

import AgentsPageServer from "./page";

describe("AgentsPageServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerApiHeadersMock.mockResolvedValue({});
    serverCanAccessPageMock.mockResolvedValue(true);
    serverHasPermissionsMock.mockResolvedValue(true);
    getTeamsMock.mockResolvedValue({ data: { data: [] } });
  });

  it("keeps rendering the combined page when the regular-agent seed fails", async () => {
    getAgentsMock.mockRejectedValue(new Error("agents unavailable"));

    render(await AgentsPageServer());

    expect(screen.getByTestId("agents-page")).toHaveTextContent(
      JSON.stringify({ agents: null, teams: [] }),
    );
  });

  it("still blocks the page before fetching when access is denied", async () => {
    serverCanAccessPageMock.mockResolvedValue(false);

    render(await AgentsPageServer());

    expect(
      screen.getByText("You don't have permission to access this page."),
    ).toBeInTheDocument();
    expect(getAgentsMock).not.toHaveBeenCalled();
  });
});
