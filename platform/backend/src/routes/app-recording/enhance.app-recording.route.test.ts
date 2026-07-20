import { randomUUID } from "node:crypto";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import appRecordingRoutes from "./app-recording.routes";

describe("POST /api/app-recordings/enhance", () => {
  const ctx = useRouteTestApp(appRecordingRoutes);

  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    config.hackathonRecorder.enabled = true;
  });

  test("403s when the hackathon recorder is disabled on the deployment", async () => {
    config.hackathonRecorder.enabled = false;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-recordings/enhance",
      payload: { conversationId: randomUUID(), appName: "Demo App" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "The hackathon recorder is disabled",
    );
  });

  test("404s for a conversation the caller does not own", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-recordings/enhance",
      payload: { conversationId: randomUUID(), appName: "Demo App" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("Conversation not found");
  });
});
