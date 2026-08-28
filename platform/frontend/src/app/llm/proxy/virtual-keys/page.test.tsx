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
  describe,
  expect,
  it,
  vi,
} from "vitest";

const API_ORIGIN = "http://localhost:9000";
const PROVIDER_KEY_ID = "11111111-2222-4333-8444-555555555555";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("sonner");

vi.mock("next/image", () => ({
  default: ({
    alt,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { alt: string }) => (
    <img alt={alt} {...props} />
  ),
}));

import { useRouter, useSearchParams } from "next/navigation";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import VirtualKeysPage from "./page";

/** Query params the page actually asked the list endpoint for. */
let listRequests: URLSearchParams[] = [];

const server = setupServer(
  http.get(`${API_ORIGIN}/api/llm-virtual-keys`, ({ request }) => {
    listRequests.push(new URL(request.url).searchParams);
    return HttpResponse.json({
      data: [],
      pagination: {
        currentPage: 1,
        limit: 10,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    });
  }),
  http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
    HttpResponse.json([
      {
        id: PROVIDER_KEY_ID,
        name: "Shared Anthropic credential",
        provider: "anthropic",
        scope: "org",
      },
    ]),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderPage(query: string) {
  listRequests = [];
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>,
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <VirtualKeysPage />
    </QueryClientProvider>,
  );
}

describe("VirtualKeysPage provider-key filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useOrganization>);
  });

  it("narrows the list to the provider key named in the URL", async () => {
    // The deep link the blocked-delete dialog builds: landing here unfiltered
    // is the bug this filter exists to fix.
    renderPage(`providerApiKeyId=${PROVIDER_KEY_ID}`);

    await waitFor(() => expect(listRequests.length).toBeGreaterThan(0));
    expect(listRequests.at(-1)?.get("providerApiKeyId")).toBe(PROVIDER_KEY_ID);
  });

  it("names the deep-linked provider key in the filter bar", async () => {
    renderPage(`providerApiKeyId=${PROVIDER_KEY_ID}`);

    // A filter that narrows the table without saying so reads as an
    // inexplicably empty page.
    const trigger = await screen.findByRole("button", {
      name: "Filter by provider key",
    });
    await waitFor(() =>
      expect(trigger).toHaveTextContent("Shared Anthropic credential"),
    );
  });

  it("ignores a malformed provider key id rather than asking the API for it", async () => {
    // The endpoint 400s on a non-UUID, and the error panel it would render
    // replaces the filter bar — leaving no way to clear the bad param.
    renderPage("providerApiKeyId=not-a-uuid");

    await waitFor(() => expect(listRequests.length).toBeGreaterThan(0));
    expect(listRequests.at(-1)?.has("providerApiKeyId")).toBe(false);
    expect(
      await screen.findByRole("button", { name: "Filter by provider key" }),
    ).toHaveTextContent("All provider keys");
  });
});
