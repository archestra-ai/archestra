import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { postConnected } from "@/lib/connect-signal";
import { ClientConnectionApproval } from "./client-connection-approval";

vi.mock("sonner");
vi.mock("@/lib/connect-signal");
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
  vi.mocked(postConnected).mockClear();
  archestraApiClient.setConfig({ baseUrl: origin });
  server.use(
    http.get(`${origin}/api/bootstrap`, () => HttpResponse.json({})),
    http.get(`${origin}/api/organization/appearance-settings`, () =>
      HttpResponse.json({}),
    ),
    http.get(`${origin}/api/client-connections/request`, () =>
      HttpResponse.json({
        clientId: "cursor",
        platform: "linux",
        deviceName: "work-laptop",
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
    skillsSelected: true,
  },
  setupId: string | null = "setup",
  setupProblem: string | null = null,
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
        setupId={setupId ?? undefined}
        setupProblem={setupProblem}
        clientId={clientId}
        platform="linux"
        gateway={
          resources.gatewaySelected
            ? { id: "gateway-id", name: "My Gateway" }
            : null
        }
        mcpServerName="My Gateway"
        proxySelected={resources.proxySelected}
        skillsSelected={resources.skillsSelected}
      />
    </QueryClientProvider>,
  );
}

test("loading a request announces its state and offers no decision actions", async () => {
  server.use(
    http.get(
      `${origin}/api/client-connections/request`,
      () => new Promise<Response>(() => {}),
    ),
  );
  show();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading connection request",
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(requests).toEqual([]);
});

test("a missing prepared setup blocks approval while denial remains available", async () => {
  show("cursor", undefined, null);
  await screen.findByText("ABCD-1234");
  fireEvent.click(screen.getByRole("checkbox"));
  expect(
    screen.getByRole("button", { name: "Approve connection" }),
  ).toBeDisabled();
  expect(await approveTooltip()).toHaveTextContent(
    "Preparing the setup for your terminal. Approve turns on as soon as it is ready.",
  );
  // A disabled button alone reads as stuck: the spinner shows it is coming.
  expect(screen.getByTestId("approve-connection-progress")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  expect(requests).toEqual([]);
});

test("an unconfirmed code explains how to enable approval", async () => {
  show();
  await screen.findByText("ABCD-1234");
  expect(
    screen.getByRole("button", { name: "Approve connection" }),
  ).toBeDisabled();
  expect(await approveTooltip()).toHaveTextContent(
    "Check that the code above matches the code in your terminal, then select the checkbox to confirm it.",
  );
  // The setup is ready; only the person is left to act.
  expect(
    screen.queryByTestId("approve-connection-progress"),
  ).not.toBeInTheDocument();
});

test("a setup that cannot be prepared keeps approval off and says how to fix it", async () => {
  const problem =
    "600 plugins are selected, but one setup can install at most 555. Choose 555 or fewer in Setup options, or turn plugins off.";
  show("cursor", undefined, null, problem);
  await screen.findByText("ABCD-1234");
  fireEvent.click(screen.getByRole("checkbox"));
  expect(
    screen.getByRole("button", { name: "Approve connection" }),
  ).toBeDisabled();
  expect(await approveTooltip()).toHaveTextContent(problem);
  // Nothing is on its way, so nothing spins.
  expect(
    screen.queryByTestId("approve-connection-progress"),
  ).not.toBeInTheDocument();
  expect(requests).toEqual([]);
});

test("a request for another app names what the terminal asked for", async () => {
  show("claude-code");
  await screen.findByText("ABCD-1234");
  fireEvent.click(screen.getByRole("checkbox"));
  expect(await approveTooltip()).toHaveTextContent(
    "Your terminal asked to connect Cursor on macOS / Linux. Select the same app and operating system on this page, then approve.",
  );
});

test("a pending decision disables both actions and waits for the result", async () => {
  let completeDecision: (response: Response) => void = () => {};
  server.use(
    http.post(
      `${origin}/api/client-connections/request/decision`,
      () =>
        new Promise<Response>((resolve) => {
          completeDecision = resolve;
        }),
    ),
  );
  show();
  await screen.findByText("ABCD-1234");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Approve connection" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled(),
  );
  expect(
    screen.getByRole("button", { name: "Approve connection" }),
  ).toBeDisabled();
  expect(screen.getByTestId("approve-connection-progress")).toBeInTheDocument();
  completeDecision(
    HttpResponse.json({
      status: "approved",
      clientId: "cursor",
      platform: "linux",
    }),
  );
  await screen.findByRole("heading", { name: "Switch back to your terminal" });
});

test("a failed decision keeps confirmation visible and permits retry", async () => {
  server.use(
    http.post(
      `${origin}/api/client-connections/request/decision`,
      async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json(
          { error: { message: "Request failed" } },
          { status: 500 },
        );
      },
    ),
  );
  show();
  await screen.findByText("ABCD-1234");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Approve connection" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Approve connection" }),
    ).toBeEnabled(),
  );
  expect(screen.getByText("ABCD-1234")).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Switch back to your terminal" }),
  ).not.toBeInTheDocument();
});

test("approval requires matching the terminal code, then submits the reviewed setup", async () => {
  show();
  await screen.findByText("ABCD-1234");
  expect(screen.getByText("work-laptop")).toBeVisible();
  const approve = screen.getByRole("button", { name: "Approve connection" });
  expect(approve).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(approve).toBeEnabled();
  fireEvent.click(approve);
  await screen.findByRole("heading", { name: "Switch back to your terminal" });
  expect(
    screen.getByText(
      "In Cursor, open Customize → MCPs and authenticate the gateway.",
    ),
  ).toBeVisible();
  expect(screen.getByText("Reload Cursor to see shared skills.")).toBeVisible();
  expect(
    screen.getByText(/Quit and reopen Cursor to load its model settings/),
  ).toBeVisible();
  expect(requests).toEqual([{ decision: "approve", setupId: "setup" }]);
  expect(
    screen.queryByRole("button", { name: "Approve connection" }),
  ).not.toBeInTheDocument();
  // The Connect page, open in another tab, hears it once.
  expect(postConnected).toHaveBeenCalledTimes(1);
});

test("approval only shows steps for selected Cursor resources", async () => {
  show("cursor", {
    gatewaySelected: true,
    proxySelected: false,
    skillsSelected: false,
  });
  await screen.findByText("ABCD-1234");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Approve connection" }));
  await screen.findByRole("heading", { name: "Switch back to your terminal" });
  expect(
    screen.getByText(
      "In Cursor, open Customize → MCPs and authenticate the gateway.",
    ),
  ).toBeVisible();
  expect(screen.queryByText(/model settings/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Reload Cursor/)).not.toBeInTheDocument();
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
  // Desktop asks nothing in the terminal: its setup restarts the app itself.
  expect(
    screen.getByRole("heading", { name: "Finish in the setup terminal" }),
  ).toBeVisible();
  expect(screen.queryByText(/now\? \[Y\/n\]/)).not.toBeInTheDocument();
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
  expect(postConnected).not.toHaveBeenCalled();
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

async function approveTooltip() {
  const approve = screen.getByRole("button", { name: "Approve connection" });
  // A disabled button gets no pointer events; its wrapper carries the tooltip.
  await userEvent.setup().hover(approve.parentElement as HTMLElement);
  return screen.findByRole("tooltip");
}
