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
  expect,
  test,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { ScheduleTriggerRun } from "@/lib/schedule-trigger.query";
import { ScheduleRunsList } from "./schedule-runs-list";

vi.mock("@/lib/auth/auth.query");
vi.mock("next/navigation");
const server = setupServer();
const api = "http://localhost:9000";
const triggerId = "00000000-0000-4000-8000-000000000001";
const blockingId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";
const agentId = "00000000-0000-4000-8000-000000000004";
const skipped: ScheduleTriggerRun = {
  id: "00000000-0000-4000-8000-000000000005",
  organizationId: "test-org",
  triggerId,
  runKind: "due",
  status: "failed",
  initiatedByUserId: null,
  chatConversationId: null,
  runtimeTaskId: null,
  startedAt: "2026-10-15T12:00:00Z",
  completedAt: "2026-10-15T12:00:00Z",
  createdAt: "2026-10-15T12:00:00Z",
  artifact: null,
  error: "Skipped: previous run is unfinished",
  blockedBy: {
    phase: "running",
    runId: blockingId,
    runtimeTaskId: taskId,
    startedAt: "2026-10-15T10:00:00Z",
    elapsedSeconds: 7200,
    deadline: "2026-10-15T14:00:00Z",
    maximumDurationSeconds: 14400,
  },
};

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: api });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  server.use(
    http.get(`${api}/api/schedule-triggers/${triggerId}`, () =>
      HttpResponse.json({ id: triggerId, agentId }),
    ),
    http.get(`${api}/api/schedule-triggers/${triggerId}/runs`, () =>
      HttpResponse.json({ data: [skipped], pagination: {} }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function show() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ScheduleRunsList triggerId={triggerId} />
    </QueryClientProvider>,
  );
}

test("a skipped tick exposes the exact blocker, elapsed time, deadline and safe actions", async () => {
  show();
  expect(
    await screen.findByRole("button", { name: /Scheduled run skipped/ }),
  ).toHaveAttribute("aria-expanded", "true");
  const details = screen.getByRole("region", { name: "Skipped run details" });
  expect(details).toHaveTextContent("2h");
  expect(screen.getByTitle(blockingId)).toBeVisible();
  expect(details).toHaveTextContent("4h");
  expect(details.querySelector("time")).toHaveAttribute(
    "datetime",
    "2026-10-15T14:00:00Z",
  );
  expect(
    screen.getByRole("link", { name: "Inspect previous run" }),
  ).toHaveAttribute("href", `/chat/runs/${taskId}`);
  expect(
    await screen.findByRole("link", { name: "Maximum duration settings" }),
  ).toHaveAttribute("href", `/agents/${agentId}/edit`);
  expect(
    screen.getByRole("region", { name: "Skipped run details" }),
  ).toHaveTextContent("future runtime sessions");
});

test("a reader is directed to an agent editor instead of an edit control", async () => {
  vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
    typeof useHasPermissions
  >);
  show();
  expect(await screen.findByText(/An agent editor can adjust/)).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Maximum duration settings" }),
  ).toBeNull();
  expect(
    screen.getByRole("link", { name: "Inspect previous run" }),
  ).toHaveAttribute("href", `/chat/runs/${taskId}`);
});

test("queued work has no fabricated runtime deadline and gains the current runtime link after launch", async () => {
  server.use(
    http.get(`${api}/api/schedule-triggers/${triggerId}/runs`, () =>
      HttpResponse.json({
        data: [
          {
            ...skipped,
            blockedBy: {
              ...skipped.blockedBy,
              phase: "starting",
              runtimeTaskId: null,
              deadline: null,
              maximumDurationSeconds: null,
            },
          },
          {
            ...skipped,
            id: blockingId,
            status: "running",
            runtimeTaskId: taskId,
            blockedBy: null,
          },
        ],
        pagination: {},
      }),
    ),
  );
  show();
  expect(
    await screen.findByText(/Previous run was starting · 2h elapsed/),
  ).toBeVisible();
  expect(screen.getByText(/deadline is available after launch/)).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Inspect previous run" }),
  ).toHaveAttribute("href", `/chat/runs/${taskId}`);
});

test("a stopping run explains that future ticks wait for confirmed cleanup", async () => {
  server.use(
    http.get(`${api}/api/schedule-triggers/${triggerId}/runs`, () =>
      HttpResponse.json({
        data: [
          {
            ...skipped,
            blockedBy: { ...skipped.blockedBy, phase: "stopping" },
          },
        ],
        pagination: {},
      }),
    ),
  );
  show();
  expect(
    await screen.findByText(/Previous run was stopping · 2h elapsed/),
  ).toBeVisible();
  expect(
    screen.getByRole("region", { name: "Skipped run details" }),
  ).toHaveTextContent("until workload cleanup is confirmed");
});

test("a queued blocker's inspection link resolves even when its row is on an older page", async () => {
  server.use(
    http.get(`${api}/api/schedule-triggers/${triggerId}/runs`, () =>
      HttpResponse.json({
        data: [
          {
            ...skipped,
            blockedBy: {
              ...skipped.blockedBy,
              phase: "starting",
              runtimeTaskId: null,
              deadline: null,
              maximumDurationSeconds: null,
            },
          },
        ],
        pagination: {},
      }),
    ),
    http.get(
      `${api}/api/schedule-triggers/${triggerId}/runs/${blockingId}`,
      () =>
        HttpResponse.json({
          ...skipped,
          id: blockingId,
          status: "running",
          runtimeTaskId: taskId,
          blockedBy: null,
        }),
    ),
  );
  show();
  expect(
    await screen.findByRole("link", { name: "Inspect previous run" }),
  ).toHaveAttribute("href", `/chat/runs/${taskId}`);
  expect(
    screen
      .getByRole("region", { name: "Skipped run details" })
      .querySelector("time"),
  ).toBeNull();
});

test("skipped details collapse without resolving a new chat", async () => {
  const user = userEvent.setup();
  show();
  const event = await screen.findByRole("button", {
    name: /Scheduled run skipped/,
  });
  await user.click(event);
  expect(
    screen.queryByRole("region", { name: "Skipped run details" }),
  ).toBeNull();
  expect(event).toHaveAttribute("aria-expanded", "false");
  await user.click(event);
  expect(
    screen.getByRole("region", { name: "Skipped run details" }),
  ).toBeVisible();
});

test("terminal events are ordered by completion time and retain their recorded timestamps", async () => {
  const stopped = {
    ...skipped,
    id: blockingId,
    status: "cancelled",
    blockedBy: null,
    runtimeTaskId: taskId,
    createdAt: "2026-10-15T10:00:00Z",
    completedAt: "2026-10-15T13:00:00Z",
  };
  server.use(
    http.get(`${api}/api/schedule-triggers/${triggerId}/runs`, () =>
      HttpResponse.json({ data: [skipped, stopped], pagination: {} }),
    ),
  );
  show();
  await screen.findByRole("button", { name: /Run stopped/ });
  const events = screen.getAllByRole("button", {
    name: /Run stopped|Scheduled run skipped/,
  });
  expect(events[0]).toHaveTextContent("Run stopped");
  expect(events[0].querySelector("time")).toHaveAttribute(
    "datetime",
    stopped.completedAt,
  );
  expect(events[1].querySelector("time")).toHaveAttribute(
    "datetime",
    skipped.createdAt,
  );
});
