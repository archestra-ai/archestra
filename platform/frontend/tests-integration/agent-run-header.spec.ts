import { expect, test } from "./fixtures";

test("keeps the session title, status, and actions readable in narrow panels", async ({
  page,
  mswControl,
  request,
}) => {
  const taskId = "12345678-abcd-4000-8000-123456789abc";
  const title =
    "Claude Code continuity demonstration with a long session title";
  const run = {
    taskId,
    sessionId: taskId,
    title,
    viewerRole: "owner",
    state: "TASK_STATE_WORKING",
    attentionState: "input_required",
    startedAt: new Date().toISOString(),
    endedAt: null,
    hardDeadlineAt: "2099-01-01T00:00:00Z",
    agent: { id: "demo-agent", name: "Coding agent", icon: null },
    workspace: null,
  };
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/agent-runs",
      body: { data: [], pagination: {} },
    },
    {
      method: "get",
      url: "/api/config",
      body: { ...config, features: { ...config.features, agentRuntime: true } },
    },
    {
      method: "get",
      url: `/api/agent-runs/${taskId}`,
      body: run,
    },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/chat/runs/${taskId}`);
  const heading = page.getByRole("heading", { name: title });
  const running = page.getByText("Running", { exact: true });
  const attention = page.getByText("Needs your input", { exact: true });
  const history = page.getByRole("button", { name: "Session history" });
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const more = page.getByRole("button", { name: "More run actions" });
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(heading).toBeVisible();
    const compact = width < 1280;
    if (compact) {
      await expect(history).toBeHidden();
      await expect(stop).toBeHidden();
    } else {
      await expect(history).toBeVisible();
      await expect(stop).toBeVisible();
    }
    // Real browser geometry catches shrinking the title to a letter or
    // allowing the non-shrinking status to paint over adjacent controls.
    await expect(async () => {
      const boxes = [];
      for (const element of [
        heading,
        running,
        attention,
        more,
        ...(compact ? [] : [history, stop]),
      ]) {
        await expect(element).toBeVisible();
        const box = await element.boundingBox();
        if (!box) throw new Error("Session header element is not rendered");
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        boxes.push(box);
      }
      expect(boxes[0].width).toBeGreaterThan(180);
      for (let i = 0; i < boxes.length; i++) {
        for (const other of boxes.slice(i + 1)) {
          const box = boxes[i];
          const overlaps =
            box.x < other.x + other.width &&
            box.x + box.width > other.x &&
            box.y < other.y + other.height &&
            box.y + box.height > other.y;
          expect(overlaps).toBe(false);
        }
      }
    }).toPass();
    if (compact) {
      await more.click();
      await expect(
        page.getByRole("menuitem", { name: "Session history" }),
      ).toBeVisible();
      await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
      await expect(
        page.getByRole("dialog", { name: "Stop this run?" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await mswControl.registerMany([
    {
      method: "get",
      url: `/api/agent-runs/${taskId}`,
      body: {
        ...run,
        state: "TASK_STATE_CANCELED",
        endedAt: new Date().toISOString(),
        attentionState: null,
        workspace: { state: "suspended", expiresAt: "2099-01-01T00:00:00Z" },
      },
    },
    {
      method: "post",
      url: `/api/agent-runs/${taskId}/continue`,
      delayMs: 1000,
      body: {
        taskId: "resumed",
        sessionId: taskId,
        state: "TASK_STATE_SUBMITTED",
      },
    },
    {
      method: "get",
      url: "/api/agent-runs/resumed",
      body: {
        ...run,
        taskId: "resumed",
        state: "TASK_STATE_SUBMITTED",
        attentionState: null,
      },
    },
  ]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeHidden();
  await more.click();
  const resumed = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(`/api/agent-runs/${taskId}/continue`),
  );
  await page.getByRole("menuitem", { name: "Resume", exact: true }).click();
  expect((await resumed).postDataJSON()).toEqual({});
  await more.click();
  await expect(
    page.getByRole("menuitem", { name: "Resuming…" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Live terminal" }),
  ).toBeVisible();
});

test("keeps mobile liveness notices on one compact row without hiding deadlines", async ({
  page,
  mswControl,
  request,
}) => {
  const taskId = "12345678-abcd-4000-8000-123456789abc";
  const now = Date.now();
  const ago = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString();
  const run = {
    taskId,
    sessionId: taskId,
    title: "Compact notice test",
    viewerRole: "owner",
    state: "TASK_STATE_WORKING",
    attentionState: null,
    startedAt: ago(3),
    lastModelActivityAt: ago(0),
    endedAt: null,
    hardDeadlineAt: ago(-96),
    agent: { id: "demo-agent", name: "Coding agent", icon: null },
    workspace: null,
  };
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
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const overrides of [
    { attentionState: "input_required" },
    { attentionState: "auth_required" },
    {},
    { lastModelActivityAt: ago(2) },
    { lastModelActivityAt: null },
    { lastModelActivityAt: ago(19) },
    { startedAt: ago(30), lastModelActivityAt: null },
    { hardDeadlineAt: ago(15) },
    { hardDeadlineAt: "invalid" },
  ]) {
    await mswControl.use({
      method: "get",
      url: `/api/agent-runs/${taskId}`,
      body: { ...run, ...overrides },
    });
    await page.goto(`/chat/runs/${taskId}`);
    const notice = page.getByRole("status").filter({
      hasText: /Hard stop|Deadline passed|Hard deadline unavailable/,
    });
    await expect(notice).toBeVisible();
    const box = await notice.boundingBox();
    if (!box) throw new Error("Liveness notice is not rendered");
    expect(box.height).toBeLessThanOrEqual(36);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(
      await notice.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
});
