import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { authQueryKeys } from "@/lib/auth/auth.query";
import type { ScheduleTrigger } from "@/lib/schedule-trigger.query";
import { adminPermissionsSeed, sessionSeed } from "@/mocks/data/auth";
import { AGENT_ID, SYNTHETIC_SCHEDULES } from "@/mocks/data/scheduled-runs";
import { AgentSchedulesSection } from "./agent-schedules-section";

vi.mock("sonner");
const origin = "http://localhost:9000";
const server = setupServer();
let schedules: ScheduleTrigger[] = [];
function page(data: unknown[]) {
  return {
    data,
    pagination: {
      limit: 25,
      currentPage: 1,
      total: data.length,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    },
  };
}
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  schedules = [];
  server.use(
    http.get(`${origin}/api/schedule-triggers`, () =>
      HttpResponse.json(page(schedules)),
    ),
    http.get(`${origin}/api/projects`, () => HttpResponse.json(page([]))),
    http.get(`${origin}/api/projects/:id`, () =>
      HttpResponse.json({ id: "project-new", name: "Reporter schedules" }),
    ),
    http.get(`${origin}/api/schedule-triggers/:id/runs`, () =>
      HttpResponse.json(page([])),
    ),
  );
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function renderSection(canCreate = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(authQueryKeys.session(), sessionSeed);
  client.setQueryData(authQueryKeys.userPermissions(), {
    ...adminPermissionsSeed,
    project: canCreate ? ["read", "create"] : ["read"],
  });
  client.setQueryData(authQueryKeys.scopedCapabilities(), []);
  return render(
    <QueryClientProvider client={client}>
      <AgentSchedulesSection agentId={AGENT_ID} agentName="Reporter" />
    </QueryClientProvider>,
  );
}

it("creates from an empty agent, reuses the created project on retry, and immediately shows the schedule", async () => {
  let projectCreates = 0,
    scheduleCreates = 0;
  server.use(
    http.post(`${origin}/api/projects`, async ({ request }) => {
      projectCreates++;
      expect(await request.json()).toMatchObject({
        name: "Reporter schedules",
        defaultAgentId: AGENT_ID,
      });
      return HttpResponse.json(
        { id: "project-new", name: "Reporter schedules" },
        { status: 201 },
      );
    }),
    http.post(`${origin}/api/schedule-triggers`, async ({ request }) => {
      scheduleCreates++;
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        name: "Morning report",
        agentId: AGENT_ID,
        projectId: "project-new",
        messageTemplate: "Prepare a report",
        enabled: true,
        cronExpression: "0 9 * * *",
      });
      if (scheduleCreates === 1)
        return HttpResponse.json(
          {
            error: {
              type: "api_internal_server_error",
              message: "Please retry",
            },
          },
          { status: 500 },
        );
      const saved = {
        ...SYNTHETIC_SCHEDULES[0],
        ...body,
        id: "schedule-new",
        lastExecutedAt: null,
      } as ScheduleTrigger;
      schedules.push(saved);
      return HttpResponse.json(saved, { status: 201 });
    }),
  );
  renderSection();
  expect(await screen.findByText("No scheduled runs yet")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
  const dialog = screen.getByRole("dialog", { name: "Create schedule" });
  const submit = within(dialog).getByRole("button", {
    name: "Create schedule",
  });
  expect(submit).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
    target: { value: "Morning report" },
  });
  expect(submit).toBeDisabled();
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Task prompt" }),
    { target: { value: "Prepare a report" } },
  );
  expect(submit).toBeEnabled();
  expect(projectCreates).toBe(0);
  fireEvent.click(submit);
  await screen.findByText("The schedule couldn’t be saved. Try again.");
  fireEvent.click(submit);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(await screen.findByText("Morning report")).toBeInTheDocument();
  expect(await screen.findByText("Never run")).toBeInTheDocument();
  expect(projectCreates).toBe(1);
  expect(scheduleCreates).toBe(2);
});

it("lets a project reader see the empty state without a create action", async () => {
  renderSection(false);
  expect(await screen.findByText("No scheduled runs yet")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Create schedule" }),
  ).not.toBeInTheDocument();
});
