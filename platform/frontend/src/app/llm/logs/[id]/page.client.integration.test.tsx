import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  makeInteraction,
  makeSessionSummary,
  paginated,
} from "@/mocks/data/interactions";
import SessionDetailPage from "./page.client";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("sonner");

const origin = "http://localhost:9000";
const sessionsUrl = `${origin}/api/interactions/sessions`;
const emptySessions = {
  data: [],
  pagination: { limit: 1, nextCursor: null, hasNext: false },
};
const server = setupServer();
const push = vi.fn();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(usePathname).mockReturnValue("/llm/logs/test-session");
  push.mockReset();
  vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<
    typeof useRouter
  >);
  archestraApiClient.setConfig({ baseUrl: origin });
  server.use(
    // The message thread reads the viewer's permissions; signed out here.
    http.get(`${origin}/api/bootstrap`, () =>
      HttpResponse.json(null, { status: 401 }),
    ),
    http.get(sessionsUrl, () => HttpResponse.json(emptySessions)),
    http.get(`${origin}/api/interactions/summaries`, () =>
      HttpResponse.json({ data: [], pagination: { total: 0 } }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("replaces authorization-filtered session details with access guidance and a way back", async () => {
  await renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Session unavailable",
  );
  expect(screen.getByText(/ask an administrator/)).toBeVisible();
  for (const link of screen.getAllByRole("link", {
    name: "Back to Sessions",
  })) {
    expect(link).toHaveAttribute("href", "/llm/logs");
  }
  expect(screen.queryByText("Requests")).not.toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Export JSON" }),
  ).not.toBeInTheDocument();
});

it("lets a failed session lookup recover on retry instead of claiming access is unavailable", async () => {
  server.use(
    http.get(sessionsUrl, () =>
      HttpResponse.json(
        {
          error: {
            message: "Unable to load session",
            type: "api_internal_server_error",
          },
        },
        { status: 500 },
      ),
    ),
  );
  await renderPage();
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.queryByText("Session unavailable")).not.toBeInTheDocument();
  server.use(http.get(sessionsUrl, () => HttpResponse.json(emptySessions)));
  fireEvent.click(retry);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Session unavailable",
  );
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
});

it("shows total latency per request and leaves untimed records empty", async () => {
  const rows = [1240, 386, 0, null].map((durationMs, i) => ({
    ...makeInteraction({
      id: `request-${i}`,
      sessionId: "test-session",
      durationMs,
    }),
    requestType: "main",
    externalAgentIdLabel: null,
  }));
  server.use(
    http.get(sessionsUrl, () =>
      HttpResponse.json(
        paginated([makeSessionSummary({ sessionId: "test-session" })]),
      ),
    ),
    http.get(`${origin}/api/interactions/summaries`, () =>
      HttpResponse.json(paginated(rows)),
    ),
  );
  await renderPage();
  expect(
    await screen.findByLabelText("Total request latency: 1.24s"),
  ).toBeVisible();
  expect(screen.getByLabelText("Total request latency: 386ms")).toBeVisible();
  expect(screen.getByLabelText("Total request latency: 0ms")).toBeVisible();
  expect(screen.getAllByLabelText(/Total request latency/)).toHaveLength(3);
});

