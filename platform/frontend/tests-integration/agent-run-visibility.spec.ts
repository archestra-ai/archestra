import type { archestraApiTypes } from "@archestra/shared";
import { makeAgent } from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";

test("keeps a long run owner and the access details inside the phone viewport", async ({
  page,
  mswControl,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
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
  const ownerName = "Samuel Chen — Release Engineering and Product Operations";
  const run = {
    id: "run-1",
    taskId: "12345678-abcd-4000-8000-123456789abc",
    agentId: agent.id,
    organizationId: "test-org",
    actorKind: "user",
    actorId: "other-user",
    actorUserId: "other-user",
    title: "Release review",
    pinnedAt: null,
    projectId: null,
    workloadName: "release-review",
    backend: "kubernetes",
    runtimeScope: "test",
    virtualApiKeyId: null,
    gatewayTokenId: null,
    startedAt: "2026-09-01T12:00:00.000Z",
    endedAt: "2026-09-01T12:01:00.000Z",
    hardDeadlineAt: "2026-09-01T13:00:00.000Z",
    lastModelActivityAt: null,
    attentionState: null,
    state: "TASK_STATE_COMPLETED",
    statusReason: null,
    failure: null,
    stateChangedAt: "2026-09-01T12:01:00.000Z",
    initiatorName: ownerName,
    shareVisibility: "team",
    shareTeamNames: ["Release reviewers"],
    shareUserNames: [],
  } satisfies archestraApiTypes.GetAgentRunsResponses["200"][number];
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  await mswControl.use({
    method: "get",
    url: "/api/config",
    body: { ...config, features: { ...config.features, agentRuntime: true } },
  });
  await mswControl.use({
    method: "get",
    url: `/api/agents/${agent.id}`,
    body: agent,
  });
  await mswControl.use({
    method: "get",
    url: `/api/agents/${agent.id}/runtime/preflight`,
    body: {
      ready: true,
      configured: [],
      missing: [],
      misconfigured: [],
      incompatible: null,
    } satisfies archestraApiTypes.GetAgentRuntimePreflightResponses["200"],
  });
  await mswControl.use({
    method: "get",
    url: `/api/agents/${agent.id}/runs`,
    body: [run],
  });
  await page.goto(`/agents/${agent.id}?section=runs`);
  const owner = page.getByText(`by ${ownerName}`, { exact: true });
  // Access comes from the run's permission policy, explained behind this
  // button, rather than from a sharing label.
  const access = page.getByRole("button", { name: "Who can access this run?" });
  await expect(owner).toBeVisible();
  await expect(access).toBeVisible();
  await owner.scrollIntoViewIfNeeded();
  for (const element of [owner, access]) {
    const bounds = await element.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) throw new Error("Run metadata is not rendered");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  }

  const fullView = page.getByRole("link", { name: "Open full view" });
  await expect(fullView).toHaveAttribute("href", `/chat/runs/${run.taskId}`);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toHaveCount(0);

  const ownRun = {
    ...run,
    actorId: "test-user-admin",
    actorUserId: "test-user-admin",
    endedAt: null,
    state: "TASK_STATE_WORKING",
  };
  await mswControl.registerMany([
    { method: "get", url: `/api/agents/${agent.id}/runs`, body: [ownRun] },
    {
      method: "get",
      url: "/api/agent-runs",
      body: { data: [], pagination: {} },
    },
    {
      method: "get",
      url: `/api/agent-runs/${run.taskId}`,
      body: {
        ...ownRun,
        sessionId: run.taskId,
        viewerRole: "owner",
        workspace: null,
        agent: { id: agent.id, name: agent.name, icon: null },
      },
    },
  ]);
  await page.reload();
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const control of [
      fullView,
      stop,
      page.getByRole("button", { name: "More run actions", exact: true }),
    ]) {
      await expect(control).toBeVisible();
      await control.scrollIntoViewIfNeeded();
      const bounds = await control.boundingBox();
      if (!bounds) throw new Error("Run control is not rendered");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
  }
  await stop.click();
  await expect(
    page.getByRole("dialog", { name: "Stop this run?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await fullView.click();
  await expect(page).toHaveURL(`/chat/runs/${run.taskId}`);
  await expect(
    page.getByRole("heading", { name: "Live terminal", exact: true }),
  ).toBeVisible();
});
