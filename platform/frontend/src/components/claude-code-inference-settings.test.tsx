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
import { ClaudeCodeInferenceSettings } from "./claude-code-inference-settings";

vi.mock("sonner");

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
  it("discovers models only after native authentication and removes them on disconnect", async () => {
    // A cached provider catalog must never populate the native account picker.
    client.setQueryData(
      ["llm-models", null],
      [
        {
          id: "unrelated-api-model",
          provider: "anthropic",
          displayName: "API catalog model",
        },
      ],
    );
    render(
      <QueryClientProvider client={client}>
        <Settings />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled(),
    );
    expect(modelRequests).toBe(0);
    expect(screen.queryByText("API catalog model")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Provider key" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with Claude" }),
    );
    await screen.findByLabelText("Authorization code");
    expect(modelRequests).toBe(0);
    fireEvent.change(screen.getByLabelText("Authorization code"), {
      target: { value: "native-authorization-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete sign-in" }));
    await screen.findByText("Signed in for you");
    await waitFor(() => expect(modelRequests).toBe(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Select model|default/i }),
    );
    fireEvent.click(
      await screen.findByRole("option", { name: /Runtime model/ }),
    );
    expect(screen.getByRole("button", { name: /Runtime model/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await screen.findByRole("button", { name: "Sign in with Claude" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("button", { name: /Runtime model/ }),
    ).not.toBeInTheDocument();
    expect(modelRequests).toBe(1);
  });

  it("finishes an asynchronous token flow without resubmitting the authorization code", async () => {
    let polls = 0;
    server.use(
      http.get(accountUrl, () =>
        HttpResponse.json(
          connected
            ? { state: "connected" }
            : { state: "connecting", flowId: pendingSignIn.flowId },
        ),
      ),
      http.post(`${accountUrl}/complete`, async ({ request }) => {
        expect(await request.json()).toEqual({ flowId: pendingSignIn.flowId });
        polls++;
        connected = true;
        return HttpResponse.json({ state: "connected" });
      }),
    );
    render(
      <QueryClientProvider client={client}>
        <Settings />
      </QueryClientProvider>,
    );
    await screen.findByText("Sign in to use this agent.");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Signed in for you", {}, { timeout: 5000 });
    expect(polls).toBe(1);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("connects a read-only Vault reference and shows expired connections as requiring sign-in", async () => {
    let reference: unknown;
    server.use(
      http.get(accountUrl, () =>
        HttpResponse.json({ state: "expired", requiresVaultReference: true }),
      ),
      http.post(accountUrl, async ({ request }) => {
        reference = await request.json();
        return HttpResponse.json({
          state: "connecting",
          flowId: pendingSignIn.flowId,
          requiresVaultReference: true,
        });
      }),
    );
    render(
      <QueryClientProvider client={client}>
        <Settings />
      </QueryClientProvider>,
    );
    await screen.findByText("Connection expired. Sign in again.");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const button = screen.getByRole("button", {
      name: "Connect Vault credential",
    });
    expect(button).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Sign in with Claude" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Vault reference"), {
      target: { value: "secret/data/personal#token" },
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(reference).toEqual({
        vaultReference: "secret/data/personal#token",
      }),
    );
  });

  it("switches to provider billing without treating Vertex configuration as a personal sign-in", async () => {
    render(
      <QueryClientProvider client={client}>
        <Settings vertexEnabled />
      </QueryClientProvider>,
    );
    await screen.findByText("Sign in to use this agent.");
    fireEvent.click(
      screen.getByRole("radio", { name: /API key or cloud provider/ }),
    );
    expect(screen.getByRole("button", { name: "Provider key" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Provider model" }),
    ).toBeVisible();
    expect(
      screen.getByText(/Google Cloud \(Vertex AI\) billing/),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("radio", { name: /Personal Claude subscription/ }),
    );
    await screen.findByText("Sign in to use this agent.");
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
        <Settings />
      </QueryClientProvider>,
    );
    await screen.findByText("Could not check connection");
    expect(modelRequests).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Could not check Claude Code");
    expect(
      screen.queryByRole("button", { name: "Sign in with Claude" }),
    ).not.toBeInTheDocument();
  });
});

function Settings({ vertexEnabled = false }: { vertexEnabled?: boolean }) {
  const [authentication, setAuthentication] = useState<
    "provider" | "subscription"
  >("subscription");
  const [model, setModel] = useState<string>();
  return (
    <ClaudeCodeInferenceSettings
      agentId="agent-1"
      authentication={authentication}
      onAuthenticationChange={setAuthentication}
      model={model}
      onModelChange={setModel}
      provider="anthropic"
      vertexEnabled={vertexEnabled}
      apiKeySelector={<button type="button">Provider key</button>}
      modelSelector={<button type="button">Provider model</button>}
    />
  );
}
