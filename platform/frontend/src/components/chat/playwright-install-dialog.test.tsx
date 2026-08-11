import { PLAYWRIGHT_MCP_CATALOG_ID } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseMcpServers = vi.fn();
const mockUseProfileToolsWithIds = vi.fn();
const mockUseConversationEnabledTools = vi.fn();
const mockUseAgentDelegations = vi.fn();
const mockUseSession = vi.fn();

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: (...args: unknown[]) => mockUseMcpServers(...args),
}));

vi.mock("@/lib/chat/chat.query", () => ({
  useProfileToolsWithIds: (...args: unknown[]) =>
    mockUseProfileToolsWithIds(...args),
  useConversationEnabledTools: (...args: unknown[]) =>
    mockUseConversationEnabledTools(...args),
  fetchAgentMcpTools: vi.fn(async () => []),
  useHasPlaywrightMcpTools: vi.fn(() => ({})),
  useUpdateConversationEnabledTools: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.mock("@/lib/agent-tools.query", () => ({
  useAgentDelegations: (...args: unknown[]) => mockUseAgentDelegations(...args),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => mockUseSession(),
}));

import { usePlaywrightSetupRequired } from "./playwright-install-dialog";

const USER_ID = "user-1";
const AGENT_ID = "agent-1";
const CONVERSATION_ID = "conversation-1";

const PLAYWRIGHT_TOOL = {
  id: "tool-playwright",
  name: "microsoft__playwright-mcp__browser_navigate",
  catalogId: PLAYWRIGHT_MCP_CATALOG_ID,
  delegateToAgentId: null,
};

const PLAYWRIGHT_SERVER_OWNED_BY_USER = {
  id: "server-1",
  catalogId: PLAYWRIGHT_MCP_CATALOG_ID,
  ownerId: USER_ID,
};

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/**
 * @param installState "loading" models the window where the user's Playwright
 * install has not come back yet; "installed"/"not-installed" are resolved.
 */
function setup(options: {
  installState: "loading" | "installed" | "not-installed";
  agentTools?: Array<Record<string, unknown>>;
  isLoadingAgentTools?: boolean;
  enabledTools?: {
    hasCustomSelection: boolean;
    enabledToolIds: string[];
  } | null;
}) {
  const {
    installState,
    agentTools = [PLAYWRIGHT_TOOL],
    isLoadingAgentTools = false,
    enabledTools = { hasCustomSelection: false, enabledToolIds: [] },
  } = options;

  mockUseSession.mockReturnValue({ data: { user: { id: USER_ID } } });

  mockUseMcpServers.mockReturnValue(
    installState === "loading"
      ? { data: undefined, isLoading: true }
      : {
          data:
            installState === "installed"
              ? [PLAYWRIGHT_SERVER_OWNED_BY_USER]
              : [],
          isLoading: false,
        },
  );

  mockUseProfileToolsWithIds.mockReturnValue({
    data: agentTools,
    isLoading: isLoadingAgentTools,
  });
  mockUseConversationEnabledTools.mockReturnValue({ data: enabledTools });
  mockUseAgentDelegations.mockReturnValue({ data: [], isLoading: false });

  return renderHook(
    () => usePlaywrightSetupRequired(AGENT_ID, CONVERSATION_ID),
    { wrapper },
  );
}

describe("usePlaywrightSetupRequired", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not report setup required while the user's install state is still loading", () => {
    const { result } = setup({ installState: "loading" });

    expect(result.current.isRequired).toBe(false);
  });

  it("reports setup required once the install state resolves to not-installed", () => {
    const { result } = setup({ installState: "not-installed" });

    expect(result.current.isRequired).toBe(true);
  });

  it("does not report setup required once the install state resolves to installed", () => {
    const { result } = setup({ installState: "installed" });

    expect(result.current.isRequired).toBe(false);
  });

  it("does not report setup required when the agent has no Playwright tools", () => {
    const { result } = setup({
      installState: "not-installed",
      agentTools: [
        {
          id: "tool-other",
          name: "some__other__tool",
          catalogId: "another-catalog",
          delegateToAgentId: null,
        },
      ],
    });

    expect(result.current.isRequired).toBe(false);
  });

  it("does not report setup required while the conversation's enabled tools are unknown", () => {
    const { result } = setup({
      installState: "not-installed",
      enabledTools: null,
    });

    expect(result.current.isRequired).toBe(false);
  });

  it("excludes a Playwright tool the conversation has explicitly disabled", () => {
    const { result } = setup({
      installState: "not-installed",
      enabledTools: { hasCustomSelection: true, enabledToolIds: [] },
    });

    expect(result.current.isRequired).toBe(false);
  });

  it("reports loading while the agent's tools are still being fetched", () => {
    const { result } = setup({
      installState: "not-installed",
      isLoadingAgentTools: true,
    });

    expect(result.current.isLoading).toBe(true);
  });

  it("does not report loading once the user has Playwright installed", () => {
    const { result } = setup({
      installState: "installed",
      isLoadingAgentTools: true,
    });

    expect(result.current.isLoading).toBe(false);
  });
});
