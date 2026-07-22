import { randomUUID } from "node:crypto";
import type { AppRecordingBundle } from "@archestra/shared";
import logger from "@/logging";
import { ApiError } from "@/types";
import {
  recordingVideoFileName,
  renderRecordingVideo,
} from "./app-recording-render";

/**
 * Video exports as background jobs: start one, ask after it, collect the file.
 *
 * A render takes far longer than a request may. The author's browser will wait
 * indefinitely, but nothing between them will — a load balancer answers a
 * synchronous render with a gateway timeout well before the file exists, and
 * the render then finishes into a connection nobody is holding. So the request
 * that starts a render returns a job id immediately and the file is collected
 * on a later, short request.
 *
 * Jobs live in this process only. That is deliberate: recordings are the
 * author's, held in their browser, and a finished export is a transient
 * artifact of one request rather than something this server keeps. Nothing is
 * written to the database, and a job outlives neither its expiry nor a restart.
 * The cost is that a deployment running several replicas needs the poll to land
 * on the replica that is doing the work.
 */

/** Start rendering `bundle` in the background. Returns the job's id. */
export function startRenderJob(params: {
  bundle: AppRecordingBundle;
  userId: string;
  title: string;
  /** Serialized size of the posted bundle, when the caller knows it. */
  bundleBytes?: number;
}): string {
  sweepExpired();
  const id = randomUUID();
  const abortController = new AbortController();
  const job: RenderJob = {
    id,
    userId: params.userId,
    status: "running",
    fileName: recordingVideoFileName(params.title),
    startedAt: Date.now(),
    abortController,
  };
  jobs.set(id, job);
  // The bookend a failure is read against: what this job was chewing on —
  // above all how BIG it was — must be on record before anything can go wrong,
  // not reconstructed from a stack trace afterwards.
  logger.info(
    {
      jobId: id,
      durationMs: params.bundle.recording?.durationMs,
      bundleBytes: params.bundleBytes,
    },
    "An app recording render started",
  );

  // Deliberately not awaited: the caller answers with the id straight away.
  // `renderRecordingVideo` owns the concurrency slot and releases it however
  // this settles, so a rejection here cannot strand one.
  void renderRecordingVideo({
    bundle: params.bundle,
    userId: params.userId,
    abortSignal: abortController.signal,
  })
    .then((video) => {
      // A job cancelled mid-render still resolves if the render happened to
      // finish first; the author asked for it to go, so it goes.
      if (job.status !== "running") return;
      job.status = "done";
      job.video = video;
      job.finishedAt = Date.now();
    })
    .catch((error: unknown) => {
      if (job.status !== "running") return;
      job.status = "failed";
      job.finishedAt = Date.now();
      // An ApiError is already phrased for the author. Anything else is an
      // internal fault whose text would mean nothing to them — but it still has
      // to reach the toast as something other than silence, so it is named.
      job.error =
        error instanceof ApiError
          ? error.message
          : "Your video could not be prepared. The renderer stopped unexpectedly.";
      logger.error(
        {
          err: error,
          jobId: id,
          elapsedMs: Date.now() - job.startedAt,
          durationMs: params.bundle.recording?.durationMs,
          bundleBytes: params.bundleBytes,
          // What the author was actually told — the generic line above never
          // names the internal fault, so the log must tie the two together.
          reportedAs: job.error,
        },
        "An app recording render failed",
      );
    });

  return id;
}

/** How a job is going, for the author who started it. */
export function renderJobStatus(params: { jobId: string; userId: string }): {
  status: RenderJob["status"];
  error?: string;
} {
  const job = ownedJob(params);
  return job.error
    ? { status: job.status, error: job.error }
    : { status: job.status };
}

/**
 * Take the finished video, which also ends the job.
 *
 * Collecting is a move rather than a read: the file has reached the author, and
 * holding megabytes of it against a second request that will not come is how a
 * process that renders all day runs out of memory.
 */
export function takeRenderedVideo(params: { jobId: string; userId: string }): {
  video: Buffer;
  fileName: string;
} {
  const job = ownedJob(params);
  if (job.status === "running") {
    throw new ApiError(409, "This video is still being prepared.");
  }
  if (job.status === "failed" || !job.video) {
    jobs.delete(job.id);
    throw new ApiError(500, job.error ?? "The video could not be rendered.");
  }
  const video = job.video;
  jobs.delete(job.id);
  return { video, fileName: job.fileName };
}

/** Stop a running job and drop it. Cancelling a finished one just drops it. */
export function cancelRenderJob(params: {
  jobId: string;
  userId: string;
}): void {
  const job = ownedJob(params);
  job.status = "cancelled";
  job.abortController.abort();
  jobs.delete(job.id);
}

// =============================================================================
// Internal helpers
// =============================================================================

type RenderJob = {
  id: string;
  userId: string;
  status: "running" | "done" | "failed" | "cancelled";
  video?: Buffer;
  error?: string;
  fileName: string;
  startedAt: number;
  finishedAt?: number;
  abortController: AbortController;
};

const jobs = new Map<string, RenderJob>();

/**
 * How long a finished video waits to be collected, and the ceiling on a running
 * job's lifetime — a render that has somehow neither finished nor failed by
 * then is abandoned rather than left holding memory and a concurrency slot.
 */
const JOB_TTL_MS = 10 * 60 * 1000;

/**
 * The job, if it is this person's.
 *
 * A job id is a bearer token for a video of somebody's session, so ownership is
 * checked on every touch — and an id belonging to someone else is reported as
 * missing rather than forbidden, which would confirm it exists.
 */
function ownedJob(params: { jobId: string; userId: string }): RenderJob {
  sweepExpired();
  const job = jobs.get(params.jobId);
  if (!job || job.userId !== params.userId) {
    throw new ApiError(
      404,
      "That video export is no longer available. Jobs are held in memory, so a restart or a long wait ends them.",
    );
  }
  return job;
}

function sweepExpired(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    // Timed from when the job SETTLED, not when it started: a long render is
    // already minutes old the moment its video exists, and timing the wait to
    // collect from the start would leave the author whatever was left over —
    // or nothing at all, collecting a video that expired before it was offered.
    if ((job.finishedAt ?? job.startedAt) > cutoff) continue;
    // Aborting a job that already settled is a no-op; one still running is
    // stopped so it stops paying for itself.
    job.abortController.abort();
    jobs.delete(id);
  }
}
