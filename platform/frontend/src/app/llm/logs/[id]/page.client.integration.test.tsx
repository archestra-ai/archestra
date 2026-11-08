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
import { delay, HttpResponse, http } from "msw";
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
import { useFeature } from "@/lib/config/config.query";
import {
  makeInteraction,
  makeSessionSummary,
  paginated,
} from "@/mocks/data/interactions";
import SessionDetailPage from "./page.client";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("sonner");
// Signed out here, so the config never loads and every flag reads as unset;
// a test turns OpenAPPA on.
vi.mock("@/lib/config/config.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/config.query")>()),
  useFeature: vi.fn(),
}));

const origin = "http://localhost:9000";
const sessionsUrl = `${origin}/api/llm-proxy-logs/sessions`;
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
  vi.mocked(useFeature).mockReturnValue(undefined);
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
    http.get(`${origin}/api/llm-proxy-logs/summaries`, () =>
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
    http.get(`${origin}/api/llm-proxy-logs/summaries`, () =>
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

it("leads each request's tokens with its output, labels the input, and gives exact counts on hover", async () => {
  serveSession({
    rows: [
      summary({
        id: "request-0",
        inputTokens: 12_345,
        outputTokens: 678,
        cacheReadTokens: 9_000,
        cacheWriteTokens: null,
      }),
    ],
  });

  await renderPage();

  const requests = await screen.findByRole("list", { name: "Requests" });
  const output = await within(requests).findByText("678");
  const cell = output.parentElement as HTMLElement;
  expect(within(cell).getByText("in")).toBeVisible();
  expect(within(cell).getByText("12.3K")).toBeVisible();

  await userEvent.hover(cell);
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip).toHaveTextContent("Output678");
  expect(tooltip).toHaveTextContent("Input12,345");
  expect(tooltip).toHaveTextContent("Cache read9,000");
  // A cache count the provider did not report is left out, not shown as 0.
  expect(tooltip).not.toHaveTextContent("Cache write");
});

it("shows unknown usage when a request has no provider token count", async () => {
  serveSession({
    rows: [
      summary({
        id: "request-no-usage",
        inputTokens: null,
        outputTokens: null,
      }),
    ],
  });

  await renderPage();

  const requests = await screen.findByRole("list", { name: "Requests" });
  expect(within(requests).getByText("Unknown")).toBeVisible();
  expect(
    await screen.findByText(
      "No token count was received for this request. This can happen when a stream ends early or the provider does not include token counts.",
    ),
  ).toBeVisible();
});

it("keeps a missing output count unknown when input usage is reported", async () => {
  serveSession({
    rows: [
      summary({
        id: "request-partial-usage",
        inputTokens: 12,
        outputTokens: null,
      }),
    ],
  });

  await renderPage();

  expect(
    await screen.findByText(
      "Not all token counts were received for this request. This can happen when a stream ends early or the provider returns only some counts.",
    ),
  ).toBeVisible();
  const tokens = screen.getByText("Output").closest("li");
  expect(tokens).toHaveTextContent("Unknown");
  expect(screen.getByText("Fresh input").closest("li")).toHaveTextContent("12");
});

it("starts page one at the session's first request", async () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    summary({
      id: `request-${i}`,
      model: `model-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }),
  );
  serveSession({ rows });

  await renderPage();

  const requests = await screen.findByRole("list", { name: "Requests" });
  const names = within(requests)
    .getAllByRole("button", { name: /^Test Agent, Model \d+,/ })
    .map((row) => row.getAttribute("aria-label")?.match(/Model (\d+)/)?.[1]);
  expect(names[0]).toBe("0");
  expect(names).toHaveLength(50);
  expect(names).not.toContain("59");
});

it("shows a full page of 100 requests", async () => {
  const rows = Array.from({ length: 120 }, (_, i) =>
    summary({
      id: `request-${i}`,
      model: `model-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i * 100)).toISOString(),
    }),
  );
  serveSession({ rows });
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("pageSize=100") as ReturnType<typeof useSearchParams>,
  );

  await renderPage();

  const requests = await screen.findByRole("list", { name: "Requests" });
  expect(
    within(requests).getAllByRole("button", {
      name: /^Test Agent, Model \d+,/,
    }),
  ).toHaveLength(100);
});

