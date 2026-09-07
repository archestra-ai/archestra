import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  clearPersistedQueryCache,
  PERSISTED_QUERY_META,
  restorePersistedQueryCache,
  syncPersistedQueryCacheScope,
} from "@/lib/query-persistence";
import {
  useImpersonateUser,
  useStopImpersonating,
} from "./impersonation.query";

vi.mock("@/lib/clients/auth/auth-client");
vi.mock("sonner");

const originalLocation = window.location;
const persistedSession = {
  user: { id: "admin-1", email: "admin@example.com" },
  session: { id: "admin-session" },
};
const persistedPermissions = { member: ["impersonate"] };

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderMutation<T>(hook: () => T) {
  const queryClient = makeClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return renderHook(hook, { wrapper });
}

async function seedPersistedAuthSnapshot() {
  const client = makeClient();
  await client.fetchQuery({
    queryKey: authQueryKeys.session(),
    queryFn: async () => persistedSession,
    meta: PERSISTED_QUERY_META,
  });
  await client.fetchQuery({
    queryKey: authQueryKeys.userPermissions(),
    queryFn: async () => persistedPermissions,
    meta: PERSISTED_QUERY_META,
  });
  syncPersistedQueryCacheScope(client, "admin-1:org-1");

  expectRestoredAuthSnapshot(persistedSession, persistedPermissions);
}

function expectRestoredAuthSnapshot(
  session: typeof persistedSession | undefined,
  permissions: typeof persistedPermissions | undefined,
) {
  const restored = makeClient();
  restorePersistedQueryCache(restored);

  expect(restored.getQueryData(authQueryKeys.session())).toEqual(session);
  expect(restored.getQueryData(authQueryKeys.userPermissions())).toEqual(
    permissions,
  );
}

function mockNavigation(onAssign?: () => void) {
  const assign = vi.fn(onAssign);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign },
  });
  return assign;
}

describe("impersonation cache boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPersistedQueryCache();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    clearPersistedQueryCache();
    window.sessionStorage.clear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("removes persisted auth before reloading into an impersonated session", async () => {
    await seedPersistedAuthSnapshot();
    const assign = mockNavigation(() => {
      expectRestoredAuthSnapshot(undefined, undefined);
    });
    vi.mocked(authClient.admin.impersonateUser).mockResolvedValue({
      data: {},
      error: null,
    } as Awaited<ReturnType<typeof authClient.admin.impersonateUser>>);

    const { result } = renderMutation(() => useImpersonateUser());
    await act(async () => {
      await result.current.mutateAsync("member-1");
    });

    expect(assign).toHaveBeenCalledWith("/");
  });

  it("keeps persisted auth when impersonation fails", async () => {
    await seedPersistedAuthSnapshot();
    mockNavigation();
    vi.mocked(authClient.admin.impersonateUser).mockResolvedValue({
      data: null,
      error: new Error("Impersonation denied"),
    } as Awaited<ReturnType<typeof authClient.admin.impersonateUser>>);

    const { result } = renderMutation(() => useImpersonateUser());
    await act(async () => {
      await expect(result.current.mutateAsync("member-1")).rejects.toThrow(
        "Impersonation denied",
      );
    });

    expectRestoredAuthSnapshot(persistedSession, persistedPermissions);
  });

  it("removes persisted auth before reloading into the admin session", async () => {
    await seedPersistedAuthSnapshot();
    const assign = mockNavigation(() => {
      expectRestoredAuthSnapshot(undefined, undefined);
    });
    vi.mocked(authClient.admin.stopImpersonating).mockResolvedValue({
      data: {},
      error: null,
    } as Awaited<ReturnType<typeof authClient.admin.stopImpersonating>>);

    const { result } = renderMutation(() => useStopImpersonating());
    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(assign).toHaveBeenCalledWith("/");
  });

  it("keeps persisted auth when returning to the admin session fails", async () => {
    await seedPersistedAuthSnapshot();
    mockNavigation();
    vi.mocked(authClient.admin.stopImpersonating).mockResolvedValue({
      data: null,
      error: new Error("Return denied"),
    } as Awaited<ReturnType<typeof authClient.admin.stopImpersonating>>);

    const { result } = renderMutation(() => useStopImpersonating());
    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow(
        "Return denied",
      );
    });

    expectRestoredAuthSnapshot(persistedSession, persistedPermissions);
  });
});
