import { expect, test } from "./fixtures";

test("keeps the session title, status, and actions readable in narrow panels", async ({
  page,
  mswControl,
  request,
}) => {
  const taskId = "12345678-abcd-4000-8000-123456789abc";
  const title =
    "Claude Code continuity demonstration with a long session title";
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
      body: {
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
      },
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
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(heading).toBeVisible();
    // Real browser geometry catches shrinking the title to a letter or
    // allowing the non-shrinking status to paint over adjacent controls.
    await expect(async () => {
      const boxes = [];
      for (const element of [
        heading,
        running,
        attention,
        history,
        stop,
        more,
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
  }
});
