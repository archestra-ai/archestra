import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import LlmProxyPage from "./page";

const API_ORIGIN = "http://localhost:9000";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/config/config.query");

const server = setupServer(
  http.get(`${API_ORIGIN}/api/llm-proxy`, () =>
    HttpResponse.json({ id: "proxy-1", identityProviderId: null }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LlmProxyPage />
    </QueryClientProvider>,
  );
}

describe("LlmProxyPage provider dropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
  });

  it("defaults to the Model Router endpoint", async () => {
    renderPage();

    expect(
      await screen.findByText("http://localhost:3000/v1/model-router"),
    ).toBeInTheDocument();
  });

  it("searches the long-tail providers and switches the endpoint on selection", async () => {
    const user = userEvent.setup();
    renderPage();

    const moreTrigger = await screen.findByRole("combobox", {
      name: "More providers",
    });
    await user.click(moreTrigger);

    // Unfiltered, the long-tail list is reachable — the exact set the old
    // hand-rolled combobox listed behind the "…" tab.
    expect(await screen.findByText("Cohere")).toBeInTheDocument();
    expect(screen.getByText("Mistral AI")).toBeInTheDocument();

    // Each entry renders its provider logo, matching the canonical provider
    // dropdown used elsewhere (e.g. the Add API Key form) rather than a bare
    // text list. Radix portals the popover content onto document.body, so
    // search from there rather than the render container.
    expect(document.querySelector('img[src*="mistral"]')).toBeInTheDocument();
    expect(document.querySelector('img[src*="cohere"]')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search providers..."), "mist");

    await waitFor(() => {
      expect(screen.queryByText("Cohere")).not.toBeInTheDocument();
    });
    const mistralOption = screen.getByText("Mistral AI");
    expect(mistralOption).toBeInTheDocument();

    await user.click(mistralOption);

    // Selecting from the search dropdown promotes the provider to its own
    // active tab and repoints the endpoint at it, same as the tab bar does
    // for the built-in primary providers.
    expect(
      await screen.findByText("http://localhost:3000/v1/mistral"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Mistral AI" }),
    ).toBeInTheDocument();
  });
});
