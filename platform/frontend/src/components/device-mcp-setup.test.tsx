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
import { useOrganization } from "@/lib/organization.query";
import { DeviceMcpSetup } from "./device-mcp-setup";

vi.mock("@/lib/organization.query");
vi.mock("sonner");

const API_ORIGIN = "http://localhost:9000";
const CATALOG_ID = "d769a42b-61e5-4f44-b113-1a5b5e65ac43";
const server = setupServer();
const clients: QueryClient[] = [];
let connections: {
  id: string;
  name: string;
  status: "online" | "offline" | "revoked";
  configVersion: string;
  lastSeenAt: string | null;
}[];
let listRequests: number;
let pairBodies: unknown[];
let revoked: string[];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  vi.clearAllMocks();
  connections = [];
  listRequests = 0;
  pairBodies = [];
  revoked = [];
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(useOrganization).mockReturnValue({
    data: { deviceMcpEnabled: true },
    isPending: false,
  } as ReturnType<typeof useOrganization>);
  server.use(
    http.get(`${API_ORIGIN}/api/device-mcp`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("catalogId")).toBe(
        CATALOG_ID,
      );
      listRequests += 1;
      return HttpResponse.json(connections);
    }),
    http.post(`${API_ORIGIN}/api/device-mcp/pair`, async ({ request }) => {
      pairBodies.push(await request.json());
      return HttpResponse.json({
        code: "one-time-code",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        config: { version: "1.0.0", protocolVersion: 1 },
        configDigest: "approved-digest",
      });
    }),
    http.delete(`${API_ORIGIN}/api/device-mcp/:id`, ({ params }) => {
      revoked.push(String(params.id));
      connections = connections.map((connection) => ({
        ...connection,
        status: "revoked",
      }));
      return HttpResponse.json({ success: true });
    }),
  );
});
afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
  server.resetHandlers();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderSetup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <DeviceMcpSetup catalogId={CATALOG_ID} />
    </QueryClientProvider>,
  );
}

describe("DeviceMcpSetup", () => {
  it("does not request or offer device setup when organization opt-in is disabled", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: { deviceMcpEnabled: false },
      isPending: false,
    } as ReturnType<typeof useOrganization>);
    renderSetup();
    expect(
      screen.getByText("Device connections are disabled"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Prepare device setup" }),
    ).not.toBeInTheDocument();
    expect(listRequests).toBe(0);
  });

  it("prepares personal setup and shows the code and reviewed configuration for consent on the device", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.type(await screen.findByLabelText("Device name"), "My laptop");
    expect(screen.queryByText(/--code/)).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Prepare device setup" }),
    );
    expect(
      await screen.findByText(/--code 'PAIRING_CODE'/),
    ).toBeInTheDocument();
    expect(pairBodies).toEqual([
      { catalogId: CATALOG_ID, name: "My laptop", replaceExisting: false },
    ]);
    expect(screen.queryByText(/one-time-code/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Copy with real token" }),
    );
    expect(await navigator.clipboard.readText()).toContain(
      "--code 'one-time-code'",
    );
    await user.click(screen.getByText("Review launch configuration"));
    expect(
      screen.getByText(/Configuration fingerprint: approved-digest/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/24-hour credential in memory/),
    ).toBeInTheDocument();
  });

  it("requires explicit replacement of an offline device and can revoke its connection", async () => {
    connections = [
      {
        id: "device-1",
        name: "Earlier laptop",
        status: "offline",
        configVersion: "1.0.0",
        lastSeenAt: null,
      },
    ];
    const user = userEvent.setup();
    renderSetup();
    expect(
      await screen.findByText("Your device is offline"),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Device name"), "Replacement laptop");
    expect(
      screen.getByRole("button", { name: "Prepare device setup" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: "Replace my selected device and disconnect its existing connector",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Prepare device setup" }),
    );
    await screen.findByText(/--code 'PAIRING_CODE'/);
    expect(pairBodies).toEqual([
      {
        catalogId: CATALOG_ID,
        name: "Replacement laptop",
        replaceExisting: true,
      },
    ]);
    await user.click(screen.getByRole("button", { name: "Revoke connection" }));
    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    expect(revoked).toEqual(["device-1"]);
    await waitFor(() =>
      expect(screen.queryByText(/--code/)).not.toBeInTheDocument(),
    );
  });

  it("shows a list failure as an error rather than offering replacement setup", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/device-mcp`, () =>
        HttpResponse.json(
          {
            error: {
              message: "Unavailable",
              type: "api_internal_server_error",
            },
          },
          { status: 500 },
        ),
      ),
    );
    renderSetup();
    expect(
      await screen.findByText("Could not load your device connection"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Prepare device setup" }),
    ).not.toBeInTheDocument();
  });
});
