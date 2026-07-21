import type { AppRecordingBundle } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { createRenderJobClient } from "./app-recording-render-client";
import {
  INTERNAL_RENDER_BASE,
  RENDER_FILENAME_HEADER,
  RENDER_USER_ID_HEADER,
} from "./app-recording-render-protocol";

/**
 * The proxy half of the render client — what the multi-replica web tier runs.
 * The render service is stubbed at the HTTP boundary so the real fetch, header
 * forwarding and error translation run: this is the link the whole dedicated-
 * renderer design rests on, and the one a route test in the default in-process
 * mode never exercises.
 */
// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper (per-test MSW server), not a React hook
const server = useMswServer();
const BASE = "http://renderer.test";
const client = createRenderJobClient(BASE);

describe("RemoteRenderJobClient", () => {
  test("forwards the authenticated user and returns the job id", async () => {
    let forwarded: string | null = null;
    server.use(
      http.post(`${BASE}${INTERNAL_RENDER_BASE}`, ({ request }) => {
        forwarded = request.headers.get(RENDER_USER_ID_HEADER);
        return HttpResponse.json({ jobId: "job-1" });
      }),
    );
    const jobId = await client.start({
      bundle: {} as unknown as AppRecordingBundle,
      userId: "user-x",
      title: "Demo",
    });
    expect(jobId).toBe("job-1");
    // Ownership is enforced at the service, so the id the web tier already
    // authenticated has to reach it.
    expect(forwarded).toBe("user-x");
  });

  test("passes a status straight through", async () => {
    server.use(
      http.get(`${BASE}${INTERNAL_RENDER_BASE}/:jobId`, () =>
        HttpResponse.json({ status: "done" }),
      ),
    );
    expect(await client.status({ jobId: "job-1", userId: "u" })).toEqual({
      status: "done",
    });
  });

  test("re-raises a service error with its status and message intact", async () => {
    server.use(
      http.get(`${BASE}${INTERNAL_RENDER_BASE}/:jobId`, () =>
        HttpResponse.json(
          { error: { message: "That video export is no longer available." } },
          { status: 404 },
        ),
      ),
    );
    // A missing job at the service must stay a 404 at the web tier — the client
    // relies on that to tell "the server lost it" from a real failure.
    await expect(
      client.status({ jobId: "gone", userId: "u" }),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining("no longer available"),
    });
  });

  test("collects the video and decodes the download name", async () => {
    server.use(
      http.get(
        `${BASE}${INTERNAL_RENDER_BASE}/:jobId/video`,
        () =>
          new HttpResponse(new Uint8Array([0, 1, 2, 3]), {
            headers: {
              "content-type": "video/mp4",
              // A name with a space and a comma — exactly what the out-of-band
              // encoded header exists to carry safely.
              [RENDER_FILENAME_HEADER]: encodeURIComponent("my demo, v2.mp4"),
            },
          }),
      ),
    );
    const { video, fileName } = await client.takeVideo({
      jobId: "job-1",
      userId: "u",
    });
    expect(fileName).toBe("my demo, v2.mp4");
    expect(video).toEqual(Buffer.from([0, 1, 2, 3]));
  });

  test("an unreachable service is a 503, not a 500", async () => {
    server.use(
      http.delete(`${BASE}${INTERNAL_RENDER_BASE}/:jobId`, () =>
        HttpResponse.error(),
      ),
    );
    // Nothing about the request is wrong — the renderer is just down — so the
    // author is asked to retry, not shown a raw internal error.
    await expect(
      client.cancel({ jobId: "job-1", userId: "u" }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
