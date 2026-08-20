import { renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentEnvironmentConflicts } from "./agent-environment-conflicts";

const {
  useAgentToolsMock,
  useBulkUpdateAgentToolsMock,
  useInternalMcpCatalogMock,
} = vi.hoisted(() => ({
  useAgentToolsMock: vi.fn(),
  useBulkUpdateAgentToolsMock: vi.fn(),
  useInternalMcpCatalogMock: vi.fn(),
}));

vi.mock("@/lib/agent-tools.query", () => ({
  useAgentTools: useAgentToolsMock,
  useBulkUpdateAgentTools: useBulkUpdateAgentToolsMock,
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: useInternalMcpCatalogMock,
}));

vi.mock("sonner");

const AGENT_ID = "agent-1";
const OTHER_ENVIRONMENT = "env-2";

const bulkUpdate = vi.fn();
const refetch = vi.fn();

function catalogQuery(
  data: Array<{
    id: string;
    name: string;
    serverType?: string | null;
    environmentId?: string | null;
  }>,
  overrides: { isPending?: boolean; isError?: boolean } = {},
) {
  return { data, isPending: false, isError: false, ...overrides };
}

function toolsQuery(
  data: Array<{ id: string; catalogId: string | null }>,
  overrides: { isPending?: boolean; isError?: boolean } = {},
) {
  return { data, isPending: false, isError: false, refetch, ...overrides };
}

function setup(
  params: Partial<Parameters<typeof useAgentEnvironmentConflicts>[0]> = {},
) {
  return renderHook(() =>
    useAgentEnvironmentConflicts({
      agentId: AGENT_ID,
      environmentId: OTHER_ENVIRONMENT,
      agentType: "agent",
      enabled: true,
      ...params,
    }),
  );
}

