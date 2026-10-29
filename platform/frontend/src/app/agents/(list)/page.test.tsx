"use client";

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAgentCatalogMock,
  getMemberDefaultAgentMock,
  getOrganizationMock,
  getTeamsMock,
} = vi.hoisted(() => ({
  getAgentCatalogMock: vi.fn(),
  getMemberDefaultAgentMock: vi.fn(),
  getOrganizationMock: vi.fn(),
  getTeamsMock: vi.fn(),
}));

vi.mock("@archestra/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared")>()),
  archestraApiSdk: {
    getAgentCatalog: getAgentCatalogMock,
    getMemberDefaultAgent: getMemberDefaultAgentMock,
    getOrganization: getOrganizationMock,
    getTeams: getTeamsMock,
  },
}));

vi.mock("@/lib/utils/server", () => ({
  getServerApiHeaders: async () => ({ Cookie: "session=1" }),
}));

vi.mock("../page.client", () => ({
  default: () => <div data-testid="agents-page" />,
}));

// What the page hands the browser: each streamed query and its state.
vi.mock("../streamed-queries", () => ({
  StreamedQueries: ({
    state,
    children,
  }: {
    state: {
      queries: Array<{ queryKey: unknown[]; state: { status: string } }>;
    };
    children: React.ReactNode;
  }) => (
    <div data-testid="streamed">
      {state.queries.map(({ queryKey, state: { status } }) => (
        <span key={JSON.stringify(queryKey)}>
          {`${status} ${JSON.stringify(queryKey)}`}
        </span>
      ))}
      {children}
    </div>
  ),
}));

import { StreamedAgentsPage } from "../streamed-agents-page";
import AgentsPageServer from "./page";

const noSearchParams = Promise.resolve({});

describe("AgentsPageServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The catalog never answers: the page must render without it.
    getAgentCatalogMock.mockReturnValue(new Promise(() => {}));
    getMemberDefaultAgentMock.mockResolvedValue({
      data: { defaultAgentId: null, personalChatAgentId: "personal-1" },
    });
    getOrganizationMock.mockResolvedValue({
      data: { id: "org-1", defaultAgentId: "org-default" },
    });
  });

  it("renders the default view after the viewer's pins, without waiting on the catalog", async () => {
    render(await AgentsPageServer({ searchParams: noSearchParams }));

    // The page waited for the two reads; the catalog queries are still pending.
    expect(getMemberDefaultAgentMock).toHaveBeenCalled();
    expect(screen.getByTestId("streamed")).toBeInTheDocument();
    expect(getAgentCatalogMock).toHaveBeenCalledTimes(3);
  });

  it("starts the default view's catalog queries and renders without waiting on them", async () => {
    render(await StreamedAgentsPage());

    expect(screen.getByTestId("agents-page")).toBeInTheDocument();
    const queries = getAgentCatalogMock.mock.calls.map(([{ query }]) => query);
    expect(queries).toEqual([
      expect.objectContaining({ pinned: true, limit: 100 }),
      expect.objectContaining({
        pinned: false,
        excludeIds: ["org-default", "personal-1"],
      }),
      expect.objectContaining({ ids: ["org-default", "personal-1"] }),
    ]);
    // Still in flight, they stream as pending; the pins the keys depend on
    // go along as data.
    const streamed = screen.getByTestId("streamed").textContent ?? "";
    expect(streamed.match(/pending \["agents","catalog"/g)).toHaveLength(3);
    expect(streamed).toContain('success ["member-default-agent"]');
    expect(streamed).toContain('success ["organization","details"]');
    expect(getTeamsMock).not.toHaveBeenCalled();
  });

  it("leaves a filtered, sorted or paged view to the client", async () => {
    render(
      await AgentsPageServer({ searchParams: Promise.resolve({ page: "2" }) }),
    );

    expect(screen.getByTestId("agents-page")).toBeInTheDocument();
    expect(screen.queryByTestId("streamed")).not.toBeInTheDocument();
    expect(getAgentCatalogMock).not.toHaveBeenCalled();
  });

  it("still renders the page when the viewer's pins cannot be read", async () => {
    getMemberDefaultAgentMock.mockRejectedValue(new Error("down"));

    render(await StreamedAgentsPage());

    expect(screen.getByTestId("agents-page")).toBeInTheDocument();
  });
});
