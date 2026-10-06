import { expect, test } from "./fixtures";

test("the run owner reviews the exact offer and posts only its decision", async ({
  page,
  mswControl,
  request,
}) => {
  const taskId = "12345678-abcd-4000-8000-123456789abc";
  const offerId = "synthetic-exact-review-offer";
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/config",
      body: { ...config, features: { ...config.features, agentRuntime: true } },
    },
    {
      method: "get",
      url: "/api/agent-runs",
      body: { data: [], pagination: {} },
    },
    { method: "get", url: `/api/agent-runs/${taskId}`, body: run(taskId) },
    {
      method: "get",
      url: `/api/agent-runs/${taskId}/openappa-review`,
      body: {
        status: "pending",
        canDecide: true,
        offerId,
        text: "Review the exact QA action",
        tool: "mcp/example/write",
        arguments: '{"path":"qa.txt"}',
      },
    },
    {
      method: "post",
      url: `/api/agent-runs/${taskId}/openappa-review`,
      body: { decision: "approve", offerId, steered: true },
    },
  ]);
  await page.goto(`/chat/runs/${taskId}`);
  await expect(page.getByText("Review the exact QA action")).toBeVisible();
  await expect(page.getByText("mcp/example/write")).toBeVisible();
  const posted = page.waitForRequest(
    (call) =>
      call.method() === "POST" &&
      call.url().endsWith(`/api/agent-runs/${taskId}/openappa-review`),
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  expect((await posted).postDataJSON()).toEqual({
    decision: "approve",
    offerId,
  });
  await mswControl.use({
    method: "get",
    url: `/api/agent-runs/${taskId}/openappa-review`,
    body: {
      status: "none",
      canDecide: false,
      offerId: null,
      text: null,
      tool: null,
      arguments: null,
    },
  });
  await expect(
    page.getByRole("button", { name: "Approve", exact: true }),
  ).toBeHidden();
});

test("a reader without review authority sees status but not private offer details or controls", async ({
  page,
  mswControl,
  request,
}) => {
  const taskId = "12345678-abcd-4000-8000-123456789abc";
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/config",
      body: { ...config, features: { ...config.features, agentRuntime: true } },
    },
    {
      method: "get",
      url: "/api/agent-runs",
      body: { data: [], pagination: {} },
    },
    { method: "get", url: `/api/agent-runs/${taskId}`, body: run(taskId) },
    {
      method: "get",
      url: `/api/agent-runs/${taskId}/openappa-review`,
      body: {
        status: "pending",
        canDecide: false,
        offerId: null,
        text: "Private QA review detail",
        tool: "private-qa-tool",
        arguments: "private-qa-arguments",
      },
    },
  ]);
  await page.goto(`/chat/runs/${taskId}`);
  await expect(
    page.getByText(
      "This run is waiting for its owner to approve or deny a blocked action.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Private QA review detail")).toBeHidden();
  await expect(page.getByText("private-qa-tool")).toBeHidden();
  await expect(page.getByText("private-qa-arguments")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Approve", exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Deny", exact: true }),
  ).toBeHidden();
});

function run(taskId: string) {
  return {
    taskId,
    sessionId: taskId,
    title: "QA runtime review",
    viewerRole: "owner",
    state: "TASK_STATE_WORKING",
    attentionState: "input_required",
    startedAt: new Date().toISOString(),
    endedAt: null,
    hardDeadlineAt: "2099-01-01T00:00:00Z",
    agent: { id: "qa-agent", name: "QA agent", icon: null },
    workspace: null,
  };
}
