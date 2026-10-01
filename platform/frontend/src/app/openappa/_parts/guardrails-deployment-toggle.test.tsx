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
  GuardrailsDisabledWarning,
  UnsupportedClientActionSelect,
} from "./guardrails-deployment-toggle";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
const url = "http://localhost:9000/api/guardrails-deployment";
const server = setupServer();
let enabled: boolean;
let unsupportedClientAction: "bypass" | "block";
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
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
  unsupportedClientAction = "bypass";
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
        unsupportedClientAction,
      }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function show(ui: "sidebar" | "unsupported" = "unsupported") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        {ui === "sidebar" ? (
          <SidebarMenu>
            <GuardrailsDisabledWarning />
          </SidebarMenu>
        ) : (
          <UnsupportedClientActionSelect />
        )}
      </SidebarProvider>
    </QueryClientProvider>,
  );
}

test("the sidebar warns while enforcement is off and links to the Guardrails page", async () => {
  show("sidebar");
  const link = await screen.findByRole("link", { name: /Guardrails disabled/ });
  expect(link).toHaveAttribute("href", "/openappa");
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});

test("the sidebar says nothing once enforcement is on", async () => {
  enabled = true;
  const { container } = show("sidebar");
  // Nothing to warn about, so no row at all — not a row reporting success.
  await waitFor(() => expect(container.querySelector("li")).toBeNull());
  expect(screen.queryByText(/Guardrails/)).toBeNull();
});

test("an administrator selects whether unsupported clients bypass or block", async () => {
  const updates: unknown[] = [];
  server.use(
    http.put(url, async ({ request }) => {
      const body = (await request.json()) as {
        unsupportedClientAction: "bypass" | "block";
      };
      updates.push(body);
      unsupportedClientAction = body.unsupportedClientAction;
      return HttpResponse.json({
        enabled,
        active: enabled,
        featureEnabled: true,
        unsupportedClientAction,
      });
    }),
  );
  show();
  const selector = await screen.findByRole("combobox", {
    name: "Unsupported clients",
  });
  expect(selector).toHaveTextContent("Bypass");
  fireEvent.click(selector);
  fireEvent.click(screen.getByRole("option", { name: "Block" }));
  await waitFor(() =>
    expect(updates).toEqual([{ unsupportedClientAction: "block" }]),
  );
  expect(selector).toHaveTextContent("Block");
});

test("a non-admin cannot change unsupported client behavior", async () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data:
          permissions.openappaSettings?.every((action) => action === "read") ??
          false,
      }) as ReturnType<typeof useHasPermissions>,
  );
  show();
  expect(
    await screen.findByRole("combobox", {
      name: "Unsupported clients",
    }),
  ).toBeDisabled();
});

test("a rejected update keeps the accepted unsupported-client setting", async () => {
  const rejected = vi.fn(() => new HttpResponse(null, { status: 403 }));
  server.use(http.put(url, rejected));
  show();
  const selector = await screen.findByRole("combobox", {
    name: "Unsupported clients",
  });
  fireEvent.click(selector);
  fireEvent.click(screen.getByRole("option", { name: "Block" }));
  await waitFor(() => expect(rejected).toHaveBeenCalledOnce());
  expect(selector).toHaveTextContent("Bypass");
});

test("the unsupported-client setting is disabled without the feature flag", async () => {
  server.use(
    http.get(url, () =>
      HttpResponse.json({
        enabled: false,
        active: false,
        featureEnabled: false,
        unsupportedClientAction: "bypass",
      }),
    ),
  );
  show();
  expect(
    await screen.findByRole("combobox", {
      name: "Unsupported clients",
    }),
  ).toBeDisabled();
});