it("places a linked request among others created at the same moment", async () => {
  // The 50th and 51st requests share a timestamp: the id breaks the tie, so
  // request-49 is the last row of page one, not the first of page two.
  const rows = Array.from({ length: 60 }, (_, i) =>
    summary({
      id: `request-${String(i).padStart(2, "0")}`,
      model: `model-${i}`,
      createdAt: new Date(
        Date.UTC(2026, 0, 1, 0, 0, i === 50 ? 49 : i),
      ).toISOString(),
    }),
  );
  serveSession({ rows });
  // Opened on page two: a count of requests up to its timestamp (51) would
  // keep it there and report it missing.
  let search = new URLSearchParams("request=request-49&page=2&pageSize=50");
  vi.mocked(useSearchParams).mockImplementation(
    () => search as ReturnType<typeof useSearchParams>,
  );
  push.mockImplementation((url: string) => {
    search = new URLSearchParams(url.split("?")[1]);
  });

  const { rerender } = await renderPage();
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/llm/logs/test-session?request=request-49&page=1&pageSize=50",
      { scroll: false },
    ),
  );
  await rerender();

  const requests = await screen.findByRole("list", { name: "Requests" });
  expect(
    await within(requests).findByRole("button", {
      name: /^Test Agent, Model 49,/,
    }),
  ).toHaveAttribute("aria-current", "true");
});

