import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMemberSearch } from "@/lib/member.query";

vi.mock("sonner");

vi.mock("@archestra/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared")>()),
  archestraApiSdk: { getMembers: vi.fn() },
}));

const getMembers = vi.mocked(archestraApiSdk.getMembers);

function membersResponse(
  members: Array<{ userId: string; name: string; email: string }>,
) {
  return {
    data: {
      data: members,
      pagination: {
        currentPage: 1,
        limit: 50,
        total: members.length,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
    error: undefined,
  };
}

const ADA = {
  userId: "u-ada",
  name: "Lovelace, Ada M.",
  email: "ada@example.com",
};
const CHARLES = {
  userId: "u-charles",
  name: "Babbage, Charles",
  email: "charles@example.com",
};

function renderMemberSearch(selectedUserIds: string[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  return renderHook(() => useMemberSearch({ selectedUserIds }), { wrapper });
}

describe("useMemberSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getMembers.mockReset();
    getMembers.mockResolvedValue(
      membersResponse([ADA, CHARLES]) as unknown as Awaited<
        ReturnType<typeof archestraApiSdk.getMembers>
      >,
    );
  });

  it("sends the typed query to the server rather than filtering locally", async () => {
    const { result } = renderMemberSearch();
    await waitFor(() => expect(result.current.users).toHaveLength(2));

    act(() => result.current.onSearchQueryChange("Ada Lovelace"));
    act(() => void vi.advanceTimersByTime(300));

    await waitFor(() =>
      expect(getMembers).toHaveBeenCalledWith({
        query: expect.objectContaining({ name: "Ada Lovelace" }),
      }),
    );
  });

  it("keeps a selected user in the list once the query stops matching them", async () => {
    const { result, rerender } = renderMemberSearch(["u-ada"]);
    await waitFor(() =>
      expect(result.current.users.map((user) => user.userId)).toContain(
        "u-ada",
      ),
    );

    // A later search that no longer returns Ada must not drop her, or the
    // picker would render a bare id instead of the chosen owner's name.
    getMembers.mockResolvedValue(
      membersResponse([CHARLES]) as unknown as Awaited<
        ReturnType<typeof archestraApiSdk.getMembers>
      >,
    );
    act(() => result.current.onSearchQueryChange("Babbage"));
    act(() => void vi.advanceTimersByTime(300));
    rerender();

    await waitFor(() =>
      expect(result.current.users.map((user) => user.userId)).toEqual([
        "u-ada",
        "u-charles",
      ]),
    );
  });

  it("reports that it is still searching while the query debounces", async () => {
    const { result } = renderMemberSearch();
    await waitFor(() => expect(result.current.isSearching).toBe(false));

    act(() => result.current.onSearchQueryChange("ada"));

    expect(result.current.isSearching).toBe(true);
    expect(result.current.emptyMessage).toBe("Searching…");
  });
});
