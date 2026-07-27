import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner");

const getInteractionsMock = vi.hoisted(() => vi.fn());
vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getInteractions: getInteractionsMock,
    },
  };
});

import { isSessionId, useExportSessionInteractions } from "./interaction.query";

// The logs search box only filters by session ID (free-text content search was
// removed), so this predicate decides whether a typed term filters or is
// ignored. Pin the accepted shapes and the rejection of anything else.
describe("isSessionId", () => {
  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";

  it("accepts a bare UUID", () => {
    expect(isSessionId(uuid)).toBe(true);
  });

  it("accepts a scheduled-<UUID> session ID", () => {
    expect(isSessionId(`scheduled-${uuid}`)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSessionId(uuid.toUpperCase())).toBe(true);
  });

  it("rejects arbitrary free-text search terms", () => {
    expect(isSessionId("summarize the quarterly report")).toBe(false);
    expect(isSessionId("gpt-4o")).toBe(false);
    expect(isSessionId("")).toBe(false);
  });

  it("rejects partial or padded UUIDs", () => {
    expect(isSessionId(uuid.slice(0, 8))).toBe(false);
    expect(isSessionId(` ${uuid} `)).toBe(false);
    expect(isSessionId(`session ${uuid}`)).toBe(false);
    // Only the `scheduled-` prefix is allowed, not arbitrary prefixes.
    expect(isSessionId(`task-${uuid}`)).toBe(false);
  });
});

// The export must contain the whole session, not just the first page —
// support workflows share these files to diagnose guardrail decisions, and a
// silently truncated export would hide the interaction that matters.
describe("useExportSessionInteractions", () => {
  const sessionId = "0f8fad5b-d9cb-469f-a165-70867728950e";

  function makePage(params: {
    ids: string[];
    total: number;
    hasNext: boolean;
  }) {
    return {
      data: {
        data: params.ids.map((id) => ({ id })),
        pagination: {
          currentPage: 1,
          limit: 100,
          total: params.total,
          totalPages: Math.ceil(params.total / 100),
          hasNext: params.hasNext,
          hasPrev: false,
        },
      },
    };
  }

  function renderExportHook() {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    return renderHook(() => useExportSessionInteractions(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    });
  }

  beforeEach(() => {
    // Unspy DOM/URL prototype spies from the previous test — vi.spyOn on an
    // already-spied method returns the same mock, so calls would leak across
    // tests otherwise.
    vi.restoreAllMocks();
    getInteractionsMock.mockReset();
  });

  it("pages through the whole session and downloads every interaction", async () => {
    getInteractionsMock
      .mockResolvedValueOnce(
        makePage({ ids: ["row-1", "row-2"], total: 102, hasNext: true }),
      )
      .mockResolvedValueOnce(
        makePage({ ids: ["row-3"], total: 102, hasNext: false }),
      );

    let downloadedJson: string | null = null;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      void (blob as Blob).text().then((text) => {
        downloadedJson = text;
      });
      return "blob:mock";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    const { result } = renderExportHook();
    result.current.mutate({ sessionId });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Both pages were fetched, in chronological order for a readable export.
    expect(getInteractionsMock).toHaveBeenCalledTimes(2);
    expect(getInteractionsMock).toHaveBeenNthCalledWith(1, {
      query: {
        sessionId,
        limit: 100,
        offset: 0,
        sortBy: "createdAt",
        sortDirection: "asc",
      },
    });
    expect(getInteractionsMock).toHaveBeenNthCalledWith(2, {
      query: {
        sessionId,
        limit: 100,
        offset: 100,
        sortBy: "createdAt",
        sortDirection: "asc",
      },
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(downloadedJson).not.toBeNull());
    const payload = JSON.parse(downloadedJson ?? "{}");
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.interactionCount).toBe(3);
    expect(payload.interactions.map((i: { id: string }) => i.id)).toEqual([
      "row-1",
      "row-2",
      "row-3",
    ]);
  });

  it("fails the mutation when a page fetch errors", async () => {
    getInteractionsMock.mockResolvedValueOnce({
      error: { error: { message: "boom", type: "api_error" } },
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    const { result } = renderExportHook();
    result.current.mutate({ sessionId });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