it("opens the request a link names, moving to the page that holds it", async () => {
  // Sixty requests, oldest first: the linked one is the 56th, so it sits on
  // page two of fifty.
  const rows = Array.from({ length: 60 }, (_, i) =>
    summary({
      id: `request-${i}`,
      model: `model-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }),
  );
  serveSession({ rows });
  let search = new URLSearchParams("request=request-55");
  vi.mocked(useSearchParams).mockImplementation(
    () => search as ReturnType<typeof useSearchParams>,
  );
  push.mockImplementation((url: string) => {
    search = new URLSearchParams(url.split("?")[1]);
  });

  const { rerender } = await renderPage();
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/llm/logs/test-session?request=request-55&page=2&pageSize=50",
      { scroll: false },
    ),
  );
  await rerender();

  const requests = await screen.findByRole("list", { name: "Requests" });
  expect(
    await within(requests).findByRole("button", {
      name: /^Test Agent, Model 55,/,
    }),
  ).toHaveAttribute("aria-current", "true");
  expect(
    screen.queryByText(
      "The linked request isn't one of this session's requests.",
    ),
  ).not.toBeInTheDocument();
});

it("finds a linked request among more same-moment requests than one read holds", async () => {
  // Forty requests share one timestamp, across the page boundary.
  const rows = Array.from({ length: 80 }, (_, i) =>
    summary({
      id: `request-${String(i).padStart(2, "0")}`,
      model: `model-${i}`,
      createdAt: new Date(
        Date.UTC(2026, 0, 1, 0, 0, i >= 30 && i < 70 ? 30 : i),
      ).toISOString(),
    }),
  );
  serveSession({ rows });
  let search = new URLSearchParams("request=request-31&page=2&pageSize=50");
  vi.mocked(useSearchParams).mockImplementation(
    () => search as ReturnType<typeof useSearchParams>,
  );
  push.mockImplementation((url: string) => {
    search = new URLSearchParams(url.split("?")[1]);
  });

  const { rerender } = await renderPage();
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/llm/logs/test-session?request=request-31&page=1&pageSize=50",
      { scroll: false },
    ),
  );
  await rerender();

  const requests = await screen.findByRole("list", { name: "Requests" });
  expect(
    await within(requests).findByRole("button", {
      name: /^Test Agent, Model 31,/,
    }),
  ).toHaveAttribute("aria-current", "true");
});

it("finds a linked request by the database's order within one millisecond", async () => {
  // Rows 30-79 share a millisecond. The database's finer timestamps order
  // them against their ids, so the linked row (30, on page one) sorts by id
  // between page two's first and last rows.
  const rows = Array.from({ length: 100 }, (_, i) => {
    const tied = i >= 30 && i < 80;
    return summary({
      id: tied
        ? `t-${String(109 - i)}`
        : `request-${String(i).padStart(2, "0")}`,
      model: `model-${i}`,
      createdAt: new Date(
        Date.UTC(2026, 0, 1, 0, 0, tied ? 30 : i),
      ).toISOString(),
    });
  });
  serveSession({ rows, storedOrder: rows.map((row) => row.id) });
  let search = new URLSearchParams("request=t-79&page=2&pageSize=50");
  vi.mocked(useSearchParams).mockImplementation(
    () => search as ReturnType<typeof useSearchParams>,
  );
  push.mockImplementation((url: string) => {
    search = new URLSearchParams(url.split("?")[1]);
  });

  const { rerender } = await renderPage();
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/llm/logs/test-session?request=t-79&page=1&pageSize=50",
      { scroll: false },
    ),
  );
  await rerender();

  const requests = await screen.findByRole("list", { name: "Requests" });
  expect(
    await within(requests).findByRole("button", {
      name: /^Test Agent, Model 30,/,
    }),
  ).toHaveAttribute("aria-current", "true");
  expect(
    screen.queryByText(
      "The linked request isn't one of this session's requests.",
    ),
  ).not.toBeInTheDocument();
});

it("finds a linked tool call that a long request's start puts on the next page", async () => {
  // Request 50 finishes after the call but started long before it, so its
  // page (two) owns the call although only 31 requests finished before it.
  const rows = Array.from({ length: 60 }, (_, i) =>
    summary({
      id: `request-${String(i).padStart(2, "0")}`,
      model: `model-${i}`,
      createdAt: new Date(
        Date.UTC(2026, 0, 1, 0, 0, i, i === 50 ? 900 : 0),
      ).toISOString(),
      durationMs: i === 50 ? 40_000 : 500,
    }),
  );
  serveSession({ rows });
  const call = {
    id: "linked-call",
    agentId: "agent-1",
    ownerType: "agent",
    mcpServerName: "github",
    method: "tools/call",
    sessionId: "test-session",
    createdAt: "2026-01-01T00:00:30.000Z",
    toolCall: { id: "c1", name: "github__search", arguments: {} },
    toolResult: { isError: false, content: [] },
  };
  server.use(
    http.get(`${origin}/api/mcp-tool-calls/linked-call`, () =>
      HttpResponse.json(call),
    ),
    http.get(`${origin}/api/mcp-tool-calls`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const start = params.get("startDate") ?? "";
      const end = params.get("endDate");
      const inWindow =
        call.createdAt >= start && (!end || call.createdAt <= end);
      return HttpResponse.json({
        data: inWindow ? [call] : [],
        pagination: { hasNext: false },
      });
    }),
  );
  let search = new URLSearchParams("toolCall=linked-call");
  vi.mocked(useSearchParams).mockImplementation(
    () => search as ReturnType<typeof useSearchParams>,
  );
  push.mockImplementation((url: string) => {
    search = new URLSearchParams(url.split("?")[1]);
  });

  const { rerender } = await renderPage();
  await waitFor(() =>
    expect(push).toHaveBeenLastCalledWith(
      "/llm/logs/test-session?toolCall=linked-call&page=2&pageSize=50",
      { scroll: false },
    ),
  );
  await rerender();

  const requests = await screen.findByRole("list", { name: "Requests" });
  expect(
    await within(requests).findByRole("button", {
      name: /^Tool call search on github,/,
    }),
  ).toHaveAttribute("aria-current", "true");
});

it("finds a linked tool call from a page past the session's end", async () => {
  serveLinkedCall({ requests: 60, callAt: "2026-01-01T00:00:30.000Z" });
  let search = new URLSearchParams("toolCall=linked-call&page=3&pageSize=50");
  vi.mocked(useSearchParams).mockImplementation(
    () => search as ReturnType<typeof useSearchParams>,
  );
  push.mockImplementation((url: string) => {
    search = new URLSearchParams(url.split("?")[1]);
  });

  const { rerender } = await renderPage();
  await waitFor(() =>
    expect(push).toHaveBeenLastCalledWith(
      "/llm/logs/test-session?toolCall=linked-call&page=1&pageSize=50",
      { scroll: false },
    ),
  );
  await rerender();

  const requests = await screen.findByRole("list", { name: "Requests" });
  expect(
    await within(requests).findByRole("button", {
      name: /^Tool call search on github,/,
    }),
  ).toHaveAttribute("aria-current", "true");
});

it("stops looking for a linked tool call when the viewer pages elsewhere", async () => {
  serveLinkedCall({ requests: 120, callAt: "2026-01-01T00:00:30.000Z" });
  let search = new URLSearchParams("toolCall=linked-call&page=3&pageSize=50");
  vi.mocked(useSearchParams).mockImplementation(
    () => search as ReturnType<typeof useSearchParams>,
  );

  const { rerender } = await renderPage();
  // The walk heads for page one; the viewer picks page two before it lands.
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/llm/logs/test-session?toolCall=linked-call&page=1&pageSize=50",
      { scroll: false },
    ),
  );
  search = new URLSearchParams("toolCall=linked-call&page=2&pageSize=50");
  await rerender();

  expect(
    await screen.findByText(
      "The linked tool call isn't among this page's records.",
    ),
  ).toBeVisible();
  expect(
    within(screen.getByRole("list", { name: "Requests" })).getByRole("button", {
      name: /^Test Agent, Model 50,/,
    }),
  ).toBeVisible();
});

it("settles a linked tool call's walk when the viewer goes back to where it started", async () => {
  serveLinkedCall({ requests: 120, callAt: "2026-01-01T00:00:30.000Z" });
  // Page one's rows are slow, so the viewer is back before they land.
  server.use(
    http.get(`${origin}/api/llm-proxy-logs/summaries`, async ({ request }) => {
      const params = new URL(request.url).searchParams;
      if (params.get("offset") === "0" && params.get("limit") === "50") {
        await delay(300);
      }
      return undefined;
    }),
  );
  let search = new URLSearchParams("toolCall=linked-call&page=3&pageSize=50");
  vi.mocked(useSearchParams).mockImplementation(
    () => search as ReturnType<typeof useSearchParams>,
  );
  push.mockImplementation((url: string) => {
    search = new URLSearchParams(url.split("?")[1]);
  });

  const { rerender } = await renderPage();
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/llm/logs/test-session?toolCall=linked-call&page=1&pageSize=50",
      { scroll: false },
    ),
  );
  await rerender();
  // Back to page three.
  search = new URLSearchParams("toolCall=linked-call&page=3&pageSize=50");
  await rerender();

  expect(
    await screen.findByText(
      "The linked tool call isn't among this page's records.",
    ),
  ).toBeVisible();
});

it("reports a failed lookup of a linked tool call's page with a retry", async () => {
  serveLinkedCall({ requests: 60, callAt: "2026-01-01T00:00:30.000Z" });
  server.use(
    http.get(`${origin}/api/llm-proxy-logs/summaries`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      if (
        params.get("limit") === "1" &&
        params.get("endDate") === "2026-01-01T00:00:30.000Z"
      ) {
        return HttpResponse.json(
          { error: { message: "boom", type: "api_internal_server_error" } },
          { status: 500 },
        );
      }
    }),
  );
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(
      "toolCall=linked-call&page=2&pageSize=50",
    ) as ReturnType<typeof useSearchParams>,
  );

  await renderPage();

  expect(
    await screen.findByText(
      "Couldn't find the page that holds the linked tool call.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByText("The linked tool call isn't among this page's records."),
  ).not.toBeInTheDocument();
});

it("keeps a page's tool-call window closed when the next page's boundary fails to load", async () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    summary({
      id: `request-${i}`,
      model: `model-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }),
  );
  serveSession({ rows });
  const toolCallReads = vi.fn();
  server.use(
    http.get(`${origin}/api/llm-proxy-logs/summaries`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      if (params.get("offset") === "50" && params.get("limit") === "1") {
        return HttpResponse.json(
          { error: { message: "boom", type: "api_internal_server_error" } },
          { status: 500 },
        );
      }
    }),
    http.get(`${origin}/api/mcp-tool-calls`, () => {
      toolCallReads();
      return HttpResponse.json({ data: [], pagination: { hasNext: false } });
    }),
  );

  await renderPage();

  expect(await screen.findByText("Tool calls didn't load")).toBeVisible();
  // An open window would have read the later pages' calls into this one.
  expect(toolCallReads).not.toHaveBeenCalled();
});

