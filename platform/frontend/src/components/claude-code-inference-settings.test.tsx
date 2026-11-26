import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useState } from "react";
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
import type { AgentAccountLock } from "./agent-account-ways-field";
import { ClaudeCodeInferenceSettings } from "./claude-code-inference-settings";
import { ClaudeSubscriptionModelPicker } from "./claude-connection-pickers";

vi.mock("sonner");
vi.mock("next/navigation");

const origin = "http://localhost:9000";
const accountUrl = `${origin}/api/agents/agent-1/runtime/claude-code/account`;
const modelsUrl = `${origin}/api/agents/agent-1/runtime/claude-code/models`;
const server = setupServer();
let connected = false;
let signInStarted = false;
const pendingSignIn = {
  state: "awaiting_code",
  flowId: "00000000-0000-4000-8000-000000000001",
  authorizationUrl: "https://claude.ai/oauth/authorize?state=test",
};
let modelRequests = 0;
let client: QueryClient;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  // JSDOM has no scrolling implementation; the real command menu calls it.
  Element.prototype.scrollIntoView = vi.fn();
  archestraApiClient.setConfig({ baseUrl: origin });
  connected = false;
  signInStarted = false;
  modelRequests = 0;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  server.use(
    http.get(`${origin}/api/auth/get-session`, () => HttpResponse.json(null)),
    http.get(accountUrl, () =>
      HttpResponse.json(
        connected
          ? { state: "connected" }
          : signInStarted
            ? pendingSignIn
            : { state: "disconnected" },
      ),
    ),
    http.get(modelsUrl, () => {
      modelRequests++;
      return HttpResponse.json({
        models: [
          {
            value: "opus",
            displayName: "Opus",
            description: "Runtime default",
          },
          {
            value: "runtime-choice",
            displayName: "Runtime model",
            description: "Discovered from this CLI",
          },
        ],
      });
    }),
    http.post(accountUrl, () => {
      signInStarted = true;
      return HttpResponse.json(pendingSignIn);
    }),
    http.post(`${accountUrl}/complete`, async ({ request }) => {
      expect(await request.json()).toEqual({
        flowId: "00000000-0000-4000-8000-000000000001",
        code: "native-authorization-code",
      });
      connected = true;
      signInStarted = false;
      return HttpResponse.json({ state: "connected" });
    }),
    http.delete(accountUrl, () => {
      connected = false;
      signInStarted = false;
      return HttpResponse.json({ state: "disconnected" });
    }),
  );
});
afterEach(() => {
  server.resetHandlers();
  client.clear();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("Claude Code authentication", () => {
  it("shows each option's setup under it, and asks for one option when none is selected", async () => {
    render(
      <QueryClientProvider client={client}>
        <Settings />
      </QueryClientProvider>,
    );
    const subscription = () =>
      screen.getByRole("checkbox", {
        name: /Each person's Claude subscription/,
      });
    const companyKey = () =>
      screen.getByRole("checkbox", { name: /Provider API key/ });
    // Both options start selected: each person chooses.
    await waitFor(() => expect(subscription()).toBeChecked());
    expect(companyKey()).toBeChecked();
    expect(
      screen.getByText(
        "If both an API key and a subscription are selected, each person can choose what to use.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Provider key" })).toBeVisible();
    // Each person signs in and picks their model on the agent's page; the
    // settings only say which accounts are allowed.
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    // Without the company key, its connection goes too.
    fireEvent.click(companyKey());
    expect(companyKey()).not.toBeChecked();
    expect(
      screen.queryByRole("button", { name: "Provider key" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Locked to each user's personal subscription"),
    ).toBeVisible();
    // The last option can be unticked too; the form then asks for one.
    fireEvent.click(subscription());
    expect(subscription()).not.toBeChecked();
    expect(
      screen.getByText(
        "Selecting more than one option allows users to choose.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Select at least one option.",
    );
    fireEvent.click(companyKey());
    expect(companyKey()).toBeChecked();
    expect(subscription()).not.toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Locked to an API key")).toBeVisible();
    expect(screen.getByRole("button", { name: "Provider key" })).toBeVisible();
    expect(modelRequests).toBe(0);
  });

  it("keeps the model picker hidden when account discovery fails", async () => {
    server.use(
      http.get(accountUrl, () =>
        HttpResponse.json(
          { error: { message: "Runtime unavailable" } },
          { status: 503 },
        ),
      ),
    );
    render(
      <QueryClientProvider client={client}>
        <ClaudeSubscriptionModelPicker
          agentId="agent-1"
          onModelChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        client.getQueryState(["claude-code-account", "agent-1"])?.status,
      ).toBe("error"),
    );
    // No account, so no list to ask for and no field to show.
    expect(modelRequests).toBe(0);
    expect(
      screen.queryByRole("button", { name: /^Model/ }),
    ).not.toBeInTheDocument();
  });

  it.each([
    [undefined, "Opus"],
    ["default", "Claude account default"],
    ["claude-sonnet-example", "Sonnet (example)"],
  ] as const)("shows the effective subscription model %s without overwriting the saved one", async (model, label) => {
    connected = true;
    const onModelChange = vi.fn();
    server.use(
      http.get(modelsUrl, () =>
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
      <QueryClientProvider client={client}>
        <ClaudeSubscriptionModelPicker
          agentId="agent-1"
          model={model}
          onModelChange={onModelChange}
        />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("button", { name: `Model ${label}` }),
    ).toBeVisible();
    expect(onModelChange).not.toHaveBeenCalled();
  });
});

function Settings() {
  const [lock, setLock] = useState<AgentAccountLock | null>(null);
  const [none, setNone] = useState(false);
  return (
    <ClaudeCodeInferenceSettings
      lock={lock}
      noWaySelected={none}
      onLockChange={(next) => {
        setNone(false);
        setLock(next);
      }}
      onNoWaySelected={() => setNone(true)}
      connectionPickers={<button type="button">Provider key</button>}
    />
  );
}
