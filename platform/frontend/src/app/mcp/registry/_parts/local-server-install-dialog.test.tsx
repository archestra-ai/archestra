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
  expect,
  it,
  vi,
} from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { makeCatalogItem } from "@/mocks/data/catalog";
import { LocalServerInstallDialog } from "./local-server-install-dialog";

vi.mock("@/lib/clients/auth/auth-client");

const origin = "http://localhost:9000";
const catalogId = "b408b614-d104-451c-a6f9-3b8e4af044b3";
const catalogItem = makeCatalogItem({
  id: catalogId,
  name: "Cluster reader",
  serverType: "local",
  scope: "org",
  localConfig: {
    serviceAccount: "cluster-reader",
    command: "node",
    environment: [],
  },
  userConfig: null,
});
let updateScope = catalogId;
const server = setupServer(
  http.get(`${origin}/api/config`, () =>
    HttpResponse.json({ features: {}, enterpriseFeatures: {} }),
  ),
  http.get(`${origin}/api/user/permissions`, () =>
    HttpResponse.json({
      mcpRegistry: ["read", "update"],
      mcpServerInstallation: ["create", "update"],
    }),
  ),
  http.get(`${origin}/api/resource-permissions`, () =>
    HttpResponse.json([
      { resource: "mcpRegistry", action: "update", scope: updateScope },
    ]),
  ),
  http.get(`${origin}/api/organization`, () =>
    HttpResponse.json({ id: "test-org" }),
  ),
  http.get(`${origin}/api/environments`, () =>
    HttpResponse.json({ environments: [], resourceDefaults: {} }),
  ),
  http.get(`${origin}/api/teams`, () => HttpResponse.json({ data: [] })),
  http.get(`${origin}/api/mcp_server`, () => HttpResponse.json([])),
  http.get(`${origin}/api/internal_mcp_catalog`, () =>
    HttpResponse.json([catalogItem]),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  updateScope = catalogId;
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: {
      user: { id: "test-user" },
      session: { activeOrganizationId: "test-org" },
    },
  });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function show() {
  const onConfirm = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <LocalServerInstallDialog
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        catalogItem={catalogItem}
        isInstalling={false}
        isReinstall
        existingScope="personal"
      />
    </QueryClientProvider>,
  );
  return { onConfirm, user: userEvent.setup() };
}

it("lets a scoped editor reinstall without changing the catalog account", async () => {
  const { onConfirm, user } = show();
  expect(screen.getByLabelText("Service Account")).toBeDisabled();
  await user.click(await screen.findByRole("button", { name: "Reinstall" }));
  await waitFor(() =>
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId, serviceAccount: undefined }),
    ),
  );
});

it.each([
  "custom-reader",
  "",
])("lets a registry administrator submit account %j", async (account) => {
  updateScope = "*";
  const { onConfirm, user } = show();
  const input = screen.getByLabelText("Service Account");
  await waitFor(() => expect(input).toBeEnabled());
  await user.clear(input);
  if (account) await user.type(input, account);
  await user.click(screen.getByRole("button", { name: "Reinstall" }));
  await waitFor(() =>
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId, serviceAccount: account }),
    ),
  );
});