it("keeps looking for a linked tool call while the next page's boundary is unavailable", async () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    summary({
      id: `request-${i}`,
      model: `model-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }),
  );
  serveSession({ rows });
  server.use(
    http.get(`${origin}/api/llm-proxy-logs/summaries`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      if (params.get("offset") === "50" && params.get("limit") === "1") {
        return HttpResponse.json(
          { error: { message: "boom", type: "api_internal_server_error" } },
          { status: 500 },
        );
      }
    }),
    http.get(`${origin}/api/mcp-tool-calls/linked-call`, () =>
      HttpResponse.json({
        id: "linked-call",
        agentId: "agent-1",
        ownerType: "agent",
        mcpServerName: "github",
        method: "tools/call",
        sessionId: "test-session",
        createdAt: "2026-01-01T00:00:10.500Z",
        toolCall: { id: "c1", name: "github__search", arguments: {} },
        toolResult: { isError: false, content: [] },
      }),
    ),
  );
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("toolCall=linked-call") as ReturnType<
      typeof useSearchParams
    >,
  );

  await renderPage();

  expect(await screen.findByText("Tool calls didn't load")).toBeVisible();
  // Without a boundary there is no window to look in, so no verdict yet.
  expect(
    screen.queryByText("The linked tool call isn't among this page's records."),
  ).not.toBeInTheDocument();
});

it("lets the viewer page away from a linked request that was already on the page", async () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    summary({
      id: `request-${String(i).padStart(2, "0")}`,
      model: `model-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }),
  );
  serveSession({ rows });
  let search = new URLSearchParams("request=request-10&pageSize=50");
  vi.mocked(useSearchParams).mockImplementation(
    () => search as ReturnType<typeof useSearchParams>,
  );
  push.mockImplementation((url: string) => {
    search = new URLSearchParams(url.split("?")[1]);
  });

  const { rerender } = await renderPage();
  const requests = await screen.findByRole("list", { name: "Requests" });
  expect(
    await within(requests).findByRole("button", {
      name: /^Test Agent, Model 10,/,
    }),
  ).toHaveAttribute("aria-current", "true");

  // The viewer moves to page two; the link stays in the URL.
  search = new URLSearchParams("request=request-10&page=2&pageSize=50");
  push.mockClear();
  await rerender();
  expect(
    await within(
      await screen.findByRole("list", { name: "Requests" }),
    ).findByRole("button", { name: /^Test Agent, Model 55,/ }),
  ).toBeVisible();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(push).not.toHaveBeenCalled();
});

