import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { usePathname, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInteraction } from "@/lib/interactions/interaction.query";
import { ChatPage } from "./page.client";

// The page renders its own `PageLayout` header, which reads the route and the
// white-label app name to keep the browser tab title in sync.
vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/interactions/interaction.query", () => ({
  useInteraction: vi.fn(),
}));

/** A persisted knowledge base embedding, as the detail route returns it. */
const KB_EMBEDDING = {
  id: "test-interaction-id",
  type: "openai:embeddings",
  source: "knowledge:embedding",
  profileId: null,
  model: "text-embedding-3-small",
  inputTokens: 5,
  outputTokens: 0,
  createdAt: "2026-07-27T12:48:04.000Z",
  request: { model: "text-embedding-3-small", input: ["hello"] },
  response: { object: "list", data: [], model: "text-embedding-3-small" },
};

describe("LogDetail locked-chat content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubNavigation();
  });

  function renderInteraction(interaction: Record<string, unknown>) {
    vi.mocked(useInteraction).mockReturnValue({
      data: interaction,
      isPending: false,
      isLoadingError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useInteraction>);

    render(
      <QueryClientProvider client={createQueryClient()}>
        <ChatPage id="test-interaction-id" />
      </QueryClientProvider>,
    );
  }

  it("explains encrypted content instead of rendering the marker", async () => {
    renderInteraction({
      ...KB_EMBEDDING,
      request: { __lockedChatSealed: "9f1c0e2a-3d4b-4c5e-8a7f-1b2c3d4e5f60" },
      response: { __lockedChatSealed: "9f1c0e2a-3d4b-4c5e-8a7f-1b2c3d4e5f60" },
    });

    // Only the response accordion is open by default; the raw marker must
    // never reach the JSON block.
    expect(
      await screen.findByText("Encrypted locked-chat content"),
    ).toBeVisible();
    expect(screen.queryByText(/__lockedChatSealed/)).not.toBeInTheDocument();
  });

  it("says content was never stored when it was redacted", async () => {
    renderInteraction({
      ...KB_EMBEDDING,
      request: { __redacted: "locked_chat" },
      response: { __redacted: "locked_chat" },
    });

    expect(await screen.findByText("Content not stored")).toBeVisible();
    expect(screen.queryByText(/__redacted/)).not.toBeInTheDocument();
  });
});

describe("LogDetail knowledge base connector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubNavigation();
  });

  function renderWith(overrides: {
    connectorId?: string | null;
    connectorName?: string | null;
  }) {
    vi.mocked(useInteraction).mockReturnValue({
      data: { ...KB_EMBEDDING, ...overrides },
      isPending: false,
      isLoadingError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useInteraction>);

    render(
      <QueryClientProvider client={createQueryClient()}>
        <ChatPage id="test-interaction-id" />
      </QueryClientProvider>,
    );
  }

  it("names the connector the interaction was recorded for", async () => {
    renderWith({
      connectorId: "1b6f2d90-4a3c-4e57-b2d8-9c0e1f3a5b74",
      connectorName: "Docs Web Crawler",
    });

    expect(await screen.findByText("KB connector")).toBeVisible();
    expect(screen.getByText("Docs Web Crawler")).toBeVisible();
  });

  it("falls back when the connector no longer exists", async () => {
    renderWith({
      connectorId: "1b6f2d90-4a3c-4e57-b2d8-9c0e1f3a5b74",
      connectorName: null,
    });

    expect(await screen.findByText("KB connector")).toBeVisible();
    expect(screen.getByText("Deleted connector")).toBeVisible();
  });

  it("omits the row for interactions with no connector recorded", async () => {
    renderWith({ connectorId: null, connectorName: null });

    // Rows written before connector attribution existed, and non-KB proxy
    // traffic, must not render an empty or placeholder connector.
    expect(await screen.findByText("Provider")).toBeVisible();
    expect(screen.queryByText("KB connector")).not.toBeInTheDocument();
    expect(screen.queryByText("Deleted connector")).not.toBeInTheDocument();
  });
});

