import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname } from "next/navigation";
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
import { useFeature } from "@/lib/config/config.query";
import { AccountSectionNav } from "./account-section-nav";

vi.mock("next/navigation");
vi.mock("@/lib/config/config.query");

const origin = "http://localhost:9000";
const server = setupServer();
let client: QueryClient;
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => {
  server.resetHandlers();
  client.clear();
});
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useFeature).mockImplementation(
    (feature) => feature === "agentRuntime",
  );
  server.use(
    http.get(`${origin}/api/agents/all`, () => HttpResponse.json([])),
    http.get(`${origin}/api/credentials`, () =>
      HttpResponse.json([{ allowPersonal: true }]),
    ),
  );
});

function renderNav() {
  return render(
    <QueryClientProvider client={client}>
      <AccountSectionNav />
    </QueryClientProvider>,
  );
}

describe("AccountSectionNav", () => {
  it("links every available section to its own route", async () => {
    vi.mocked(usePathname).mockReturnValue("/account");
    renderNav();

    expect(screen.getByRole("link", { name: "API Keys" })).toHaveAttribute(
      "href",
      "/account/api-keys",
    );
    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "href",
      "/account/sessions",
    );
    expect(
      await screen.findByRole("link", { name: "Connections" }),
    ).toHaveAttribute("href", "/account/connections");
  });

  it("marks only the section matching the pathname as the current page", () => {
    vi.mocked(usePathname).mockReturnValue("/account/sessions");
    renderNav();

    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Profile" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("treats the bare /account path as Profile", () => {
    vi.mocked(usePathname).mockReturnValue("/account");
    renderNav();
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
