import { APP_RECORDING_MAX_BUNDLE_BYTES } from "@archestra/shared";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import appRecordingRoutes from "./app-recording.routes";

describe("POST /api/app-recordings/render", () => {
  const ctx = useRouteTestApp(appRecordingRoutes);

  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    config.hackathonRecorder.enabled = true;
    config.hackathonRecorder.overrideActive = true;
  });

  test("a bundle over the size ceiling is refused from its headers, with the number and the remedy", async () => {
    // The refusal must come off Content-Length alone — before megabytes are
    // buffered — so the declared size is what's over the limit, not the body.
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-recordings/render",
      headers: {
        "content-type": "application/json",
        "content-length": String(APP_RECORDING_MAX_BUNDLE_BYTES + 1024),
      },
      body: JSON.stringify({ bundle: {}, title: "Too big" }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.message).toMatch(
      /over the 100MB limit for video export/,
    );
  });

  test("an ordinary-sized but invalid bundle still reaches validation and gets its 400", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-recordings/render",
      body: { bundle: {}, title: "Not a recording" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(
      /This recording can't be rendered/,
    );
  });
});
