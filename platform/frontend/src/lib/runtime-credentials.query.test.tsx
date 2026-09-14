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
} from "vitest";
import {
  clearPersistedQueryCache,
  restorePersistedQueryCache,
  startPersistingQueryCache,
  syncPersistedQueryCacheScope,
} from "@/lib/query-persistence";
import {
  runtimeCredentialsQueryKey,
  useRuntimeCredentials,
} from "./runtime-credentials.query";

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();

const definition = {
  key: "github",
  name: "GitHub PAT",
  description: "Access GitHub repositories",
  icon: "logo:github",
  builtIn: true,
  allowPersonal: true,
  allowOrganization: false,
  personalConfigured: false,
  organizationConfigured: false,
};

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
beforeEach(() => {
  clearPersistedQueryCache();
  window.sessionStorage.clear();
  server.use(
    http.get(`${API_ORIGIN}/api/credentials`, () =>
      HttpResponse.json([definition]),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  clearPersistedQueryCache();
  window.sessionStorage.clear();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

async function flushWrites() {
  await new Promise((resolve) => setTimeout(resolve, 600));
}

describe("useRuntimeCredentials persistence", () => {
  it("survives a refresh, so a returning visit paints saved credentials without a loading placeholder", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const stopPersisting = startPersistingQueryCache(client);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useRuntimeCredentials(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    syncPersistedQueryCacheScope(client, "user-1:org-1");
    await flushWrites();
    stopPersisting();

    // A fresh QueryClient stands in for the one a page refresh creates: the
    // in-memory cache from the render above is gone, so only a restore from
    // the snapshot can supply data before any network request resolves.
    const restored = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    restorePersistedQueryCache(restored);

    expect(restored.getQueryData(runtimeCredentialsQueryKey)).toEqual([
      definition,
    ]);
  });

  it("revalidates a restored connection status on mount instead of trusting it for staleTime", async () => {
    const restored = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    // Simulate a restore landing a snapshot taken before another tab
    // disconnected this credential: the definition here still says connected.
    restored.setQueryData(runtimeCredentialsQueryKey, [
      { ...definition, personalConfigured: true },
    ]);
    server.use(
      http.get(`${API_ORIGIN}/api/credentials`, () =>
        HttpResponse.json([{ ...definition, personalConfigured: false }]),
      ),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={restored}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useRuntimeCredentials(), { wrapper });

    // The restored (stale) value paints immediately, with no pending state.
    expect(result.current.isPending).toBe(false);
    expect(result.current.data?.[0].personalConfigured).toBe(true);

    await waitFor(() =>
      expect(result.current.data?.[0].personalConfigured).toBe(false),
    );
  });
});
