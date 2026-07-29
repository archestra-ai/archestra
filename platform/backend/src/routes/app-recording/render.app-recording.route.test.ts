import {
  APP_RECORDING_MAX_BUNDLE_BYTES,
  APPS_HACKATHON_OPENS_AT_MS,
} from "@archestra/shared";
import config from "@/config";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import appRecordingRoutes from "./app-recording.routes";

describe("POST /api/app-recordings/render", () => {
  const ctx = useRouteTestApp(appRecordingRoutes);

  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    config.hackathonRecorder.enabled = true;
    // The date gate reads the wall clock and has no bypass, so pin the clock
    // inside the hackathon window.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(APPS_HACKATHON_OPENS_AT_MS);
    // The video export is its own opt-in on top of the recorder, so every
    // render test has to turn it on the way a deployment would.
    config.hackathonRecorder.videoDownloadEnabled = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("403s when the deployment does not offer video download", async () => {
    // Hiding the button is presentation; this is the check. An endpoint that
    // still answered would let anyone spend a headless-browser render by
    // calling it directly, on a deployment that never opted in.
    config.hackathonRecorder.videoDownloadEnabled = false;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/app-recordings/render",
      body: { bundle: {}, title: "Nope" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/not available/i);
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
