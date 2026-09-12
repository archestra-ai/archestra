import type { archestraApiTypes } from "@archestra/shared";
import { makeAgent } from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";

test("keeps a long run owner and sharing scope inside the phone viewport", async ({
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
    startedAt: "2026-09-01T12:00:00.000Z",
    endedAt: "2026-09-01T12:01:00.000Z",
    hardDeadlineAt: "2026-09-01T13:00:00.000Z",
    lastModelActivityAt: null,
    attentionState: null,
    state: "TASK_STATE_COMPLETED",
    statusReason: null,
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
    url: `/api/agents/${agent.id}/runs`,
    body: [run],
  });
  await page.goto(`/agents/${agent.id}?section=runs`);
  const owner = page.getByText(`Started by ${ownerName}`, { exact: true });
  const sharing = page.getByLabel("Team: Release reviewers", { exact: true });
  await expect(owner).toBeVisible();
  await expect(sharing).toBeVisible();
  await owner.scrollIntoViewIfNeeded();
  for (const element of [owner, sharing]) {
    const bounds = await element.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) throw new Error("Run metadata is not rendered");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  }
});
