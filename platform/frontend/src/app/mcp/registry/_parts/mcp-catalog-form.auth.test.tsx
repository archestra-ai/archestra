import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { Button } from "@/components/ui/button";
import { McpCatalogForm } from "./mcp-catalog-form";

const server = setupServer(
  http.get("http://localhost:9000/api/secrets/type", () =>
    HttpResponse.json({ type: "database" }),
  ),
  http.get("http://localhost:9000/api/config", () =>
    HttpResponse.json({
      features: { orchestratorK8sRuntime: true },
      enterpriseFeatures: { core: true },
    }),
  ),
  http.get("http://localhost:9000/api/user/permissions", () =>
    HttpResponse.json({ team: ["read"], identityProvider: ["read"] }),
  ),
  http.get("http://localhost:9000/api/organization", () =>
    HttpResponse.json({ id: "test-org" }),
  ),
  http.get("http://localhost:9000/api/organization/appearance-settings", () =>
    HttpResponse.json({ appName: "Test platform" }),
  ),
  http.get("http://localhost:9000/api/environments", () =>
    HttpResponse.json({ environments: [], resourceDefaults: {} }),
  ),
  http.get("http://localhost:9000/api/identity-providers", () =>
    HttpResponse.json([
      {
        id: "synthetic-idp",
        providerId: "synthetic",
        issuer: "https://idp.example.com",
        oidcConfig: { clientId: "synthetic-client" },
      },
    ]),
  ),
  http.get("http://localhost:9000/api/teams", () =>
    HttpResponse.json({ data: [] }),
  ),
  http.get("http://localhost:9000/api/k8s/image-pull-secrets", () =>
    HttpResponse.json([]),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() =>
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" }),
);
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it.each([
  ["OAuth 2.1", "None", "none"],
  ["OAuth 2.1", "Token header", "auth_header"],
  ["OAuth 2.1", "OAuth 2.0 client credentials", "oauth_client_credentials"],
  ["OAuth 2.1", "IdP token exchange", "enterprise_managed"],
  ["OAuth 2.1", "IdP signed JWT", "idp_jwt"],
  ["OAuth 2.0 client credentials", "None", "none"],
  ["OAuth 2.0 client credentials", "OAuth 2.1", "oauth"],
])("submits after switching an invalid %s draft to %s", async (from, to, expectedMethod) => {
  const { user, onSubmit } = renderForm();
  await user.type(screen.getByLabelText(/^Name/), "Auth transition server");
  await user.type(
    screen.getByLabelText(/^Server URL/),
    "https://mcp.example.com",
  );
  await user.click(
    screen.getByRole("button", { name: new RegExp(`^${from}`) }),
  );
  if (from === "OAuth 2.1") {
    await user.clear(screen.getByLabelText(/MCP OAuth callback URIs/));
  }
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText(
      from === "OAuth 2.1"
        ? "At least one redirect URI is required"
        : "Provide a token endpoint, authorization server URL, or well-known URL for client credentials",
    ),
  ).toBeVisible();
  expect(onSubmit).not.toHaveBeenCalled();
  const target = screen.getByRole("button", { name: new RegExp(`^${to}`) });
  await waitFor(() =>
    expect(target).not.toHaveAttribute("aria-disabled", "true"),
  );
  await user.click(target);
  if (to === "OAuth 2.0 client credentials") {
    await user.type(
      screen.getByLabelText(/^Token Endpoint/),
      "https://auth.example.com/token",
    );
  }
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  expect(onSubmit.mock.calls[0][0].authMethod).toBe(expectedMethod);
});

it("retains drafts and shared-field errors while revalidating the selected method", async () => {
  const { user, onSubmit } = renderForm();
  await user.type(
    screen.getByLabelText(/^Server URL/),
    "https://mcp.example.com",
  );
  await user.click(screen.getByRole("button", { name: /^OAuth 2.1/ }));
  await user.clear(screen.getByLabelText(/MCP OAuth callback URIs/));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText("At least one redirect URI is required"),
  ).toBeVisible();
  expect(screen.getByText("Name is required")).toBeVisible();
  await user.click(screen.getByRole("button", { name: /^None/ }));
  expect(screen.getByText("Name is required")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(onSubmit).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: /^OAuth 2.1/ }));
  expect(screen.getByLabelText(/MCP OAuth callback URIs/)).toHaveValue("");
  expect(
    await screen.findByText("At least one redirect URI is required"),
  ).toBeVisible();
  await user.type(screen.getByLabelText(/^Name/), "Restored OAuth draft");
  await user.type(
    screen.getByLabelText(/MCP OAuth callback URIs/),
    "https://app.example.com/oauth-callback",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  expect(onSubmit.mock.calls[0][0].oauthConfig.redirect_uris).toBe(
    "https://app.example.com/oauth-callback",
  );
});

it("preserves a server URL rejection when switching authentication methods", async () => {
  const { user, onSubmit, submitRef } = renderForm();
  onSubmit.mockImplementationOnce((_values, form) => {
    form.setError("serverUrl", {
      type: "server",
      message: "This server URL is not allowed",
    });
  });
  await user.type(screen.getByLabelText(/^Name/), "Restricted server");
  await user.type(
    screen.getByLabelText(/^Server URL/),
    "https://mcp.example.com",
  );
  await act(async () => {
    await submitRef.current?.();
  });
  expect(screen.getByText("This server URL is not allowed")).toBeVisible();
  await user.click(screen.getByRole("button", { name: /^OAuth 2.1/ }));
  // Await the auth-field validation caused by the method change.
  await user.clear(screen.getByLabelText(/MCP OAuth callback URIs/));
  expect(
    await screen.findByText("At least one redirect URI is required"),
  ).toBeVisible();
  expect(screen.getByText("This server URL is not allowed")).toBeVisible();
});

function renderForm() {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  const submitRef = { current: null as (() => Promise<void>) | null };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["auth", "session"], {
    user: { id: "test-user", email: "admin@example.com" },
    session: { activeOrganizationId: "test-org" },
  });
  render(
    <QueryClientProvider client={client}>
      <McpCatalogForm
        mode="create"
        submitRef={submitRef}
        onSubmit={onSubmit}
        footer={() => <Button type="submit">Save</Button>}
      />
    </QueryClientProvider>,
  );
  return { user, onSubmit, submitRef };
}
