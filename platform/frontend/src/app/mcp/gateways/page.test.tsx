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

vi.mock("@shared", () => ({
  archestraApiSdk: {
    getAgents: getAgentsMock,
    getTeams: getTeamsMock,
  },
  DocsPage: {
    PlatformOrchestrator: "platform-orchestrator",
  },
  getDocsUrl: () => "/docs/platform-orchestrator",
}));

vi.mock("@/lib/utils/server", () => ({
  getServerApiHeaders: getServerApiHeadersMock,
}));

vi.mock("./page.client", () => ({
  default: ({ initialData }: { initialData: unknown }) => (
    <div data-testid="mcp-gateways-page">{JSON.stringify(initialData)}</div>
  ),
}));

vi.mock("@/components/error-fallback", () => ({
  ServerErrorFallback: ({ error }: { error: Error }) => (
    <div data-testid="server-error-fallback">{error.message}</div>
  ),
}));

import McpGatewaysPageServer from "./page";

describe("McpGatewaysPageServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerApiHeadersMock.mockResolvedValue({});
  });

  it("renders the forbidden page for expected authorization failures", async () => {
    getAgentsMock.mockResolvedValue({
      error: {
        error: {
          message: "Forbidden",
          type: "api_authorization_error",
        },
      },
    });
    getTeamsMock.mockResolvedValue({ data: { data: [] } });

    render(await McpGatewaysPageServer());

    expect(
      screen.getByText("You don't have permission to access this page."),
    ).toBeInTheDocument();
  });

  it("renders the page client when data loads successfully", async () => {
    getAgentsMock.mockResolvedValue({
      data: { data: [{ id: "agent-1" }] },
    });
    getTeamsMock.mockResolvedValue({
      data: { data: [{ id: "team-1", name: "Team 1" }] },
    });

    render(await McpGatewaysPageServer());

    expect(screen.getByTestId("mcp-gateways-page")).toBeInTheDocument();
  });
});
