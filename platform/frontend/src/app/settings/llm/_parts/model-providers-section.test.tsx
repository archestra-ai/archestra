import {
  archestraApiClient,
  type ModelProviderOverrides,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  useHasPermissions,
  useMissingPermissions,
  useSession,
} from "@/lib/auth/auth.query";
import { ModelProvidersSection } from "./model-providers-section";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");

const API_ORIGIN = "http://localhost:9000";
let overrides: ModelProviderOverrides | null;
let savedBodies: unknown[];
const server = setupServer(
  http.get(`${API_ORIGIN}/api/organization`, () =>
    HttpResponse.json({ modelProviderOverrides: overrides }),
  ),
  http.patch(
    `${API_ORIGIN}/api/organization/integration-settings`,
    async ({ request }) => {
      const body = (await request.json()) as {
        modelProviderOverrides: ModelProviderOverrides | null;
      };
      savedBodies.push(body);
      overrides = body.modelProviderOverrides;
      return HttpResponse.json({ modelProviderOverrides: overrides });
    },
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});

beforeEach(() => {
  vi.clearAllMocks();
  overrides = { openrouter: { displayName: "Reviewed models" } };
  savedBodies = [];
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "admin-1" } },
    isPending: false,
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue({});
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/settings/llm");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
});

afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("ModelProvidersSection new-model visibility", () => {
  it("saves automatic hiding, reloads the saved value, and clears it when re-enabled", async () => {
    const user = userEvent.setup();
    const first = renderSection();
    await screen.findByDisplayValue("Reviewed models");
    const provider = within(
      screen.getByTestId("model-provider-row-openrouter"),
    );
    const toggle = provider.getByRole("switch", {
      name: "Show new models automatically",
    });
    expect(toggle).toBeChecked();
    expect(
      provider.getByText(
        "Models this provider adds later appear in pickers as soon as they are synced.",
      ),
    ).toBeVisible();

    await user.click(toggle);
    expect(
      provider.getByText(
        "Models this provider adds later stay hidden until you show them on the Models page.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(savedBodies).toEqual([
        {
          modelProviderOverrides: {
            openrouter: {
              displayName: "Reviewed models",
              showNewModelsAutomatically: false,
            },
          },
        },
      ]),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument(),
    );

    first.unmount();
    renderSection();
    await screen.findByDisplayValue("Reviewed models");
    const reloadedToggle = within(
      screen.getByTestId("model-provider-row-openrouter"),
    ).getByRole("switch", { name: "Show new models automatically" });
    expect(reloadedToggle).not.toBeChecked();
    await user.click(reloadedToggle);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(savedBodies[1]).toEqual({
        modelProviderOverrides: {
          openrouter: { displayName: "Reviewed models" },
        },
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("locks the switch while its provider is off and preserves its saved preference", async () => {
    overrides = {
      openrouter: {
        hidden: true,
        displayName: "Reviewed models",
        showNewModelsAutomatically: false,
      },
    };
    const user = userEvent.setup();
    renderSection();
    await screen.findByDisplayValue("Reviewed models");
    const provider = within(
      screen.getByTestId("model-provider-row-openrouter"),
    );
    const toggle = provider.getByRole("switch", {
      name: "Show new models automatically",
    });
    expect(toggle).toBeDisabled();
    expect(
      provider.getByText("Turn the provider on to change this."),
    ).toBeVisible();
    await user.click(toggle);
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();

    await user.click(
      provider.getByRole("switch", { name: "Make OpenRouter available" }),
    );
    expect(toggle).toBeEnabled();
    expect(toggle).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(savedBodies).toEqual([
        {
          modelProviderOverrides: {
            openrouter: {
              displayName: "Reviewed models",
              showNewModelsAutomatically: false,
            },
          },
        },
      ]),
    );
  });

  it("requires the section's organization-settings permission to change arrival visibility", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    renderSection();
    await screen.findByDisplayValue("Reviewed models");
    const toggle = within(
      screen.getByTestId("model-provider-row-openrouter"),
    ).getByRole("switch", { name: "Show new models automatically" });
    expect(toggle).toBeDisabled();
    await userEvent.click(toggle);
    expect(savedBodies).toEqual([]);
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });
});

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ModelProvidersSection />
    </QueryClientProvider>,
  );
}
