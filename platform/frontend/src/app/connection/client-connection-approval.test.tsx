import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { ClientConnectionApproval } from "./client-connection-approval";

vi.mock("sonner");
const origin = "http://localhost:9000";
const server = setupServer();
const requests: unknown[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
beforeEach(() => {
  requests.length = 0;
  archestraApiClient.setConfig({ baseUrl: origin });
  server.use(
    http.get(`${origin}/api/client-connections/request`, () =>
      HttpResponse.json({
        clientId: "cursor",
        platform: "linux",
        userCode: "ABCD-1234",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    ),
    http.post(
      `${origin}/api/client-connections/request/decision`,
      async ({ request }) => {
        const body = (await request.json()) as { decision: string };
        requests.push(body);
        return HttpResponse.json({
          status: body.decision === "approve" ? "approved" : "denied",
          clientId: "cursor",
          platform: "linux",
        });
      },
    ),
  );
});
function show(
  clientId = "cursor",
  resources = {
    gatewaySelected: true,
    proxySelected: true,
    proxyUsesVirtualKey: true,
    skillsSelected: true,
  },
) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <ClientConnectionApproval
        requestId="request"
        setupId="setup"
        clientId={clientId}
        platform="linux"
        gatewayName="My Gateway"
        {...resources}
      />
    </QueryClientProvider>,
  );
}

test("approval requires matching the terminal code, then submits the reviewed setup", async () => {
  show();
  await screen.findByText("ABCD-1234");
  const approve = screen.getByRole("button", { name: "Approve connection" });
  expect(approve).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(approve).toBeEnabled();
  fireEvent.click(approve);
  await screen.findByText(
    "Connection approved. Return to your terminal to finish setup.",
  );
  expect(
    screen.getByText(
      "In Cursor, open Customize → MCPs and authenticate the gateway.",
    ),
  ).toBeVisible();
  expect(screen.getByText("Reload Cursor to see shared skills.")).toBeVisible();
  expect(
    screen.getByText(
      /Paste its proxy URL and virtual key into Cursor Settings/,
    ),
  ).toBeVisible();
  expect(requests).toEqual([{ decision: "approve", setupId: "setup" }]);
  expect(
    screen.queryByRole("button", { name: "Approve connection" }),
  ).not.toBeInTheDocument();
});

test("approval only shows steps for selected Cursor resources", async () => {
  show("cursor", {
    gatewaySelected: true,
    proxySelected: false,
    proxyUsesVirtualKey: false,
    skillsSelected: false,
  });
  await screen.findByText("ABCD-1234");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Approve connection" }));
  await screen.findByText(
    "Connection approved. Return to your terminal to finish setup.",
  );
  expect(
    screen.getByText(
      "In Cursor, open Customize → MCPs and authenticate the gateway.",
    ),
  ).toBeVisible();
  expect(screen.queryByText(/proxy URL and key/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Reload Cursor/)).not.toBeInTheDocument();
});

test("Cursor provider-key setup tells the user which key to use", async () => {
  show("cursor", {
    gatewaySelected: false,
    proxySelected: true,
    proxyUsesVirtualKey: false,
    skillsSelected: false,
  });
  await screen.findByText("ABCD-1234");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Approve connection" }));
  expect(
    await screen.findByText(/Paste its proxy URL and your own OpenAI API key/),
  ).toBeVisible();
  expect(screen.queryByText(/virtual key/)).not.toBeInTheDocument();
});

test("Claude Desktop approval points to its connector step", async () => {
  server.use(
    http.get(`${origin}/api/client-connections/request`, () =>
      HttpResponse.json({
        clientId: "claude-desktop",
        platform: "linux",
        userCode: "ABCD-1234",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    ),
  );
  show("claude-desktop");
  await screen.findByText("ABCD-1234");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Approve connection" }));
  expect(await screen.findByText(/After Desktop restarts, open/)).toBeVisible();
  expect(screen.getByText(/Ask Claude to list the tools/)).toBeVisible();
});

test("a mismatched client cannot be approved but can be denied", async () => {
  show("claude-code");
  await screen.findByText("ABCD-1234");
  fireEvent.click(screen.getByRole("checkbox"));
  expect(
    screen.getByRole("button", { name: "Approve connection" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  await screen.findByText(
    "Connection denied. The installer cannot apply this setup.",
  );
  expect(requests).toEqual([{ decision: "deny" }]);
});

test("expired requests show recovery guidance and cannot release a setup", async () => {
  server.use(
    http.get(`${origin}/api/client-connections/request`, () =>
      HttpResponse.json({ error: { message: "Expired" } }, { status: 410 }),
    ),
  );
  show();
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Start the installer again",
    ),
  );
  expect(
    screen.queryByRole("button", { name: "Approve connection" }),
  ).not.toBeInTheDocument();
  expect(requests).toEqual([]);
});
