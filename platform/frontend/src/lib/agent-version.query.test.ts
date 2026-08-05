import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRestoreAgentVersion } from "@/lib/agent-version.query";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getAgentVersion: vi.fn(),
    getAgentVersions: vi.fn(),
    restoreAgentVersion: vi.fn(),
  },
}));

vi.mock("sonner");

const sdk = vi.mocked(archestraApiSdk);

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return {
    ...renderHook(() => useRestoreAgentVersion(), { wrapper }),
    invalidated: vi.spyOn(queryClient, "invalidateQueries"),
  };
}

/** Version 5 is the head the preview was rendered against throughout. */
const restoreArgs = { agentId: "agent-1", version: 2, baseVersion: 5 };

function invalidatedKeys(invalidated: ReturnType<typeof setup>["invalidated"]) {
  return invalidated.mock.calls.map(([filters]) => filters?.queryKey);
}

describe("useRestoreAgentVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes every cache a restore rewrites, not just the agent row", async () => {
    sdk.restoreAgentVersion.mockResolvedValue({
      data: { id: "agent-1", latestVersion: 6 },
      error: undefined,
    } as never);

    const { result, invalidated } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(invalidated).toHaveBeenCalled());

    // A restore replays a whole snapshot: hooks, tool assignments, and
    // knowledge links move with the agent row. Only the row and the exclusions
    // sit under `["agents"]` — leaving the rest is how a restored agent goes
    // on running against its pre-restore tool set.
    expect(invalidatedKeys(invalidated)).toEqual(
      expect.arrayContaining([
        ["agents"],
        ["hooks", "list", "agent-1"],
        ["tools"],
        ["tools-with-assignments"],
        ["agent-tools"],
        ["mcp-servers"],
        ["mcp-catalog"],
        ["knowledge-bases"],
        ["connectors"],
        ["chat", "agents"],
      ]),
    );
  });

  it("refreshes after a refused write too, since the head moved under it", async () => {
    sdk.restoreAgentVersion.mockResolvedValue({
      data: undefined,
      error: { internal_code: "agent_version_conflict" },
    } as never);

    const { result, invalidated } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(invalidated).toHaveBeenCalled());

    expect(invalidatedKeys(invalidated)).toContainEqual(["agents"]);
  });

  it("names the moved head rather than passing its 409 off as a generic failure", async () => {
    sdk.restoreAgentVersion.mockResolvedValue({
      data: undefined,
      error: { internal_code: "agent_version_conflict" },
    } as never);

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toMatch(
      /changed while you were previewing it/,
    );
    // A refused write created no version, so nothing may report one.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("says nothing was restored when the version was already the head", async () => {
    // The endpoint answers an identical snapshot by leaving the head where it
    // is, so claiming a new version would name one that does not exist.
    sdk.restoreAgentVersion.mockResolvedValue({
      data: { id: "agent-1", latestVersion: restoreArgs.baseVersion },
      error: undefined,
    } as never);

    const { result } = setup();
    result.current.mutate(restoreArgs);
    await waitFor(() => expect(toast.info).toHaveBeenCalled());

    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).toMatch(
      /identical to the current version/,
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
