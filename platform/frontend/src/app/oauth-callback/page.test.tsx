import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useRouter, useSearchParams } from "next/navigation";
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
import { setOAuthReturnUrl, setOAuthState } from "@/lib/auth/oauth-session";
import OAuthCallbackPage from "./page";

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();
const replace = vi.fn();
const push = vi.fn();

vi.mock("next/navigation");
vi.mock("sonner");

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(useRouter).mockReturnValue({ replace, push } as never);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("code=code-1&state=state-1") as never,
  );
  setOAuthState("state-1");
  setOAuthReturnUrl(`${window.location.origin}/mcp/registry?search=hugging`);
  // The sign-in itself always works in these tests.
  server.use(
    http.post(`${API_ORIGIN}/api/oauth/callback`, () =>
      HttpResponse.json({
        success: true,
        catalogId: "catalog-1",
        name: "Hugging Face",
        accessToken: "token",
        secretId: "secret-1",
      }),
    ),
  );
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <OAuthCallbackPage />
    </QueryClientProvider>,
  );
}

describe("OAuthCallbackPage", () => {
  it("says why the server was not connected when the install fails after a sign-in that worked", async () => {
    server.use(
      http.post(`${API_ORIGIN}/api/mcp_server`, () =>
        HttpResponse.json(
          {
            error: {
              message:
                "Failed to connect to MCP server Hugging Face: Upstream MCP server returned HTTP 429 while listing tools. The MCP server is limiting requests. Try again in a minute.",
              type: "api_validation_error",
            },
          },
          { status: 400 },
        ),
      ),
    );

    renderPage();

    // The page stays and explains. It used to go back to where the person
    // came from, where nothing said that the install had failed.
    expect(
      await screen.findByText("MCP Server Not Connected"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your sign-in worked, but Hugging Face was not connected. Upstream MCP server returned HTTP 429 while listing tools. The MCP server is limiting requests. Try again in a minute.",
      ),
    ).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Go Back" })).toBeInTheDocument();
  });

  it("returns to the page the install started from when it succeeds", async () => {
    server.use(
      http.post(`${API_ORIGIN}/api/mcp_server`, () =>
        HttpResponse.json({ id: "server-1", name: "Hugging Face" }),
      ),
    );

    renderPage();

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/mcp/registry?search=hugging"),
    );
    expect(
      screen.queryByText("MCP Server Not Connected"),
    ).not.toBeInTheDocument();
  });
});