it("reports a failed lookup of a linked request's page as an error, not a missing request", async () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    summary({
      id: `request-${String(i).padStart(2, "0")}`,
      model: `model-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }),
  );
  serveSession({ rows });
  server.use(
    http.get(`${origin}/api/llm-proxy-logs/summaries`, ({ request }) => {
      if (new URL(request.url).searchParams.has("beforeId")) {
        return HttpResponse.json(
          { error: { message: "boom", type: "api_internal_server_error" } },
          { status: 500 },
        );
      }
    }),
  );
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("request=request-55&pageSize=50") as ReturnType<
      typeof useSearchParams
    >,
  );

  await renderPage();

  expect(
    await screen.findByText(
      "Couldn't find the page that holds the linked request.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByText(
      "The linked request isn't one of this session's requests.",
    ),
  ).not.toBeInTheDocument();
});

it("opens the request on an earlier page that asked for the tool behind a label change", async () => {
  serveOffPageCause();

  await renderPage();

  const stepper = await screen.findByRole("button", {
    name: /^1 label change\. Opens the request that caused it\.$/,
  });
  await userEvent.click(stepper);
  expect(push).toHaveBeenCalledWith(
    "/llm/logs/test-session?request=request-010&pageSize=50",
    { scroll: false },
  );
});

it("says when looking up the earlier request behind a label change failed", async () => {
  serveOffPageCause();
  server.use(
    http.get(`${origin}/api/llm-proxy-logs/summaries`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      if (
        params.get("limit") === "100" &&
        params.get("sortDirection") === "desc"
      ) {
        return HttpResponse.json(
          { error: { message: "boom", type: "api_internal_server_error" } },
          { status: 500 },
        );
      }
    }),
  );

  await renderPage();

  expect(
    await screen.findByText(
      "Couldn't look up which earlier request caused a label change.",
    ),
  ).toBeVisible();
  expect(
    screen.getByRole("button", {
      name: /^1 label change\. Selects the row that caused it\.$/,
    }),
  ).toBeVisible();
});

it("says when a later page's axis counts from the page, not the session", async () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    summary({
      id: `request-${i}`,
      model: `model-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }),
  );
  serveSession({ rows });
  server.use(
    http.get(`${origin}/api/llm-proxy-logs/summaries`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      if (params.get("offset") === "0" && params.get("limit") === "1") {
        return HttpResponse.json(
          { error: { message: "boom", type: "api_internal_server_error" } },
          { status: 500 },
        );
      }
    }),
  );
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("page=2&pageSize=50") as ReturnType<
      typeof useSearchParams
    >,
  );

  await renderPage();

  expect(
    await screen.findByText(
      "Times on the axis count from this page's first request: the session's start didn't load.",
    ),
  ).toBeVisible();
});

