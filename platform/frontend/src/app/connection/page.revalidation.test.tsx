import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useSearchParams } from "next/navigation";
import { afterEach, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useConfig } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { makeOrganization } from "@/mocks/data/organization";
import ConnectionPage from "./page";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");

const server = setupServer();
afterEach(() => server.close());

it("keeps client switching available while a newly mounted catalog revalidates settings", async () => {
  const origin = "http://localhost:9000";
  const organization = makeOrganization({
    connectionSkillsEnabled: false,
    connectionLlmProxyEnabled: false,
    connectionPluginsEnabled: false,
  });
  let reads = 0;
  let releaseRead: () => void = () => {};
  const pendingRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  server.use(
    http.get(`${origin}/api/organization`, async () => {
      reads++;
      if (reads > 1) await pendingRead;
      return HttpResponse.json(organization);
    }),
    http.get(`${origin}/api/mcp-gateways/default`, () =>
      HttpResponse.json(null),
    ),
    http.get(`${origin}/api/agents/all`, () => HttpResponse.json([])),
    http.get(`${origin}/api/llm-provider-api-keys/available`, () =>
      HttpResponse.json([]),
    ),
    http.get(`${origin}/api/llm-models/available`, () => HttpResponse.json([])),
  );
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useAppName).mockReturnValue("Example Platform");
  vi.mocked(useConfig).mockReturnValue({ data: { features: {} } } as ReturnType<
    typeof useConfig
  >);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("clientId=claude-code") as ReturnType<
      typeof useSearchParams
    >,
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ConnectionPage />
    </QueryClientProvider>,
  );
  try {
    await screen.findByRole("heading", { name: "Connect Claude Code" });
    await user.click(
      screen.getByRole("button", { name: /Claude Desktop logo/ }),
    );
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(
      screen.getByRole("heading", { name: "Choose your app" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("status", { name: "Checking connection settings" }),
    ).toBeNull();
    const desktop = screen.getByRole("button", { name: /Claude Desktop logo/ });
    expect(desktop.closest("[inert]")).toBeNull();
    expect(
      screen.getByText(/Nothing to connect yet/).closest("[inert]"),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /Cursor logo/ }));
    expect(
      screen.getByRole("heading", { name: "Connect Cursor" }),
    ).toBeVisible();
    await act(async () => releaseRead());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copy prompt" }).closest("[inert]"),
      ).toBeNull(),
    );
  } finally {
    releaseRead();
    view.unmount();
    queryClient.clear();
  }
});
