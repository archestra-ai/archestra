import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useSearchParams } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { useOrganization } from "@/lib/organization.query";
import { DeviceMcpSetup } from "./device-mcp-setup";

vi.mock("@/lib/organization.query");
vi.mock("next/navigation");
vi.mock("sonner");
const origin = "http://localhost:9000";
const server = setupServer();
const installed: unknown[] = [];
const clients: QueryClient[] = [];
let computers: unknown[];
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  for (const client of clients.splice(0)) client.clear();
});
beforeEach(() => {
  installed.length = 0;
  computers = [
    {
      id: "computer",
      name: "Work computer",
      platform: "darwin",
      status: "online",
    },
  ];
  vi.mocked(useOrganization).mockReturnValue({
    data: { deviceMcpEnabled: true },
    isPending: false,
  } as ReturnType<typeof useOrganization>);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("setup=device") as ReturnType<typeof useSearchParams>,
  );
  server.use(
    http.get(`${origin}/api/local-devices`, () => HttpResponse.json(computers)),
    http.get(`${origin}/api/device-mcp`, () => HttpResponse.json([])),
    http.get(`${origin}/api/device-mcp/review`, () =>
      HttpResponse.json({
        configDigest: "a".repeat(64),
        config: {
          protocolVersion: 1,
          version: "1",
          platforms: {
            darwin: { command: "/usr/bin/node", args: ["fixture.cjs"] },
            win32: { command: "node.exe", args: ["fixture.cjs"] },
          },
          tools: [{ name: "echo", inputSchema: { type: "object" } }],
        },
      }),
    ),
    http.post(`${origin}/api/device-mcp/install`, async ({ request }) => {
      installed.push(await request.json());
      return HttpResponse.json({ id: "installation" });
    }),
  );
});
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <DeviceMcpSetup catalogId="catalog" />
    </QueryClientProvider>,
  );
}
test("a recovery deep link opens setup and requires approval before installing on the selected computer", async () => {
  const user = userEvent.setup();
  show();
  expect(
    await screen.findByRole("dialog", { name: "Install on your computer" }),
  ).toBeVisible();
  const install = screen.getByRole("button", { name: "Install", exact: true });
  expect(install).toBeDisabled();
  await user.click(
    await screen.findByRole("checkbox", { name: /Allow this MCP/ }),
  );
  await user.click(install);
  await waitFor(() =>
    expect(installed).toEqual([
      {
        catalogId: "catalog",
        localDeviceId: "computer",
        configDigest: "a".repeat(64),
        replaceExisting: false,
      },
    ]),
  );
});
test("missing personal devices offer Connect without authorizing an MCP", async () => {
  computers = [];
  show();
  expect(
    await screen.findByRole("link", { name: "Open Connect" }),
  ).toHaveAttribute("href", "/connection");
  expect(
    screen.getByRole("button", { name: "Install", exact: true }),
  ).toBeDisabled();
  expect(installed).toEqual([]);
});
test("the feature is absent when the organization switch is off", () => {
  vi.mocked(useOrganization).mockReturnValue({
    data: { deviceMcpEnabled: false },
  } as ReturnType<typeof useOrganization>);
  show();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Your device installation"),
  ).not.toBeInTheDocument();
});
