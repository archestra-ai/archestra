import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { toast } from "sonner";
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

vi.mock("sonner");

vi.mock("@/lib/auth/auth.query");

import {
  useBulkDeleteLlmProviderApiKeys,
  useHasAnyApiKey,
  useLlmProviderApiKeys,
} from "./llm-provider-api-keys.query";

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();
let listRequests = 0;
let bulkRequestBody: unknown;

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
beforeEach(() => {
  vi.clearAllMocks();
  listRequests = 0;
  bulkRequestBody = undefined;
  server.use(
    http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () => {
      listRequests += 1;
      return HttpResponse.json([]);
    }),
    http.delete(
      `${API_ORIGIN}/api/llm-provider-api-keys/bulk`,
      async ({ request }) => {
        bulkRequestBody = await request.json();
        return HttpResponse.json({
          succeeded: [{ id: "key-1", name: "First" }],
          failed: [],
        });
      },
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useLlmProviderApiKeys", () => {
  it("enters the error state when the request fails (instead of returning [])", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json(
          { error: { message: "Network request failed" } },
          { status: 500 },
        ),
      ),
    );

    const { result } = renderHook(() => useLlmProviderApiKeys({}), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // First-fetch failure with no cached data — the signal the gating screens
    // branch on to show the load-error state.
    expect(result.current.isLoadingError).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("does not toast on failure when toastOnError is false", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json(
          { error: { message: "Network request failed" } },
          { status: 500 },
        ),
      ),
    );

    const { result } = renderHook(
      () => useLlmProviderApiKeys({ toastOnError: false }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("returns the keys on success without an error", async () => {
    const { result } = renderHook(() => useLlmProviderApiKeys({}), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toEqual([]);
  });
});

describe("useHasAnyApiKey", () => {
  beforeEach(() => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as unknown as ReturnType<typeof useHasPermissions>);
  });

  it("reports a load error when the first keys fetch fails", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json(
          { error: { message: "Network request failed" } },
          { status: 500 },
        ),
      ),
    );

    const { result } = renderHook(() => useHasAnyApiKey(), { wrapper });

    await waitFor(() => expect(result.current.isLoadError).toBe(true));
    expect(result.current.hasAnyApiKey).toBe(false);
  });

  it("does not run the query or report a load error without read permission", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as unknown as ReturnType<typeof useHasPermissions>);

    const { result } = renderHook(() => useHasAnyApiKey(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isLoadError).toBe(false);
    expect(listRequests).toBe(0);
  });

  it("reports a configured key when the fetch succeeds with keys", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([{ id: "key-1" }]),
      ),
    );

    const { result } = renderHook(() => useHasAnyApiKey(), { wrapper });

    await waitFor(() => expect(result.current.hasAnyApiKey).toBe(true));
    expect(result.current.isLoadError).toBe(false);
  });
});

describe("useBulkDeleteLlmProviderApiKeys", () => {
  it("sends selected ids through the bulk HTTP endpoint", async () => {
    const { result } = renderHook(() => useBulkDeleteLlmProviderApiKeys(), {
      wrapper,
    });

    await expect(
      result.current.mutateAsync([{ id: "key-1" }]),
    ).resolves.toEqual({ succeeded: ["First"], failed: [] });
    expect(bulkRequestBody).toEqual({ ids: ["key-1"] });
  });
});
