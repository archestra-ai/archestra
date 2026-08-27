import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRoles } from "@/lib/role.query";

vi.mock("sonner");

vi.mock("@archestra/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared")>()),
  archestraApiSdk: { getRoles: vi.fn() },
}));

const getRoles = vi.mocked(archestraApiSdk.getRoles);

type TestRole = { id: string; role: string; name: string; predefined: boolean };

function role(name: string, predefined = false): TestRole {
  return { id: `id-${name}`, role: name, name, predefined };
}

/** `/api/roles` serves the predefined roles first, then custom ones by name. */
function serveRoles(all: TestRole[]) {
  getRoles.mockImplementation((async ({
    query,
  }: {
    query: { limit: number; offset: number };
  }) => ({
    data: {
      data: all.slice(query.offset, query.offset + query.limit),
      pagination: {
        currentPage: 1,
        limit: query.limit,
        total: all.length,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
    error: undefined,
  })) as unknown as typeof archestraApiSdk.getRoles);
}

function renderUseRoles() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  return renderHook(() => useRoles(), { wrapper });
}

describe("useRoles", () => {
  beforeEach(() => {
    getRoles.mockReset();
  });

  it("returns roles past the first page", async () => {
    // Four predefined roles ahead of forty custom ones: reading a single
    // default-size page stopped at the sixth custom role, so the rest went
    // missing from every role picker at once.
    const all = [
      role("admin", true),
      role("platform_admin", true),
      role("editor", true),
      role("member", true),
      ...Array.from({ length: 40 }, (_, i) =>
        role(`custom_${String(i).padStart(2, "0")}`),
      ),
    ];
    serveRoles(all);

    const { result } = renderUseRoles();

    await waitFor(() => expect(result.current.data).toHaveLength(all.length));
    expect(result.current.data?.map((r) => r.role)).toEqual(
      all.map((r) => r.role),
    );
  });

  it("keeps one option per role identifier when a page repeats one", async () => {
    // A custom role named "Admin" generates the identifier `admin`, which the
    // predefined admin already owns. Two options with the same value make the
    // selection ambiguous, so the predefined one — served first — wins.
    serveRoles([
      role("admin", true),
      role("member", true),
      { id: "custom-admin", role: "admin", name: "Admin", predefined: false },
    ]);

    const { result } = renderUseRoles();

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.data?.map((r) => r.id)).toEqual([
      "id-admin",
      "id-member",
    ]);
  });
});
