import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
} from "vitest";
import { ClaudeCodeAccount } from "./claude-code-account";

const origin = "http://localhost:9000";
const accountUrl = `${origin}/api/agents/agent-1/runtime/claude-code/account`;
const server = setupServer();
let queryClient: QueryClient;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => {
  server.resetHandlers();
  queryClient.clear();
});
beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  archestraApiClient.setConfig({ baseUrl: origin });
});

describe("ClaudeCodeAccount setup", () => {
  it("guides an unconnected user from account status to native sign-in", async () => {
    const user = userEvent.setup();
    let started = false;
    const status = () =>
      started
        ? {
            state: "awaiting_code",
            flowId: "flow-1",
            authorizationUrl: "https://claude.ai/oauth/authorize",
          }
        : { state: "disconnected" };
    server.use(
      http.get(accountUrl, () => HttpResponse.json(status())),
      http.post(accountUrl, () => {
        started = true;
        return HttpResponse.json(status());
      }),
    );
    renderAccount();

    expect(await screen.findByText("Sign in to use this agent.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      screen.getByRole("dialog", { name: "Connect Claude Code" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Sign in with Claude" }),
    );

    expect(
      await screen.findByRole("link", { name: "Open Claude sign-in" }),
    ).toHaveAttribute("href", "https://claude.ai/oauth/authorize");
    expect(screen.getByLabelText("Authorization code")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Complete sign-in" }),
    ).toBeDisabled();
  });

  it("lets an already-connected user manage their account without asking them to sign in again", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(accountUrl, () => HttpResponse.json({ state: "connected" })),
    );
    renderAccount();

    expect(await screen.findByText("Signed in for you")).toBeVisible();
    expect(
      screen.queryByText("Sign in to use this agent."),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(
      screen.getByRole("dialog", { name: "Claude Code account" }),
    ).toBeVisible();
    expect(screen.getByText("Connected for you")).toBeVisible();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Sign in with Claude" }),
    ).not.toBeInTheDocument();
  });
});

function renderAccount() {
  render(
    <QueryClientProvider client={queryClient}>
      <ClaudeCodeAccount agentId="agent-1" />
    </QueryClientProvider>,
  );
}
