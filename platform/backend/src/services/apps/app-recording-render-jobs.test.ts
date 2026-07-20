import type { AppRecordingBundle } from "@archestra/shared";
import { beforeEach, vi } from "vitest";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { admitRender } from "./app-recording-render";
import {
  cancelRenderJob,
  renderJobStatus,
  startRenderJob,
  takeRenderedVideo,
} from "./app-recording-render-jobs";

vi.mock("./app-recording-render", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./app-recording-render")>();
  return { ...actual, renderRecordingVideo: vi.fn() };
});
const { renderRecordingVideo } = await import("./app-recording-render");

/** A bundle stands in for a recording here; only its identity matters. */
const bundle = {} as AppRecordingBundle;
const start = (userId: string) =>
  startRenderJob({ bundle, userId, title: "PR Dashboard" });
/** Let the job's own promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.mocked(renderRecordingVideo).mockReset();
});

describe("render jobs", () => {
  test("hands over the finished video once, then forgets it", async () => {
    vi.mocked(renderRecordingVideo).mockResolvedValue(Buffer.from("mp4"));
    const jobId = start("user-1");
    await settle();

    expect(renderJobStatus({ jobId, userId: "user-1" })).toEqual({
      status: "done",
    });
    const { video, fileName } = takeRenderedVideo({ jobId, userId: "user-1" });
    expect(video.toString()).toBe("mp4");
    expect(fileName).toBe("pr-dashboard-session.mp4");
    // Holding megabytes against a second collection that never comes is how a
    // long-lived process runs out of memory.
    expect(() => takeRenderedVideo({ jobId, userId: "user-1" })).toThrow(
      /no longer available/,
    );
  });

  test("reports a failed render instead of a video", async () => {
    vi.mocked(renderRecordingVideo).mockRejectedValue(
      new Error("browser died"),
    );
    const jobId = start("user-2");
    await settle();

    expect(renderJobStatus({ jobId, userId: "user-2" }).status).toBe("failed");
    expect(() => takeRenderedVideo({ jobId, userId: "user-2" })).toThrow();
  });

  test("a failed render carries a reason the author can be shown", async () => {
    vi.mocked(renderRecordingVideo).mockRejectedValue(
      new ApiError(400, "This cut runs 44s. Trim it to 30 seconds or less."),
    );
    const jobId = start("user-2b");
    await settle();

    // Without this the client has nothing to put on screen and the toast that
    // promised a download just sits there, which reads as a render still
    // running rather than one that already failed.
    const status = renderJobStatus({ jobId, userId: "user-2b" });
    expect(status.status).toBe("failed");
    expect(status.error).toMatch(/Trim it to 30 seconds/);
  });

  test("an internal fault still reaches the author as something sayable", async () => {
    vi.mocked(renderRecordingVideo).mockRejectedValue(
      new Error("page.evaluate: Execution context was destroyed"),
    );
    const jobId = start("user-2c");
    await settle();

    // The internal text means nothing to an author, but silence means less.
    const status = renderJobStatus({ jobId, userId: "user-2c" });
    expect(status.error).toBe(
      "Your video could not be prepared. The renderer stopped unexpectedly.",
    );
    expect(status.error).not.toMatch(/page\.evaluate/);
  });

  test("a job lost to a restart says why it is gone", () => {
    // Jobs live in memory, so a deploy takes every in-flight render with it.
    // A bare "not found" leaves the author with no idea what to do next.
    expect(() =>
      renderJobStatus({
        jobId: "6a7a44dd-0000-0000-0000-000000000000",
        userId: "u",
      }),
    ).toThrow(/held in memory, so a restart/);
  });

  test("refuses to hand a job to anyone but the person who started it", async () => {
    vi.mocked(renderRecordingVideo).mockResolvedValue(Buffer.from("mp4"));
    const jobId = start("user-3");
    await settle();

    // Reported as missing rather than forbidden: a job id is a bearer token for
    // a video of somebody's session, and 403 would confirm it exists.
    expect(() => renderJobStatus({ jobId, userId: "someone-else" })).toThrow(
      /no longer available/,
    );
    expect(() => takeRenderedVideo({ jobId, userId: "someone-else" })).toThrow(
      /no longer available/,
    );
    expect(() => cancelRenderJob({ jobId, userId: "someone-else" })).toThrow(
      /no longer available/,
    );
  });

  test("cancelling aborts the render and drops the job", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(renderRecordingVideo).mockImplementation(
      (params) =>
        new Promise((_resolve, reject) => {
          signal = params.abortSignal;
          params.abortSignal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const jobId = start("user-4");
    expect(renderJobStatus({ jobId, userId: "user-4" }).status).toBe("running");

    cancelRenderJob({ jobId, userId: "user-4" });
    await settle();

    // The render has to be told, or it keeps a browser and the author's one
    // concurrency slot for the rest of its natural life.
    expect(signal?.aborted).toBe(true);
    expect(() => renderJobStatus({ jobId, userId: "user-4" })).toThrow(
      /no longer available/,
    );
  });

  test("a cancelled render frees the slot it held", async () => {
    // The concurrency slot lives in renderRecordingVideo, which the real
    // implementation releases however it settles. Stand in for a render that
    // takes a slot and then loses its race with a cancel.
    vi.mocked(renderRecordingVideo).mockImplementation(async (params) => {
      const release = admitRender(params.userId);
      try {
        return await new Promise<Buffer>((_resolve, reject) => {
          params.abortSignal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      } finally {
        release();
      }
    });

    const jobId = start("user-5");
    await settle();
    // The slot is taken while it runs.
    expect(() => admitRender("user-5")).toThrow(/already being prepared/);

    cancelRenderJob({ jobId, userId: "user-5" });
    await settle();

    // And handed back on cancel — otherwise the next export is refused with
    // "a video is already being prepared" and the author is locked out.
    admitRender("user-5")();
  });
});
