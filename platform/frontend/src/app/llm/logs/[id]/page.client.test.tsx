import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInteraction } from "@/lib/interactions/interaction.query";
import { ChatPage } from "./page.client";

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

describe("LogDetail knowledge base connector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(await screen.findByText("KB Connector")).toBeVisible();
    expect(screen.getByText("Docs Web Crawler")).toBeVisible();
  });

  it("falls back when the connector no longer exists", async () => {
    renderWith({
      connectorId: "1b6f2d90-4a3c-4e57-b2d8-9c0e1f3a5b74",
      connectorName: null,
    });

    expect(await screen.findByText("KB Connector")).toBeVisible();
    expect(screen.getByText("Deleted connector")).toBeVisible();
  });

  it("omits the row for interactions with no connector recorded", async () => {
    renderWith({ connectorId: null, connectorName: null });

    // Rows written before connector attribution existed, and non-KB proxy
    // traffic, must not render an empty or placeholder connector.
    expect(await screen.findByText("Model")).toBeVisible();
    expect(screen.queryByText("KB Connector")).not.toBeInTheDocument();
    expect(screen.queryByText("Deleted connector")).not.toBeInTheDocument();
  });
});

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
}