it("opens the request a link names, moving to the page that holds it", async () => {
  // Fifteen requests, newest first: the linked one is the twelfth newest, so
  // it sits on page two of ten.
  const rows = Array.from({ length: 15 }, (_, i) =>
    summary({
      id: `request-${i}`,
      model: `model-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 15 - i)).toISOString(),
    }),
  );
  serveSession({ rows });
  let search = new URLSearchParams("request=request-11");
  vi.mocked(useSearchParams).mockImplementation(
    () => search as ReturnType<typeof useSearchParams>,
  );
  push.mockImplementation((url: string) => {
    search = new URLSearchParams(url.split("?")[1]);
  });

  const { rerender } = await renderPage();
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/llm/logs/test-session?request=request-11&page=2&pageSize=10",
      { scroll: false },
    ),
  );
  await rerender();

  const requests = await screen.findByRole("list", { name: "Requests" });
  expect(
    await within(requests).findByRole("button", {
      name: /^Test Agent, Model 11,/,
    }),
  ).toHaveAttribute("aria-current", "true");
  expect(
    screen.queryByText(
      "The linked request isn't one of this session's requests.",
    ),
  ).not.toBeInTheDocument();
});

it("says so when a linked request is not one of the session's", async () => {
  serveSession({ rows: [summary({ id: "request-0" })] });
  server.use(
    http.get(`${origin}/api/interactions/elsewhere`, () =>
      HttpResponse.json(
        makeInteraction({ id: "elsewhere", sessionId: "another-session" }),
      ),
    ),
  );
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("request=elsewhere") as ReturnType<
      typeof useSearchParams
    >,
  );

  await renderPage();

  expect(
    await screen.findByText(
      "The linked request isn't one of this session's requests.",
    ),
  ).toBeVisible();
  expect(push).not.toHaveBeenCalled();
});

it("shows the selected request's own conversation, not only the latest one", async () => {
  const user = userEvent.setup();
  serveSession({
    rows: [
      summary({ id: "latest", model: "model-newest" }),
      summary({
        id: "earlier",
        model: "model-earlier",
        createdAt: "2025-12-31T23:59:00.000Z",
      }),
    ],
    lastInteractionId: "latest",
    records: {
      latest: qa("latest", "Second question", "Second answer"),
      earlier: qa("earlier", "First question", "First answer"),
    },
  });

  await renderPage();

  const conversation = await screen.findByRole("tabpanel", {
    name: "Conversation",
  });
  expect(await within(conversation).findByText("Second answer")).toBeVisible();

  const requests = screen.getByRole("list", { name: "Requests" });
  await user.click(
    within(requests).getByRole("button", {
      name: /^Test Agent, Model Earlier,/,
    }),
  );
  expect(
    await within(
      screen.getByRole("tabpanel", { name: "Conversation" }),
    ).findByText("First answer"),
  ).toBeVisible();
  expect(screen.queryByText("Second answer")).not.toBeInTheDocument();
});

it("shows who sent a request, and the request before and after policy updates", async () => {
  const user = userEvent.setup();
  serveSession({
    rows: [summary({ id: "request-0" })],
    records: {
      "request-0": makeInteraction({
        id: "request-0",
        sessionId: "test-session",
        authMethod: "oauth_client_credentials",
        authenticatedAppId: "app-1",
        authenticatedAppName: "Billing bot",
        runId: "run-42",
        request: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "original prompt" }],
        },
        processedRequest: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "rewritten by policy" }],
        },
      }),
    },
  });

  await renderPage();
  await user.click(await screen.findByRole("tab", { name: "Request" }));

  const panel = screen.getByRole("tabpanel", { name: "Request" });
  const metadata = within(panel).getByRole("region", { name: "Metadata" });
  expect(metadata).toHaveTextContent("OAuth Client Credentials");
  expect(metadata).toHaveTextContent("Billing bot");
  expect(metadata).toHaveTextContent("run-42");
  const payload = within(panel).getByRole("region", { name: "Request" });
  expect(await within(payload).findByText(/original prompt/)).toBeVisible();

  await user.click(
    within(payload).getByRole("button", { name: "Sent to model" }),
  );
  expect(await within(payload).findByText(/rewritten by policy/)).toBeVisible();
  expect(
    within(payload).queryByText(/original prompt/),
  ).not.toBeInTheDocument();
});

it("shows how a request ended: a provider failure and blocked tool calls", async () => {
  const user = userEvent.setup();
  serveSession({
    rows: [summary({ id: "request-0" })],
    records: {
      "request-0": makeInteraction({
        id: "request-0",
        sessionId: "test-session",
        response: { error: "Upstream returned 529: overloaded" },
        toolCallBlock: {
          reason: "send_email is not allowed after reading untrusted data",
          blockedToolCallCount: 2,
        },
      }),
    },
  });

  await renderPage();
  await user.click(await screen.findByRole("tab", { name: "Response" }));

  const panel = screen.getByRole("tabpanel", { name: "Response" });
  expect(within(panel).getByText("The provider call failed")).toBeVisible();
  expect(
    within(panel).getByText("Upstream returned 529: overloaded"),
  ).toBeVisible();
  expect(
    within(panel).getByText("Guardrails blocked 2 tool calls"),
  ).toBeVisible();
  expect(
    within(panel).getByText(
      "send_email is not allowed after reading untrusted data",
    ),
  ).toBeVisible();
});

it("shows a request logged without a session as a session of its own", async () => {
  const lone = makeInteraction({ id: "lone-request", sessionId: null });
  server.use(
    // Like the API: the sessionless request's id is its session key.
    http.get(sessionsUrl, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("sessionId") === lone.id
          ? paginated([
              makeSessionSummary({
                sessionId: null,
                interactionId: lone.id,
                lastInteractionId: lone.id,
              }),
            ])
          : emptySessions,
      ),
    ),
    http.get(`${origin}/api/interactions/summaries`, () =>
      HttpResponse.json(paginated([summary({ id: lone.id, sessionId: null })])),
    ),
    http.get(`${origin}/api/interactions/${lone.id}`, () =>
      HttpResponse.json(lone),
    ),
    http.get(`${origin}/api/mcp-tool-calls`, () =>
      HttpResponse.json({ data: [], pagination: { hasNext: false } }),
    ),
  );

  await renderPage(lone.id);

  const requests = await screen.findByRole("list", { name: "Requests" });
  expect(within(requests).getAllByRole("button")).toHaveLength(1);
  expect(
    await within(
      await screen.findByRole("tabpanel", { name: "Conversation" }),
    ).findByText("The capital of France is Paris."),
  ).toBeVisible();
  expect(screen.queryByText("Session unavailable")).not.toBeInTheDocument();
});

async function renderPage(id = "test-session") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <Suspense>
        <SessionDetailPage paramsPromise={Promise.resolve({ id })} />
      </Suspense>
    </QueryClientProvider>
  );
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(tree());
  });
  return {
    rerender: () =>
      act(async () => {
        view?.rerender(tree());
      }),
  };
}

type Summary = ReturnType<typeof summary>;

/** A request as the session page's list carries it. */
function summary(overrides: Partial<ReturnType<typeof makeInteraction>> = {}) {
  return {
    ...makeInteraction({ sessionId: "test-session", ...overrides }),
    requestType: "main",
    externalAgentIdLabel: null,
  };
}

/** An interaction whose thread is one question and its answer. */
function qa(id: string, question: string, answer: string) {
  return makeInteraction({
    id,
    sessionId: "test-session",
    request: {
      model: "gpt-4o",
      messages: [{ role: "user", content: question }],
    },
    response: {
      id: `resp-${id}`,
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          logprobs: null,
          message: { content: answer, role: "assistant" },
        },
      ],
      created: 0,
      model: "gpt-4o",
      object: "chat.completion",
    },
  });
}

/**
 * Serves one session the way the API pages it: newest first by `offset` and
 * `limit`, and with `startDate` counting the requests at or after it.
 */
function serveSession({
  rows,
  lastInteractionId = rows[0]?.id ?? null,
  records = {},
}: {
  rows: Summary[];
  lastInteractionId?: string | null;
  records?: Record<string, ReturnType<typeof makeInteraction>>;
}) {
  const sorted = [...rows].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  server.use(
    http.get(sessionsUrl, () =>
      HttpResponse.json(
        paginated([
          makeSessionSummary({
            sessionId: "test-session",
            requestCount: rows.length,
            lastInteractionId,
          }),
        ]),
      ),
    ),
    http.get(`${origin}/api/interactions/summaries`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const startDate = params.get("startDate");
      const matching = startDate
        ? sorted.filter((row) => row.createdAt >= startDate)
        : sorted;
      const offset = Number(params.get("offset") ?? 0);
      const limit = Number(params.get("limit") ?? 10);
      return HttpResponse.json(
        paginated(matching.slice(offset, offset + limit), {
          total: matching.length,
          limit,
        }),
      );
    }),
    http.get(`${origin}/api/interactions/:id`, ({ params }) => {
      const id = String(params.id);
      const row = sorted.find((r) => r.id === id);
      const record =
        records[id] ??
        (row
          ? makeInteraction({
              id,
              sessionId: "test-session",
              createdAt: row.createdAt,
            })
          : null);
      return record
        ? HttpResponse.json(record)
        : HttpResponse.json(
            { error: { message: "Not found", type: "api_not_found_error" } },
            { status: 404 },
          );
    }),
    http.get(`${origin}/api/mcp-tool-calls`, () =>
      HttpResponse.json({ data: [], pagination: { hasNext: false } }),
    ),
  );
}
