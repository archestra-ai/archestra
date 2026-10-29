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
  vi,
} from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { McpGatewayConnectInstructions } from "./agent-connect-instructions";

const API_ORIGIN = "http://localhost:9000";

// The client picker is a Radix Select, which needs pointer capture and
// scrollIntoView that jsdom lacks.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as unknown as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useOrganization).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useOrganization>);
});

describe("McpGatewayConnectInstructions", () => {
  it("leads with the endpoint and sign-in, which needs no setup", async () => {
    renderInstructions();

    expect(
      screen.getByText("http://localhost:3000/v1/mcp/my-gateway"),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /OAuth sign-in/ })).toBeChecked();
    expect(screen.getByRole("heading", { name: /Sign in/ })).toBeVisible();
    expect(screen.getByText(/Nothing to set up/)).toBeVisible();
    // The client makes its own requests, so there is no request step.
    expect(
      screen.queryByRole("heading", { name: /Send a request/ }),
    ).not.toBeInTheDocument();
  });

  it("offers only the OAuth clients allowed on this gateway", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/mcp-oauth-clients`, () =>
        HttpResponse.json([
          oauthClient({
            id: "oc-other",
            clientId: "client-other",
            name: "Other gateway's app",
            allowedGatewayIds: ["gw-other"],
          }),
          oauthClient({
            id: "oc-batch",
            clientId: "client-batch",
            name: "Batch jobs",
            allowedGatewayIds: ["gw-1"],
          }),
        ]),
      ),
    );
    const user = userEvent.setup();
    renderInstructions();

    await user.click(screen.getByRole("radio", { name: /OAuth client/ }));

    expect(
      await screen.findByRole("combobox", { name: "OAuth client" }),
    ).toHaveTextContent("Batch jobs");
    // Step 3 gets the token; step 4 lists the gateway's tools with it.
    expect(screen.getByText(/grant_type=client_credentials/)).toHaveTextContent(
      "client_id=client-batch",
    );
    const request = screen.getByText(/tools\/list/).closest("pre");
    expect(request).toHaveTextContent(
      "Authorization: Bearer $ARCHESTRA_MCP_ACCESS_TOKEN",
    );
    expect(request).toHaveTextContent(
      "http://localhost:3000/v1/mcp/my-gateway",
    );
    await user.click(screen.getByRole("combobox", { name: "OAuth client" }));
    expect(
      screen.queryByRole("option", { name: "Other gateway's app" }),
    ).not.toBeInTheDocument();
  });

  it("asks to create a client when none is allowed on this gateway", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/mcp-oauth-clients`, () =>
        HttpResponse.json([]),
      ),
    );
    const user = userEvent.setup();
    renderInstructions();

    await user.click(screen.getByRole("radio", { name: /OAuth client/ }));

    expect(
      await screen.findByRole("button", { name: /Create new OAuth client/ }),
    ).toBeInTheDocument();
  });
});

function renderInstructions() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <McpGatewayConnectInstructions
        gateway={{
          id: "gw-1",
          name: "My Gateway",
          agentType: "mcp_gateway",
          slug: "my-gateway",
          identityProviderId: null,
        }}
      />
    </QueryClientProvider>,
  );
}

function oauthClient(fields: {
  id: string;
  clientId: string;
  name: string;
  allowedGatewayIds: string[];
}) {
  return {
    ...fields,
    organizationId: "org-1",
    grantType: "client_credentials",
    redirectUris: [],
    disabled: false,
    authorId: null,
    authorName: null,
    createdBy: null,
    labels: [],
  };
}
