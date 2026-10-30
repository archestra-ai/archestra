import type { archestraApiTypes } from "@archestra/shared";
import type { APIRequestContext, Page } from "@playwright/test";
import { makeAgent } from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";
import type { MswControl } from "./helpers/msw-control";

type AgentRunListItem = archestraApiTypes.GetAgentRunsResponses["200"][number];

const agent = makeAgent({
  runtime: {
    image: "example.com/runtime:1",
    command: null,
    inferenceProtocol: "anthropic",
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: null,
    idleTimeoutMinutes: null,
  },
});

// The signed-in test user starts three of these; a colleague starts the last.
const runs = [
  makeRun({
    taskId: "00000000-0000-4000-8000-000000000001",
    title: "Review pull request 9893: Enterprise Managed Users lookup",
    endedAt: null,
    state: "TASK_STATE_WORKING",
  }),
  makeRun({
    taskId: "00000000-0000-4000-8000-000000000002",
    title: "Nightly dependency audit",
    state: "TASK_STATE_FAILED",
    statusReason: "The runtime image could not be pulled",
    workspace: { state: "suspended", expiresAt: "2026-11-01T12:00:00.000Z" },
  }),
  makeRun({
    taskId: "00000000-0000-4000-8000-000000000003",
    title: "Release notes draft",
    workspace: { state: "suspended", expiresAt: "2026-11-01T12:00:00.000Z" },
  }),
  makeRun({
    taskId: "00000000-0000-4000-8000-000000000004",
    title: "Colleague's migration check",
    actorId: "colleague",
    actorUserId: "colleague",
    initiatorName: "Priya Raman",
  }),
];

test("lists an Agent's runs and opens one from its row", async ({
  page,
  mswControl,
  request,
}) => {
  await mockRuns({ mswControl, request });
  await page.goto(`/agents/${agent.id}?section=runs`);
  const table = page.getByRole("table");
  await expect(
    table.getByRole("link", { name: runs[0].title, exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(table.getByText("Priya Raman", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: `Select ${runs[3].title}` }),
  ).toBeDisabled();

  await table.getByText(runs[2].title, { exact: true }).click();
  await expect(page).toHaveURL(
    `/agents/${agent.id}?section=runs&run=${runs[2].taskId}`,
  );
  await expect(
    page.getByRole("heading", { name: runs[2].title, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "All runs", exact: true }).click();
  await expect(page).toHaveURL(`/agents/${agent.id}?section=runs`);
  await expect(table.getByRole("link", { name: runs[2].title })).toBeVisible();
});

test("keeps the runs list and its bulk actions inside a phone viewport", async ({
  page,
  mswControl,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRuns({ mswControl, request });
  await page.goto(`/agents/${agent.id}?section=runs`);
  const title = page.getByRole("link", { name: runs[0].title, exact: true });
  await expect(title).toBeVisible({ timeout: 60_000 });
  await page
    .getByRole("checkbox", { name: "Select all runs on this page" })
    .click();
  // Three actions fold into one menu on a phone.
  const menu = page.getByRole("button", { name: "Actions", exact: true });
  for (const control of [title, menu]) {
    await expect(control).toBeVisible();
    await expectInsideViewport(control, 390);
  }
  await menu.click();
  for (const name of ["Stop 1", "Delete saved files 2", "Delete 2"]) {
    const item = page.getByRole("menuitem", { name, exact: true });
    await expect(item).toBeVisible();
    await expectInsideViewport(item, 390);
  }
});

test("deletes only the viewer's finished runs in one request", async ({
  page,
  mswControl,
  request,
}) => {
  await mockRuns({ mswControl, request });
  await mswControl.use({
    method: "delete",
    url: "/api/agent-runs/bulk",
    body: {
      succeeded: [runs[1], runs[2]].map((run) => ({
        id: run.taskId,
        name: run.title,
      })),
      failed: [],
    },
  });
  await page.goto(`/agents/${agent.id}?section=runs`);
  await expect(
    page.getByRole("link", { name: runs[0].title, exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await page
    .getByRole("checkbox", { name: "Select all runs on this page" })
    .click();
  await page.getByRole("button", { name: "Delete 2", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete 2 runs?" });
  await expect(
    dialog.getByText(/The run that is still running is not deleted/),
  ).toBeVisible();
  const sent = page.waitForRequest(
    (sentRequest) =>
      sentRequest.method() === "DELETE" &&
      sentRequest.url().endsWith("/api/agent-runs/bulk"),
  );
  await dialog
    .getByRole("button", { name: "Delete runs", exact: true })
    .click();
  expect((await sent).postDataJSON()).toEqual({
    ids: [runs[1].taskId, runs[2].taskId],
  });
  await expect(dialog).toHaveCount(0);
});

async function mockRuns({
  mswControl,
  request,
}: {
  mswControl: MswControl;
  request: APIRequestContext;
}) {
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/config",
      body: { ...config, features: { ...config.features, agentRuntime: true } },
    },
    { method: "get", url: `/api/agents/${agent.id}`, body: agent },
    {
      method: "get",
      url: `/api/agents/${agent.id}/runtime/preflight`,
      body: {
        ready: true,
        configured: [],
        missing: [],
        misconfigured: [],
        incompatible: null,
      } satisfies archestraApiTypes.GetAgentRuntimePreflightResponses["200"],
    },
    { method: "get", url: `/api/agents/${agent.id}/runs`, body: runs },
    {
      method: "get",
      url: "/api/agent-runs",
      body: { data: [], pagination: {} },
    },
    ...runs.map((run) => ({
      method: "get" as const,
      url: `/api/agent-runs/${run.taskId}`,
      body: {
        ...run,
        sessionId: run.taskId,
        viewerRole: run.actorUserId === "colleague" ? "shared" : "owner",
        workspace: null,
        agent: { id: agent.id, name: agent.name, icon: null },
      },
    })),
  ]);
}

async function expectInsideViewport(
  control: ReturnType<Page["getByRole"]>,
  width: number,
) {
  await control.scrollIntoViewIfNeeded();
  const bounds = await control.boundingBox();
  if (!bounds) throw new Error("Control is not rendered");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
}

function makeRun(overrides: Partial<AgentRunListItem>): AgentRunListItem {
  return {
    id: overrides.taskId ?? "run",
    taskId: "00000000-0000-4000-8000-000000000000",
    agentId: agent.id,
    organizationId: "test-org",
    actorKind: "user",
    actorId: "test-user-admin",
    actorUserId: "test-user-admin",
    title: "Run",
    pinnedAt: null,
    projectId: null,
    workloadName: "agent-run",
    backend: "kubernetes",
    runtimeScope: "test",
    virtualApiKeyId: null,
    gatewayTokenId: null,
    startedAt: "2026-10-29T12:00:00.000Z",
    endedAt: "2026-10-29T12:20:00.000Z",
    hardDeadlineAt: "2026-10-30T12:00:00.000Z",
    lastModelActivityAt: "2026-10-29T12:19:00.000Z",
    attentionState: null,
    state: "TASK_STATE_COMPLETED",
    statusReason: null,
    failure: null,
    stateChangedAt: "2026-10-29T12:20:00.000Z",
    initiatorName: "Admin User",
    workspace: null,
    shareVisibility: null,
    shareTeamNames: null,
    shareUserNames: null,
    ...overrides,
  };
}
