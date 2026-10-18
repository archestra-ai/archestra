import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  GuardrailsDisabledWarning,
  GuardrailsSnapshotPolicyWarning,
} from "./guardrails-deployment-toggle";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
const url = "http://localhost:9000/api/guardrails-deployment";
const server = setupServer();
let enabled: boolean;
let newSessionPolicy: "live" | "snapshot";
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  // The Guardrails status is read only while OpenAPPA is on.
  vi.mocked(useFeature).mockImplementation(
    (feature) => feature === "openappaEnabled",
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })),
  );
  enabled = false;
  newSessionPolicy = "live";
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  server.use(
    http.get(url, () =>
      HttpResponse.json({
        enabled,
        active: enabled,
        featureEnabled: true,
        unsupportedClientAction: "bypass",
        newSessionPolicy,
      }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function show(row: React.ReactNode = <GuardrailsDisabledWarning />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <SidebarMenu>{row}</SidebarMenu>
      </SidebarProvider>
    </QueryClientProvider>,
  );
  return { client, ...view };
}

test("the sidebar warns while enforcement is off and links to the Guardrails page", async () => {
  show();
  const link = await screen.findByRole("link", { name: /Guardrails disabled/ });
  expect(link).toHaveAttribute("href", "/openappa");
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});

test("the sidebar says nothing once enforcement is on", async () => {
  enabled = true;
  const { client, container } = show();
  await waitFor(() =>
    expect(client.getQueryState(["guardrails-deployment"])?.status).toBe(
      "success",
    ),
  );
  // Nothing to warn about, so no row at all — not a row reporting success.
  expect(container.querySelector("li")).toBeNull();
  expect(screen.queryByText(/Guardrails/)).toBeNull();
});

test("the sidebar warns while new sessions keep a policy snapshot and links to the setting", async () => {
  enabled = true;
  newSessionPolicy = "snapshot";
  show(<GuardrailsSnapshotPolicyWarning />);
  const link = await screen.findByRole("link", {
    name: /New sessions keep a policy snapshot/,
  });
  expect(link).toHaveAttribute(
    "href",
    "/settings/guardrails#new-session-policy",
  );
});

test("the sidebar says nothing about the policy for new sessions while it is live", async () => {
  enabled = true;
  const { client, container } = show(<GuardrailsSnapshotPolicyWarning />);
  await waitFor(() =>
    expect(client.getQueryState(["guardrails-deployment"])?.status).toBe(
      "success",
    ),
  );
  expect(container.querySelector("li")).toBeNull();
});
