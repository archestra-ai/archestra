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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import AccountConnectionsPage from "./page";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
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
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useFeature).mockImplementation(
    (feature) => feature === "agentRuntime",
  );
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  server.use(
    http.get(`${origin}/api/agents/all`, () => HttpResponse.json([])),
    http.get(`${origin}/api/credentials`, () =>
      HttpResponse.json([
        {
          kind: "github_app_user",
          key: "github",
          name: "GitHub",
          description: "Repository access",
          icon: "logo:github",
          builtIn: true,
          allowPersonal: true,
          allowOrganization: false,
          personalConfigured: true,
          organizationConfigured: false,
        },
      ]),
    ),
  );
});

function renderPage() {
  return render(
    <QueryClientProvider client={client}>
      <AccountConnectionsPage />
    </QueryClientProvider>,
  );
}

describe("AccountConnectionsPage", () => {
  it("opens GitHub sign-in from the row action", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Replace GitHub" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Connect GitHub" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Connect GitHub" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirms before removing a personal connection", async () => {
    const user = userEvent.setup();
    let deleted = false;
    server.use(
      http.delete(`${origin}/api/credentials/github/personal`, () => {
        deleted = true;
        return HttpResponse.json({ deleted: true });
      }),
    );
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "More actions GitHub" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Agent Runtime runs you start will no longer be able to use this connection.",
    );
    expect(deleted).toBe(false);
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(deleted).toBe(true));
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
  });

  it("shows one shared account for multiple installed Claude Agents and opens native sign-in", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${origin}/api/agents/all`, () =>
        HttpResponse.json([
          { id: "other", runtime: { command: ["another-agent"] } },
          { id: "claude-1", runtime: { command: ["archestra-claude-code"] } },
          { id: "claude-2", runtime: { command: ["archestra-claude-code"] } },
        ]),
      ),
      http.get(
        `${origin}/api/agents/claude-1/runtime/claude-code/account`,
        () => HttpResponse.json({ state: "disconnected" }),
      ),
      http.post(
        `${origin}/api/agents/claude-1/runtime/claude-code/account`,
        () =>
          HttpResponse.json({
            state: "awaiting_code",
            flowId: "flow-1",
            authorizationUrl: "https://claude.ai/oauth/authorize",
          }),
      ),
    );
    renderPage();
    expect(await screen.findAllByText("Claude Code")).toHaveLength(1);
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    await user.click(
      screen.getByRole("button", { name: "Sign in with Claude" }),
    );
    expect(
      await screen.findByRole("link", { name: "Open Claude sign-in" }),
    ).toHaveAttribute("href", "https://claude.ai/oauth/authorize");
    expect(screen.getByLabelText("Authorization code")).toBeVisible();
  });

  it("does not hide a failed Agent lookup as an empty connections list", async () => {
    server.use(
      http.get(
        `${origin}/api/agents/all`,
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    renderPage();
    expect(
      await screen.findByText("Couldn't load Agent connections"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
  });
});
