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
  vi,
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
  it.each([
    "card",
    "compact",
  ] as const)("takes an unconnected user from %s status straight to native sign-in", async (variant) => {
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
    renderAccount(variant);

    expect(await screen.findByText("Sign in to use this agent.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      screen.getByRole("dialog", { name: "Connect Claude Code" }),
    ).toBeVisible();

    // The click that opened the dialog already started the flow.
    expect(
      await screen.findByRole("link", { name: "Open Claude" }),
    ).toHaveAttribute("href", "https://claude.ai/oauth/authorize");
    expect(
      screen.queryByRole("button", { name: "Sign in with Claude" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Authorization code")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Complete sign-in" }),
    ).toBeDisabled();
  });

  it.each([
    "card",
    "compact",
  ] as const)("lets an already-connected user manage their %s account without asking them to sign in again", async (variant) => {
    const user = userEvent.setup();
    server.use(
      http.get(accountUrl, () => HttpResponse.json({ state: "connected" })),
    );
    renderAccount(variant);

    expect(await screen.findByText("Signed in for you")).toBeVisible();
    if (variant === "compact") {
      expect(screen.getByRole("status")).toHaveTextContent("Signed in for you");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
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

function renderAccount(variant: "card" | "compact" = "card") {
  render(
    <QueryClientProvider client={queryClient}>
      <ClaudeCodeAccount agentId="agent-1" variant={variant} />
    </QueryClientProvider>,
  );
}

it("starts a fresh sign-in after a failed one and exposes the authorization link", async () => {
  const user = userEvent.setup();
  let account: archestraApiTypes.GetClaudeCodeAccountResponses["200"] = {
    state: "failed",
  };
  server.use(
    http.get(accountUrl, () => HttpResponse.json(account)),
    http.post(accountUrl, () => {
      account = {
        state: "awaiting_code",
        flowId: "00000000-0000-4000-8000-000000000001",
        authorizationUrl: "https://claude.ai/oauth/authorize?state=test",
      };
      return HttpResponse.json(account);
    }),
  );
  renderAccount();
  await user.click(await screen.findByRole("button", { name: "Sign in" }));
  expect(
    await screen.findByRole("link", { name: "Open Claude" }),
  ).toHaveAttribute("href", account.authorizationUrl);
  expect(screen.getByLabelText("Authorization code")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("updates every Agent after connecting and disconnecting the shared account", async () => {
  const user = userEvent.setup();
  let account: archestraApiTypes.GetClaudeCodeAccountResponses["200"] = {
    state: "disconnected",
  };
  const url = `${origin}/api/agents/:id/runtime/claude-code/account`;
  server.use(
    http.get(url, () => HttpResponse.json(account)),
    http.post(url, () => {
      account = {
        state: "awaiting_code",
        flowId: "00000000-0000-4000-8000-000000000001",
        authorizationUrl: "https://claude.ai/oauth/authorize",
      };
      return HttpResponse.json(account);
    }),
    http.delete(url, () => {
      account = { state: "disconnected" };
      return HttpResponse.json(account);
    }),
    http.post(`${url}/complete`, () => {
      account = { state: "connected" };
      return HttpResponse.json(account);
    }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ClaudeCodeAccount agentId="agent-1" />
      <ClaudeCodeAccount agentId="agent-2" />
    </QueryClientProvider>,
  );
  await user.click(
    (await screen.findAllByRole("button", { name: "Sign in" }))[0],
  );
  await user.type(
    await screen.findByLabelText("Authorization code"),
    "example-code",
  );
  await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
  expect(await screen.findAllByText("Signed in for you")).toHaveLength(2);
  expect(
    screen.queryByText("Sign in to use this agent."),
  ).not.toBeInTheDocument();
  await user.click(screen.getAllByRole("button", { name: "Manage" })[1]);
  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(await screen.findAllByText("Sign in to use this agent.")).toHaveLength(
    2,
  );
  expect(screen.queryByText("Signed in for you")).not.toBeInTheDocument();
});

it("signs in where it sits when inline, without opening a second dialog", async () => {
  const user = userEvent.setup();
  let account: archestraApiTypes.GetClaudeCodeAccountResponses["200"] = {
    state: "disconnected",
  };
  server.use(
    http.get(accountUrl, () => HttpResponse.json(account)),
    http.post(accountUrl, () => {
      account = {
        state: "awaiting_code",
        flowId: "00000000-0000-4000-8000-000000000001",
        authorizationUrl: "https://claude.ai/oauth/authorize",
      };
      return HttpResponse.json(account);
    }),
    http.post(`${accountUrl}/complete`, () => {
      account = { state: "connected" };
      return HttpResponse.json(account);
    }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ClaudeCodeAccount agentId="agent-1" variant="inline" />
    </QueryClientProvider>,
  );

  await user.click(
    await screen.findByRole("button", { name: "Sign in with Claude" }),
  );
  expect(
    await screen.findByRole("link", { name: "Open Claude" }),
  ).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("Authorization code"), "example-code");
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByText("Signed in for you")).toBeVisible();
});

it("leaves the disconnected notice to the page banner while retaining connected account controls", async () => {
  server.use(
    http.get(accountUrl, () => HttpResponse.json({ state: "disconnected" })),
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ClaudeCodeAccount
        agentId="agent-1"
        variant="compact"
        showDisconnectedNotice={false}
      />
    </QueryClientProvider>,
  );
  await queryClient.refetchQueries();
  expect(
    screen.queryByRole("button", { name: "Sign in" }),
  ).not.toBeInTheDocument();
  server.use(
    http.get(accountUrl, () => HttpResponse.json({ state: "connected" })),
  );
  await queryClient.invalidateQueries();
  expect(await screen.findByRole("button", { name: "Manage" })).toBeVisible();
  view.unmount();
});

it.each([
  [undefined, "Opus"],
  ["default", "Claude account default"],
  ["claude-sonnet-example", "Sonnet (example)"],
] as const)("shows the effective model choice %s without overwriting saved configuration", async (model, label) => {
  const onModelChange = vi.fn();
  server.use(
    http.get(accountUrl, () => HttpResponse.json({ state: "connected" })),
    http.get(`${origin}/api/agents/agent-1/runtime/claude-code/models`, () =>
      HttpResponse.json({
        models: [
          {
            value: "opus",
            displayName: "Opus",
            description: "Default for new runs",
          },
          {
            value: "default",
            displayName: "Claude account default",
            description: "Selected by Claude",
          },
          {
            value: "claude-sonnet-example",
            displayName: "Sonnet (example)",
            description: "Explicit selection",
          },
        ],
      }),
    ),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ClaudeCodeAccount
        agentId="agent-1"
        model={model}
        onModelChange={onModelChange}
      />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole("button", {
      name: (name) => name.endsWith(label),
    }),
  ).toBeVisible();
  expect(onModelChange).not.toHaveBeenCalled();
  if (model === "default")
    expect(
      screen.getByText(/Claude chooses the model from your account settings/),
    ).toBeVisible();
});
