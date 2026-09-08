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
function show(clientId = "cursor") {
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
  expect(requests).toEqual([{ decision: "approve", setupId: "setup" }]);
  expect(
    screen.queryByRole("button", { name: "Approve connection" }),
  ).not.toBeInTheDocument();
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