describe("useAgentEnvironmentConflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bulkUpdate.mockResolvedValue({ succeeded: [], removed: [], failed: [] });
    // What the assignments read answers with once the removal has landed.
    refetch.mockResolvedValue({ data: [], isError: false });
    useBulkUpdateAgentToolsMock.mockReturnValue({
      mutateAsync: bulkUpdate,
      isPending: false,
    });
    useInternalMcpCatalogMock.mockReturnValue(catalogQuery([]));
    useAgentToolsMock.mockReturnValue(toolsQuery([]));
  });

  it("blocks the save while either read is still in flight", () => {
    // "No conflicts found" and "not looked yet" are the same empty list, and
    // only one of them is a safe answer to save on.
    useAgentToolsMock.mockReturnValue(toolsQuery([], { isPending: true }));

    const { result } = setup();

    expect(result.current.isVerifying).toBe(true);
    expect(result.current.blocksSave).toBe(true);
    expect(result.current.conflicts).toEqual([]);
  });

  it("blocks the save when a read failed", () => {
    useInternalMcpCatalogMock.mockReturnValue(
      catalogQuery([], { isError: true }),
    );

    const { result } = setup();

    expect(result.current.isUnverifiable).toBe(true);
    expect(result.current.blocksSave).toBe(true);
  });

  it("names the app backing the new environment cannot reach", () => {
    // Apps are catalogs like any other here, and the tools editor offers them
    // for this agent type — so the check has to load them or an app-only
    // conflict reads as no conflict at all.
    useInternalMcpCatalogMock.mockReturnValue(
      catalogQuery([
        {
          id: "app-1",
          name: "Expenses App",
          serverType: "app",
          environmentId: null,
        },
      ]),
    );
    useAgentToolsMock.mockReturnValue(
      toolsQuery([
        { id: "tool-1", catalogId: "app-1" },
        { id: "tool-2", catalogId: "app-1" },
        { id: "tool-3", catalogId: null },
      ]),
    );

    const { result } = setup();

    expect(useInternalMcpCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({ includeApps: true }),
    );
    expect(result.current.conflicts).toEqual([
      { catalogId: "app-1", name: "Expenses App" },
    ]);
    expect(result.current.conflictingToolIds).toEqual(["tool-1", "tool-2"]);
    expect(result.current.blocksSave).toBe(true);
  });

  it("clears once every catalog belongs to the new environment", () => {
    useInternalMcpCatalogMock.mockReturnValue(
      catalogQuery([
        { id: "catalog-1", name: "Jira", environmentId: OTHER_ENVIRONMENT },
        // Builtins are reachable from every environment.
        {
          id: "catalog-2",
          name: "Platform",
          serverType: "builtin",
          environmentId: null,
        },
      ]),
    );
    useAgentToolsMock.mockReturnValue(
      toolsQuery([
        { id: "tool-1", catalogId: "catalog-1" },
        { id: "tool-2", catalogId: "catalog-2" },
      ]),
    );

    const { result } = setup();

    expect(result.current.conflicts).toEqual([]);
    expect(result.current.blocksSave).toBe(false);
  });

  it("stays out of the way, and off the wire, when the form is not moving the agent", () => {
    useInternalMcpCatalogMock.mockReturnValue(
      catalogQuery([{ id: "catalog-1", name: "Jira", environmentId: null }]),
    );
    useAgentToolsMock.mockReturnValue(
      toolsQuery([{ id: "tool-1", catalogId: "catalog-1" }]),
    );

    const { result } = setup({ enabled: false });

    expect(result.current.conflicts).toEqual([]);
    expect(result.current.blocksSave).toBe(false);
    expect(useInternalMcpCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(useAgentToolsMock).toHaveBeenCalledWith(AGENT_ID, {
      enabled: false,
    });
  });

  it("unassigns every tool of the conflicting catalogs and re-reads the answer", async () => {
    useInternalMcpCatalogMock.mockReturnValue(
      catalogQuery([{ id: "catalog-1", name: "Jira", environmentId: null }]),
    );
    useAgentToolsMock.mockReturnValue(
      toolsQuery([
        { id: "tool-1", catalogId: "catalog-1" },
        { id: "tool-2", catalogId: "catalog-1" },
      ]),
    );

    const { result } = setup();
    await waitFor(async () => {
      expect(await result.current.removeConflictingTools()).toBe(true);
    });

    expect(bulkUpdate).toHaveBeenCalledWith({
      removals: [
        { agentId: AGENT_ID, toolId: "tool-1" },
        { agentId: AGENT_ID, toolId: "tool-2" },
      ],
    });
    // The verdict is computed from this read, so it has to be redone before
    // anyone treats the environment as safe to save.
    expect(refetch).toHaveBeenCalled();
  });

  it("treats a rejection reported inside a 200 as a failed removal", async () => {
    // The endpoint answers 200 and names what it refused in `failed`, so a
    // resolved promise is not on its own a removal that happened.
    bulkUpdate.mockResolvedValue({
      succeeded: [],
      removed: [],
      failed: [{ error: "Tool is pinned by a policy" }],
    });
    useInternalMcpCatalogMock.mockReturnValue(
      catalogQuery([{ id: "catalog-1", name: "Jira", environmentId: null }]),
    );
    useAgentToolsMock.mockReturnValue(
      toolsQuery([{ id: "tool-1", catalogId: "catalog-1" }]),
    );

    const { result } = setup();

    expect(await result.current.removeConflictingTools()).toBe(false);
    expect(refetch).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Tool is pinned by a policy");
  });

  it("refuses to clear the conflict when the assignments cannot be re-read", async () => {
    // Without a fresh read there is nothing to judge the environment on, and
    // "could not check" is not the same answer as "nothing is in the way".
    refetch.mockResolvedValue({ data: undefined, isError: true });
    useInternalMcpCatalogMock.mockReturnValue(
      catalogQuery([{ id: "catalog-1", name: "Jira", environmentId: null }]),
    );
    useAgentToolsMock.mockReturnValue(
      toolsQuery([{ id: "tool-1", catalogId: "catalog-1" }]),
    );

    const { result } = setup();

    expect(await result.current.removeConflictingTools()).toBe(false);
    expect(toast.error).toHaveBeenCalled();
  });

  it("refuses to clear the conflict when the re-read still shows one", async () => {
    // A removal the API called clean is not a clean environment until the
    // assignments say so.
    refetch.mockResolvedValue({
      data: [{ id: "tool-9", catalogId: "catalog-1" }],
      isError: false,
    });
    useInternalMcpCatalogMock.mockReturnValue(
      catalogQuery([{ id: "catalog-1", name: "Jira", environmentId: null }]),
    );
    useAgentToolsMock.mockReturnValue(
      toolsQuery([{ id: "tool-1", catalogId: "catalog-1" }]),
    );

    const { result } = setup();

    expect(await result.current.removeConflictingTools()).toBe(false);
    expect(refetch).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it("reports a failed removal rather than letting the save go ahead", async () => {
    bulkUpdate.mockRejectedValue(new Error("refused"));
    useInternalMcpCatalogMock.mockReturnValue(
      catalogQuery([{ id: "catalog-1", name: "Jira", environmentId: null }]),
    );
    useAgentToolsMock.mockReturnValue(
      toolsQuery([{ id: "tool-1", catalogId: "catalog-1" }]),
    );

    const { result } = setup();

    expect(await result.current.removeConflictingTools()).toBe(false);
    expect(refetch).not.toHaveBeenCalled();
  });
});
