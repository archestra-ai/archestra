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
} from "vitest";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar";
import { GuardrailsDisabledWarning } from "./guardrails-deployment-toggle";

const url = "http://localhost:9000/api/guardrails-deployment";
const server = setupServer();
let enabled: boolean;
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  enabled = false;
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
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
  return render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <SidebarMenu>
          <GuardrailsDisabledWarning />
        </SidebarMenu>
      </SidebarProvider>
    </QueryClientProvider>,
  );
}

test("the sidebar warns while enforcement is off and links to the Guardrails page", async () => {
  show();
  const link = await screen.findByRole("link", { name: /Guardrails disabled/ });
  expect(link).toHaveAttribute("href", "/openappa");
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});

test("the sidebar says nothing once enforcement is on", async () => {
  enabled = true;
  const { container } = show();
  // Nothing to warn about, so no row at all — not a row reporting success.
  await waitFor(() => expect(container.querySelector("li")).toBeNull());
  expect(screen.queryByText(/Guardrails/)).toBeNull();
});
