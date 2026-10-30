import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAllMatchingProjects, useProjects } from "./projects.query";

vi.mock("@/lib/auth/auth.query");

const API_ORIGIN = "http://localhost:9000";
const TOTAL = 230;
const requests: URL[] = [];
/** Requests for these offsets wait until released. */
let held = new Map<number, () => void>();

const server = setupServer(
  http.get(`${API_ORIGIN}/api/projects`, async ({ request }) => {
    const url = new URL(request.url);
    requests.push(url);
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    if (held.has(offset)) {
      await new Promise<void>((resolve) => held.set(offset, resolve));
    }
    const count = Math.max(0, Math.min(limit, TOTAL - offset));
    return HttpResponse.json({
      data: Array.from({ length: count }, (_, i) => ({
        id: `p${offset + i}`,
        name: `Project ${offset + i}`,
      })),
      pagination: {
        currentPage: Math.floor(offset / limit) + 1,
        limit,
        total: TOTAL,
        totalPages: Math.ceil(TOTAL / limit),
        hasNext: offset + limit < TOTAL,
        hasPrev: offset > 0,
      },
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  requests.length = 0;
  held = new Map();
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

describe("useProjects", () => {
  it("asks for one page with its filters and pin split", async () => {
    const { result } = renderHook(
      () =>
        useProjects({
          search: "  report ",
          pinned: false,
          limit: 20,
          offset: 40,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    const params = Object.fromEntries(requests[0].searchParams);
    expect(params).toEqual({
      search: "report",
      pinned: "false",
      limit: "20",
      offset: "40",
    });
    expect(result.current.data?.data[0].name).toBe("Project 40");
    expect(result.current.data?.pagination.total).toBe(TOTAL);
  });

  it("keeps the current page on screen while the next one loads", async () => {
    let offset = 0;
    const { result, rerender } = renderHook(
      () => useProjects({ limit: 20, offset }),
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current.data?.data[0].name).toBe("Project 0"),
    );

    held.set(20, () => {});
    offset = 20;
    rerender();
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.data[0].name).toBe("Project 0");

    held.get(20)?.();
    await waitFor(() =>
      expect(result.current.data?.data[0].name).toBe("Project 20"),
    );
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it("does not ask without project:read", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    renderHook(() => useProjects({ pinned: true, limit: 100, offset: 0 }), {
      wrapper,
    });
    expect(requests).toHaveLength(0);
  });
});

describe("useAllMatchingProjects", () => {
  it("walks every page of the match, only once enabled", async () => {
    let enabled = false;
    const { result, rerender } = renderHook(
      () => useAllMatchingProjects({ pinned: false }, { enabled }),
      { wrapper },
    );
    expect(requests).toHaveLength(0);

    enabled = true;
    rerender();
    await waitFor(() => expect(result.current.data).toHaveLength(TOTAL));
    expect(
      requests.map((url) => [
        url.searchParams.get("offset"),
        url.searchParams.get("pinned"),
      ]),
    ).toEqual([
      ["0", "false"],
      ["100", "false"],
      ["200", "false"],
    ]);
  });
});
