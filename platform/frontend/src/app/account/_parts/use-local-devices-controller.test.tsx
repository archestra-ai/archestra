import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { useLocalDevicesController } from "./use-local-devices-controller";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("sonner");
const server = setupServer();
const origin = "http://localhost:9000";
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
test("loads device presence without requiring a desktop artifact or creating an enrollment", async () => {
  vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useOrganization).mockReturnValue({
    data: { deviceMcpEnabled: true },
    isPending: false,
  } as ReturnType<typeof useOrganization>);
  server.use(
    http.get(`${origin}/api/local-devices`, () =>
      HttpResponse.json([
        {
          id: "computer",
          name: "Work computer",
          platform: "linux",
          arch: "x64",
          appVersion: "background-1",
          status: "online",
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      ]),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(useLocalDevicesController, {
    wrapper,
  });
  await waitFor(() => expect(result.current.availability).toBe("ready"));
  expect(result.current.devices).toHaveLength(1);
  expect(result.current.devices[0].status).toBe("online");
  unmount();
  client.clear();
});