describe("LogDetail virtual key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubNavigation();
  });

  function renderWith(overrides: Record<string, unknown>) {
    vi.mocked(useInteraction).mockReturnValue({
      data: { ...KB_EMBEDDING, ...overrides },
      isPending: false,
      isLoadingError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useInteraction>);

    render(
      <QueryClientProvider client={createQueryClient()}>
        <ChatPage id="test-interaction-id" />
      </QueryClientProvider>,
    );
  }

  it("names the key behind a virtual-key request and who it stands for", async () => {
    renderWith({
      authMethod: "virtual_key",
      virtualKey: {
        id: "6b2f1a08-5c9d-4e31-a7b4-2d8e0f5c1a93",
        name: "demo-admin-laptop",
        scope: "personal",
        keyType: "standard",
        tokenStart: "archestra_ab",
        ownerUserId: "u-1",
        ownerUserName: "Demo Admin",
        teams: [],
        createdByUserName: "Demo Admin",
      },
      passthroughVirtualKey: null,
    });

    expect(await screen.findByText("Virtual API key")).toBeVisible();
    expect(screen.getByText("demo-admin-laptop")).toBeVisible();
    expect(screen.getByText("Virtual key · Demo Admin")).toBeVisible();
  });

  it("says a shared key stands for nobody rather than leaving it blank", async () => {
    renderWith({
      authMethod: "virtual_key",
      virtualKey: {
        id: "0f3c7e15-9a2b-4d68-8c31-5e7a9b0d2f46",
        name: "ci-runners",
        scope: "org",
        keyType: "standard",
        tokenStart: "archestra_cd",
        ownerUserId: null,
        ownerUserName: null,
        teams: [],
        createdByUserName: "Platform Lead",
      },
      passthroughVirtualKey: null,
    });

    expect(await screen.findByText("ci-runners")).toBeVisible();
    expect(
      screen.getByText(
        "Virtual key · shared org-wide, created by Platform Lead",
      ),
    ).toBeVisible();
  });

  it("lists the passthrough key first when a request carries both", async () => {
    renderWith({
      authMethod: "passthrough_virtual_key",
      virtualKey: {
        id: "0f3c7e15-9a2b-4d68-8c31-5e7a9b0d2f46",
        name: "team-provider-credential",
        scope: "team",
        keyType: "standard",
        tokenStart: "archestra_cd",
        ownerUserId: null,
        ownerUserName: null,
        teams: [{ id: "t-1", name: "Platform" }],
        createdByUserName: "Platform Lead",
      },
      passthroughVirtualKey: {
        id: "6b2f1a08-5c9d-4e31-a7b4-2d8e0f5c1a93",
        name: "demo-admin-identity",
        scope: "personal",
        keyType: "passthrough",
        tokenStart: "archestra_ef",
        ownerUserId: "u-1",
        ownerUserName: "Demo Admin",
        teams: [],
        createdByUserName: "Demo Admin",
      },
    });

    const row = (await screen.findByText("Virtual API key")).parentElement;
    expect(row?.textContent).toMatch(
      /demo-admin-identity[\s\S]*team-provider-credential/,
    );
    expect(screen.getByText("Passthrough key · Demo Admin")).toBeVisible();
  });

  it("names the teams a team-scoped key is shared with", async () => {
    renderWith({
      authMethod: "virtual_key",
      virtualKey: {
        id: "3a1d5c92-7e04-4b18-9f26-8c0a4e7b1d35",
        name: "platform-shared",
        scope: "team",
        keyType: "standard",
        tokenStart: "archestra_gh",
        ownerUserId: null,
        ownerUserName: null,
        teams: [
          { id: "t-1", name: "Platform" },
          { id: "t-2", name: "Security" },
        ],
        createdByUserName: "Platform Lead",
      },
      passthroughVirtualKey: null,
    });

    expect(await screen.findByText("platform-shared")).toBeVisible();
    expect(
      screen.getByText("Virtual key · shared with Platform, Security"),
    ).toBeVisible();
  });

  it("says so when a team key has no team left on it", async () => {
    renderWith({
      authMethod: "virtual_key",
      virtualKey: {
        id: "9c4e2b70-1f83-4d5a-b6e9-2a7c0d38f514",
        name: "orphaned-team-key",
        scope: "team",
        keyType: "standard",
        tokenStart: "archestra_ij",
        ownerUserId: null,
        ownerUserName: null,
        teams: [],
        createdByUserName: null,
      },
      passthroughVirtualKey: null,
    });

    expect(
      await screen.findByText("Virtual key · team key, no team assigned"),
    ).toBeVisible();
  });

  it("omits the row when no virtual key was used", async () => {
    renderWith({ authMethod: "provider_key" });

    expect(await screen.findByText("Auth method")).toBeVisible();
    expect(screen.queryByText("Virtual API key")).not.toBeInTheDocument();
  });
});

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
}

function stubNavigation() {
  vi.mocked(usePathname).mockReturnValue("/llm/logs/test-interaction-id");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
}
