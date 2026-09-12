import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
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

it("shows download progress then exposes the authorization link through real polling", async () => {
  const user = userEvent.setup();
  let account: archestraApiTypes.GetClaudeCodeAccountResponses["200"] = {
    state: "disconnected",
  };
  server.use(http.get(accountUrl, () => HttpResponse.json(account)));
  server.use(
    http.post(accountUrl, () => {
      account = { state: "starting", startupPhase: "pulling" };
      return HttpResponse.json(account);
    }),
  );
  renderAccount();
  await user.click(await screen.findByRole("button", { name: "Sign in" }));
  await user.click(screen.getByRole("button", { name: "Sign in with Claude" }));
  expect(
    await screen.findByText("Downloading the Claude Code runtime…"),
  ).toBeVisible();
  account = {
    state: "awaiting_code",
    flowId: "00000000-0000-4000-8000-000000000001",
    authorizationUrl: "https://claude.ai/oauth/authorize?state=test",
  };
  expect(
    await screen.findByRole(
      "link",
      { name: "Open Claude sign-in" },
      { timeout: 3000 },
    ),
  ).toHaveAttribute("href", account.authorizationUrl);
  expect(screen.getByLabelText("Authorization code")).toBeVisible();
  expect(
    screen.queryByText("Downloading the Claude Code runtime…"),
  ).not.toBeInTheDocument();
});

it("replaces a failed image pull with an explanation and lets the user retry", async () => {
  const user = userEvent.setup();
  let account: archestraApiTypes.GetClaudeCodeAccountResponses["200"] = {
    state: "disconnected",
  };
  server.use(http.get(accountUrl, () => HttpResponse.json(account)));
  account = { state: "failed", startupIssue: "image_pull" };
  server.use(
    http.post(accountUrl, () => {
      account = {
        state: "starting",
        startupPhase: "scheduling",
        startupIssue: "capacity",
      };
      return HttpResponse.json(account);
    }),
  );
  renderAccount();
  await user.click(await screen.findByRole("button", { name: "Sign in" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "image and registry access",
  );
  await user.click(screen.getByRole("button", { name: "Sign in with Claude" }));
  expect(
    await screen.findByText("Waiting for available capacity…"),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
