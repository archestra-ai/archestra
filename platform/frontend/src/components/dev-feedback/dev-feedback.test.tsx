import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { makeAgent } from "@/mocks/data/agents";
import { DraftPopover } from "./dev-feedback-popovers";
import { DevFeedbackSetupPanel } from "./dev-feedback-setup";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");

const origin = "http://localhost:9000";
const server = setupServer();
const runtimeAgent = makeAgent({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Feedback reviewer",
  runtime: {
    image: "example/runtime:1",
    command: null,
    backend: "kubernetes",
    inferenceProtocol: "openai_responses",
    steerMode: "pipe",
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: null,
    idleTimeoutMinutes: null,
  },
});

beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function withClient(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
}

it("saves a runtime agent for feedback review and can switch back to post only", async () => {
  const saved: unknown[] = [];
  const options = [runtimeAgent, makeAgent({ name: "Without a runtime" })];
  const page = {
    data: options,
    pagination: { hasNext: false, nextCursor: null, limit: 20 },
  };
  server.use(
    http.get(`${origin}/api/dev-feedback/setup/bots`, () =>
      HttpResponse.json([{ id: "A1", name: "Feedback bot" }]),
    ),
    http.get(`${origin}/api/dev-feedback/setup/bots/A1/channels`, () =>
      HttpResponse.json([{ id: "C1", name: "feedback", isPrivate: false }]),
    ),
    http.get(`${origin}/api/agents/options/page`, () =>
      HttpResponse.json(page),
    ),
    http.get(`${origin}/api/agents/options`, () => HttpResponse.json(page)),
    http.put(`${origin}/api/dev-feedback/setup`, async ({ request }) => {
      saved.push(await request.json());
      return HttpResponse.json({ configured: true, channelName: "feedback" });
    }),
  );
  const user = userEvent.setup();
  withClient(
    <DevFeedbackSetupPanel
      currentChannelName={null}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "feedback" }));
  await user.click(
    await screen.findByRole("button", { name: "Feedback reviewer" }),
  );
  expect(
    screen.queryByRole("button", { name: "Without a runtime" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Post to #feedback" }));
  await waitFor(() =>
    expect(saved).toEqual([
      { botId: "A1", channelId: "C1", agentId: runtimeAgent.id },
    ]),
  );
  await user.click(screen.getByRole("button", { name: "Post only" }));
  await user.click(screen.getByRole("button", { name: "Post to #feedback" }));
  await waitFor(() =>
    expect(saved[1]).toEqual({ botId: "A1", channelId: "C1", agentId: null }),
  );
});

it.each([
  "started",
  "failed",
] as const)("closes a posted report when agent review %s without submitting it again", async (status) => {
  const requests: Record<string, unknown>[] = [];
  const permalink = "https://example.slack.com/archives/C1/p1729426801000100";
  server.use(
    http.post(`${origin}/api/dev-feedback/comments`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      return HttpResponse.json({
        ...body,
        id: "1729426801.000100",
        authorName: "Reporter",
        replyCount: 0,
        permalink,
        createdAt: "2026-10-26T12:00:00.000Z",
        dispatch: {
          status,
          runId: status === "started" ? runtimeAgent.id : null,
          message: status === "failed" ? "Connect the reviewing agent." : null,
        },
      });
    }),
  );
  const onDone = vi.fn();
  const user = userEvent.setup();
  withClient(
    <DraftPopover
      draft={{
        selector: "main",
        label: "Page",
        rect: new DOMRect(0, 0, 200, 100),
        x: 100,
        y: 100,
        elementX: 0.5,
        elementY: 0.5,
        viewportX: 0.5,
        viewportY: 0.5,
        frame: null,
      }}
      route="/agents"
      clip={null}
      onDone={onDone}
    />,
  );
  await user.type(
    screen.getByPlaceholderText("Add a comment"),
    "Keep this context",
  );
  await user.click(screen.getByRole("button", { name: "Post to Slack" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    text: "Keep this context",
    route: "/agents",
    selector: "main",
    label: "Page",
  });
  expect(toast.success).toHaveBeenCalledWith(
    "Posted to Slack",
    expect.objectContaining({
      description:
        status === "started"
          ? "Agent review started. Its response will appear in the Slack thread."
          : "Connect the reviewing agent. Open the Slack thread and ask the configured agent manually. Do not repost the feedback.",
      action: expect.objectContaining({ label: "Open" }),
    }),
  );
});