it("opens a linked tool call on its page without drawing another page first", async () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    summary({
      id: `request-${i}`,
      model: `model-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }),
  );
  serveSession({ rows });
  // Between requests 52 and 53: the second page's window.
  const call = {
    id: "linked-call",
    agentId: "agent-1",
    ownerType: "agent",
    mcpServerName: "github",
    method: "tools/call",
    sessionId: "test-session",
    createdAt: "2026-01-01T00:00:52.500Z",
    toolCall: { id: "c1", name: "github__search", arguments: {} },
    toolResult: { isError: false, content: [] },
  };
  server.use(
    http.get(`${origin}/api/mcp-tool-calls/linked-call`, () =>
      HttpResponse.json(call),
    ),
    http.get(`${origin}/api/mcp-tool-calls`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const start = params.get("startDate") ?? "";
      const end = params.get("endDate");
      const inWindow =
        call.createdAt >= start && (!end || call.createdAt <= end);
      return HttpResponse.json({
        data: inWindow ? [call] : [],
        pagination: { hasNext: false },
      });
    }),
  );
  let search = new URLSearchParams("toolCall=linked-call");
  vi.mocked(useSearchParams).mockImplementation(
    () => search as ReturnType<typeof useSearchParams>,
  );
  push.mockImplementation((url: string) => {
    search = new URLSearchParams(url.split("?")[1]);
  });

  const { rerender } = await renderPage();
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/llm/logs/test-session?toolCall=linked-call&page=2&pageSize=50",
      { scroll: false },
    ),
  );
  // The first page was never drawn: the trace waited for the link's page.
  // A render after the push may already show page 2, so look for page 1's
  // rows rather than for no list at all.
  expect(
    screen.queryByRole("button", { name: /^Test Agent, Model 0,/ }),
  ).not.toBeInTheDocument();
  await rerender();

  const requests = await screen.findByRole("list", { name: "Requests" });
  expect(
    await within(requests).findByRole("button", {
      name: /^Tool call search on github,/,
    }),
  ).toHaveAttribute("aria-current", "true");
  expect(
    within(requests).queryByRole("button", { name: /^Test Agent, Model 0,/ }),
  ).not.toBeInTheDocument();
});

it("says so when a linked request is not one of the session's", async () => {
  serveSession({ rows: [summary({ id: "request-0" })] });
  server.use(
    http.get(`${origin}/api/llm-proxy-logs/elsewhere`, () =>
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

it("sizes a request's branches, clamps a long value, and shows it whole as raw text", async () => {
  const user = userEvent.setup();
  serveSession({
    rows: [summary({ id: "request-0" })],
    records: {
      "request-0": makeInteraction({
        id: "request-0",
        sessionId: "test-session",
        request: {
          model: "gpt-4o",
          messages: [
            { role: "user", content: `tool output ${"x".repeat(20_000)}` },
          ],
        },
      }),
    },
  });

  await renderPage();
  await user.click(await screen.findByRole("tab", { name: "Request" }));

  const panel = screen.getByRole("tabpanel", { name: "Request" });
  const payload = within(panel).getByRole("region", { name: "Request" });
  const whole = "x".repeat(20_000);
  expect(await within(payload).findByText("1 item · 19.6 KB")).toBeVisible();
  expect(within(payload).getByText(/tool output/)).toBeVisible();
  expect(payload).not.toHaveTextContent(whole);

  await user.click(within(payload).getByRole("button", { name: "Raw" }));
  expect(await within(payload).findByText(/tool output/)).toBeVisible();
  expect(payload).toHaveTextContent(whole);
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
    http.get(`${origin}/api/llm-proxy-logs/summaries`, () =>
      HttpResponse.json(paginated([summary({ id: lone.id, sessionId: null })])),
    ),
    http.get(`${origin}/api/llm-proxy-logs/${lone.id}`, () =>
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

it("says which handed-off run's records failed to load, and retries them", async () => {
  serveSession({
    rows: [summary({ id: "client-1", createdAt: "2026-01-01T00:00:05.000Z" })],
  });
  let runtimeFails = true;
  server.use(
    http.get(`${origin}/api/llm-proxy-logs/sessions/:id/handoffs`, () =>
      HttpResponse.json({
        handedTo: [
          {
            runId: "8c1f2e3d-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
            llmSessionId: "agent-run-docs",
            originLlmSessionId: "test-session",
            agentName: "Docs Writer",
            title: "Update the docs",
            startedAt: "2026-01-01T00:00:06.000Z",
          },
        ],
        handedToTruncated: false,
        handedFrom: null,
        moves: [],
      }),
    ),
    http.get(`${origin}/api/llm-proxy-logs/summaries`, ({ request }) => {
      if (
        new URL(request.url).searchParams.get("sessionId") !== "agent-run-docs"
      ) {
        return;
      }
      return runtimeFails
        ? HttpResponse.json(
            { error: { message: "boom", type: "api_internal_server_error" } },
            { status: 500 },
          )
        : HttpResponse.json(
            paginated([
              summary({
                id: "runtime-1",
                sessionId: "agent-run-docs",
                createdAt: "2026-01-01T00:00:08.000Z",
              }),
            ]),
          );
    }),
    http.get(`${origin}/api/mcp-tool-calls`, () =>
      HttpResponse.json({ data: [], pagination: { hasNext: false } }),
    ),
  );
  await renderPage();

  const notice = (await screen.findByText("Agent Runtime records didn't load"))
    .parentElement as HTMLElement;
  expect(notice).toHaveTextContent("Docs Writer");
  runtimeFails = false;
  fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(
      screen.queryByText("Agent Runtime records didn't load"),
    ).not.toBeInTheDocument(),
  );
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
 * Serves one session the way the API pages it: by `offset` and `limit` in
 * `sortDirection` order (newest first by default), with `startDate` and
 * `endDate` bounding which requests count.
 */
function serveSession({
  rows,
  lastInteractionId,
  records = {},
  storedOrder,
}: {
  rows: Summary[];
  lastInteractionId?: string | null;
  records?: Record<string, ReturnType<typeof makeInteraction>>;
  /**
   * Row ids oldest first as the database orders them, when its finer
   * timestamps order rows the API shows at one millisecond.
   */
  storedOrder?: string[];
}) {
  // Newest first, ties by id, as the API orders them.
  const sorted = storedOrder
    ? storedOrder
        .map((id) => rows.find((row) => row.id === id) as Summary)
        .reverse()
    : [...rows].sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      );
  const latestId = lastInteractionId ?? sorted[0]?.id ?? null;
  server.use(
    http.get(sessionsUrl, () =>
      HttpResponse.json(
        paginated([
          makeSessionSummary({
            sessionId: "test-session",
            requestCount: rows.length,
            lastInteractionId: latestId,
          }),
        ]),
      ),
    ),
    http.get(`${origin}/api/llm-proxy-logs/summaries`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const startDate = params.get("startDate");
      const endDate = params.get("endDate");
      const beforeId = params.get("beforeId");
      const ordered =
        params.get("sortDirection") === "asc" ? [...sorted].reverse() : sorted;
      // Before `beforeId` in the stored order, which `sorted` reverses.
      const beforeRank = beforeId
        ? sorted.length - 1 - sorted.findIndex((row) => row.id === beforeId)
        : null;
      const matching = ordered.filter(
        (row) =>
          (!startDate || row.createdAt >= startDate) &&
          (!endDate || row.createdAt <= endDate) &&
          (beforeRank === null ||
            sorted.length - 1 - sorted.indexOf(row) < beforeRank),
      );
      const offset = Number(params.get("offset") ?? 0);
      const limit = Number(params.get("limit") ?? 10);
      // The list endpoint's largest page, as PaginationQuerySchema enforces.
      if (limit > 100) {
        return HttpResponse.json(
          {
            error: { message: "limit too large", type: "api_validation_error" },
          },
          { status: 400 },
        );
      }
      return HttpResponse.json(
        paginated(matching.slice(offset, offset + limit), {
          total: matching.length,
          limit,
          hasNext: offset + limit < matching.length,
        }),
      );
    }),
    http.get(`${origin}/api/llm-proxy-logs/:id`, ({ params }) => {
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

/**
 * Page 4 of a 160-request session, OpenAPPA on, with one label change caused
 * by a client-run tool that request 10 asked for. Requests 100-140 predate
 * recorded call ids, so finding request 10 reads past them.
 */
function serveOffPageCause() {
  const rows = Array.from({ length: 160 }, (_, i) =>
    summary({
      id: `request-${String(i).padStart(3, "0")}`,
      model: `model-${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      ...(i === 10
        ? { responseToolCalls: [{ id: "call_shell", name: "exec_command" }] }
        : i >= 100 && i <= 140
          ? {}
          : { responseToolCalls: [] }),
    } as Partial<ReturnType<typeof makeInteraction>>),
  );
  serveSession({ rows });
  const labelChange = (params: {
    event: string;
    at: string;
    callId: string | null;
    trustAfter: string;
  }) => ({
    id: `${params.event}-${params.at}`,
    organizationId: "org",
    root: "root",
    sessionId: "test-session",
    callerId: null,
    createdAt: params.at,
    event: params.event,
    callId: params.callId,
    tool: null,
    trustBefore: "trusted",
    audienceBefore: "public",
    trustAfter: params.trustAfter,
    audienceAfter: "public",
    policyRevision: null,
    rule: null,
  });
  server.use(
    http.get(`${origin}/api/llm-proxy-logs/sessions/:sessionId/lineage`, () =>
      HttpResponse.json({ forkedFrom: null, forks: [], forksTruncated: false }),
    ),
    http.get(`${origin}/api/openappa/external-consults`, () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get(`${origin}/api/openappa/yells`, () =>
      HttpResponse.json({ data: [], pagination: { hasNext: false } }),
    ),
    http.get(`${origin}/api/openappa/label-changes`, () =>
      HttpResponse.json({
        data: [
          labelChange({
            event: "session_start",
            at: "2026-01-01T00:00:00.000Z",
            callId: null,
            trustAfter: "trusted",
          }),
          labelChange({
            event: "tool_result",
            at: new Date(Date.UTC(2026, 0, 1, 0, 0, 155, 500)).toISOString(),
            callId: "call:call_shell",
            trustAfter: "suspicious",
          }),
        ],
      }),
    ),
  );
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("page=4&pageSize=50") as ReturnType<
      typeof useSearchParams
    >,
  );
  vi.mocked(useFeature).mockImplementation(((flag: string) =>
    flag === "openappaEnabled" ? true : undefined) as typeof useFeature);
}

/** A session of `requests` half-second requests, one a second, and a linked tool call. */
function serveLinkedCall({
  requests,
  callAt,
}: {
  requests: number;
  callAt: string;
}) {
  serveSession({
    rows: Array.from({ length: requests }, (_, i) =>
      summary({
        id: `request-${String(i).padStart(3, "0")}`,
        model: `model-${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        durationMs: 500,
      }),
    ),
  });
  const call = {
    id: "linked-call",
    agentId: "agent-1",
    ownerType: "agent",
    mcpServerName: "github",
    method: "tools/call",
    sessionId: "test-session",
    createdAt: callAt,
    toolCall: { id: "c1", name: "github__search", arguments: {} },
    toolResult: { isError: false, content: [] },
  };
  server.use(
    http.get(`${origin}/api/mcp-tool-calls/linked-call`, () =>
      HttpResponse.json(call),
    ),
    http.get(`${origin}/api/mcp-tool-calls`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const start = params.get("startDate") ?? "";
      const end = params.get("endDate");
      const inWindow =
        call.createdAt >= start && (!end || call.createdAt <= end);
      return HttpResponse.json({
        data: inWindow ? [call] : [],
        pagination: { hasNext: false },
      });
    }),
  );
}
