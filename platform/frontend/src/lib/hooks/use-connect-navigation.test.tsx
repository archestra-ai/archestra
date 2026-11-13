import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  organizationKeys,
  useUpdateConnectionSettings,
} from "@/lib/organization.query";
import {
  clearPersistedQueryCache,
  restorePersistedQueryCache,
  syncPersistedQueryCacheScope,
} from "@/lib/query-persistence";
import { useConnectNavigation } from "./use-connect-navigation";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");

const origin = "http://localhost:9000";
const server = setupServer();
let hidden = false;
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  clearPersistedQueryCache();
  hidden = false;
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "member" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  server.use(
    http.get(`${origin}/api/organization`, () =>
      HttpResponse.json({ connectionPageHidden: hidden }),
    ),
    http.patch(
      `${origin}/api/organization/connection-settings`,
      async ({ request }) => {
        const body = (await request.json()) as {
          connectionPageHidden: boolean;
        };
        hidden = body.connectionPageHidden;
        return HttpResponse.json({ connectionPageHidden: hidden });
      },
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  clearPersistedQueryCache();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderNavigation() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rendered = renderHook(
    () => ({
      navigation: useConnectNavigation(),
      save: useUpdateConnectionSettings("Saved", "Failed"),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { ...rendered, client };
}

it("waits for settings, follows successful saves immediately, and keeps the last saved visibility on failure", async () => {
  const { result, client } = renderNavigation();
  expect(result.current.navigation).toEqual({ ready: false, visible: false });
  await waitFor(() => expect(result.current.navigation.visible).toBe(true));
  syncPersistedQueryCacheScope(client, "member:organization");
  const expectRestoredVisibility = (hidden: boolean) => {
    const restored = new QueryClient();
    restorePersistedQueryCache(restored);
    expect(restored.getQueryData(organizationKeys.details())).toMatchObject({
      connectionPageHidden: hidden,
    });
    restored.clear();
  };
  await act(() =>
    result.current.save.mutateAsync({ connectionPageHidden: true }),
  );
  await waitFor(() => expect(result.current.navigation.visible).toBe(false));
  expectRestoredVisibility(true);
  await act(() =>
    result.current.save.mutateAsync({ connectionPageHidden: false }),
  );
  await waitFor(() => expect(result.current.navigation.visible).toBe(true));
  expectRestoredVisibility(false);
  server.use(
    http.patch(`${origin}/api/organization/connection-settings`, () =>
      HttpResponse.json({ error: { message: "Unavailable" } }, { status: 503 }),
    ),
  );
  await act(() =>
    result.current.save.mutateAsync({ connectionPageHidden: true }),
  );
  expect(result.current.navigation.visible).toBe(true);
  expect(hidden).toBe(false);
  expectRestoredVisibility(false);
});

it.each([
  { mcp: true, llm: false, visible: true },
  { mcp: false, llm: true, visible: true },
  { mcp: false, llm: false, visible: false },
])("preserves the either-permission rule: %j", async ({
  mcp,
  llm,
  visible,
}) => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({ data: "mcpGateway" in permissions ? mcp : llm }) as ReturnType<
        typeof useHasPermissions
      >,
  );
  const { result } = renderNavigation();
  await waitFor(() => expect(result.current.navigation.ready).toBe(true));
  expect(result.current.navigation.visible).toBe(visible);
});
