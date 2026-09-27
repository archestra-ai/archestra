import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import {
  EnforcementSwitch,
  GuardrailsDeploymentToggle,
} from "./guardrails-deployment-toggle";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
const url = "http://localhost:9000/api/guardrails-deployment";
const server = setupServer();
let enabled: boolean;
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
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
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  server.use(
    http.get(url, () =>
      HttpResponse.json({ enabled, active: enabled, featureEnabled: true }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function show(ui: "sidebar" | "switch" = "switch") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        {ui === "sidebar" ? (
          <SidebarMenu>
            <GuardrailsDeploymentToggle />
          </SidebarMenu>
        ) : (
          <EnforcementSwitch />
        )}
      </SidebarProvider>
    </QueryClientProvider>,
  );
}

test("the sidebar shows the enforcement state and links to the Policy page", async () => {
  show("sidebar");
  const link = await screen.findByRole("link", { name: /OpenAPPA off/ });
  expect(link).toHaveAttribute("href", "/openappa/policy");
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});

test("an administrator turns enforcement on and off", async () => {
  server.use(
    http.put(url, async ({ request }) => {
      const body = (await request.json()) as { enabled: boolean };
      enabled = body.enabled;
      return HttpResponse.json({
        enabled,
        active: enabled,
        featureEnabled: true,
      });
    }),
  );
  show();
  const toggle = await screen.findByRole("switch", { name: "Enforcement" });
  fireEvent.click(toggle);
  expect(await screen.findByText(/Every tool call is checked/)).toBeVisible();
  expect(toggle).toBeChecked();
  await waitFor(() => expect(toggle).toBeEnabled());
  fireEvent.click(toggle);
  expect(await screen.findByText(/Tool calls run without/)).toBeVisible();
  expect(toggle).not.toBeChecked();
});

test("a rejected update keeps the accepted deployment state", async () => {
  server.use(http.put(url, () => new HttpResponse(null, { status: 403 })));
  show();
  const toggle = await screen.findByRole("switch", { name: "Enforcement" });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).not.toBeChecked();
});

test.each([
  "permission",
  "feature flag",
])("cannot turn enforcement on without the %s", async (missing) => {
  if (missing === "permission")
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
      typeof useHasPermissions
    >);
  else
    server.use(
      http.get(url, () =>
        HttpResponse.json({
          enabled: false,
          active: false,
          featureEnabled: false,
        }),
      ),
    );
  show();
  const toggle = await screen.findByRole("switch", { name: "Enforcement" });
  expect(toggle).toBeDisabled();
});
