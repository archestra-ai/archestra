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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { GuardrailsDeploymentToggle } from "./guardrails-deployment-toggle";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
const url = "http://localhost:9000/api/guardrails-deployment";
const server = setupServer();
let enabled: boolean;
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
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
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GuardrailsDeploymentToggle />
    </QueryClientProvider>,
  );
}

test("enables both engines deployment-wide and disables only APPA", async () => {
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
  const toggle = await screen.findByRole("switch", {
    name: "Enable Guardrails v2",
  });
  expect(toggle).not.toBeChecked();
  expect(screen.getByText("All organizations")).toBeVisible();
  fireEvent.click(toggle);
  expect(
    await screen.findByText("Both guardrails engines are active."),
  ).toBeVisible();
  await waitFor(() => expect(toggle).toBeEnabled());
  fireEvent.click(toggle);
  expect(
    await screen.findByText(
      "Existing guardrails are active. APPA enforcement is off.",
    ),
  ).toBeVisible();
  expect(toggle).not.toBeChecked();
});

test("a rejected update keeps the accepted deployment state", async () => {
  server.use(http.put(url, () => new HttpResponse(null, { status: 403 })));
  show();
  const toggle = await screen.findByRole("switch", {
    name: "Enable Guardrails v2",
  });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).not.toBeChecked();
  expect(
    screen.getByText(
      "Existing guardrails are active. APPA enforcement is off.",
    ),
  ).toBeVisible();
});

test.each([
  "permission",
  "feature flag",
])("cannot enable APPA without the %s", async (missing) => {
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
  expect(
    await screen.findByRole("switch", { name: "Enable Guardrails v2" }),
  ).toBeDisabled();
});
