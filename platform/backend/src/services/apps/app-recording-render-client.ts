import type { AppRecordingBundle } from "@archestra/shared";
import config from "@/config";
import logger from "@/logging";
import { ApiError } from "@/types";
import {
  cancelRenderJob,
  renderJobStatus,
  startRenderJob,
  takeRenderedVideo,
} from "./app-recording-render-jobs";
import {
  INTERNAL_RENDER_BASE,
  RENDER_FILENAME_HEADER,
  RENDER_USER_ID_HEADER,
} from "./app-recording-render-protocol";

/**
 * The four render operations the app-recording routes drive — start, ask after,
 * collect, cancel — behind one interface with two implementations.
 *
 * In-process: they run in THIS process's own in-memory job store. That is the
 * OSS single container and local dev, where one process both serves the API and
 * renders, so a render's follow-up requests always come back to the process
 * that started it.
 *
 * Remote: they are proxied to a dedicated single-replica render service (see
 * startRenderer). A multi-replica web tier cannot render in-process — jobs live
 * in one process's memory, so the poll and the download would scatter across
 * pods that never held the job — so it offloads to the one pod that does.
 *
 * Which implementation is used is a deployment fact — whether a render service
 * URL is configured — decided once, at boot (see the export at the bottom).
 */

interface RenderJobProgress {
  status: "running" | "done" | "failed" | "cancelled";
  error?: string;
}

interface RenderJobClient {
  /** Start a render for `userId`. Resolves to the job's id. */
  start(params: {
    bundle: AppRecordingBundle;
    userId: string;
    title: string;
  }): Promise<string>;
  status(params: { jobId: string; userId: string }): Promise<RenderJobProgress>;
  takeVideo(params: {
    jobId: string;
    userId: string;
  }): Promise<{ video: Buffer; fileName: string }>;
  cancel(params: { jobId: string; userId: string }): Promise<void>;
}

/** The one process both serves the API and renders — jobs are its own memory. */
class InProcessRenderJobClient implements RenderJobClient {
  async start(params: {
    bundle: AppRecordingBundle;
    userId: string;
    title: string;
  }): Promise<string> {
    return startRenderJob(params);
  }
  async status(params: {
    jobId: string;
    userId: string;
  }): Promise<RenderJobProgress> {
    return renderJobStatus(params);
  }
  async takeVideo(params: {
    jobId: string;
    userId: string;
  }): Promise<{ video: Buffer; fileName: string }> {
    return takeRenderedVideo(params);
  }
  async cancel(params: { jobId: string; userId: string }): Promise<void> {
    cancelRenderJob(params);
  }
}

/** Proxy each operation to the dedicated single-replica render service. */
class RemoteRenderJobClient implements RenderJobClient {
  constructor(private readonly baseUrl: string) {}

  async start(params: {
    bundle: AppRecordingBundle;
    userId: string;
    title: string;
  }): Promise<string> {
    const res = await this.call({
      method: "POST",
      path: INTERNAL_RENDER_BASE,
      userId: params.userId,
      body: JSON.stringify({ bundle: params.bundle, title: params.title }),
    });
    const { jobId } = (await res.json()) as { jobId: string };
    return jobId;
  }

  async status(params: {
    jobId: string;
    userId: string;
  }): Promise<RenderJobProgress> {
    const res = await this.call({
      method: "GET",
      path: `${INTERNAL_RENDER_BASE}/${encodeURIComponent(params.jobId)}`,
      userId: params.userId,
    });
    return (await res.json()) as RenderJobProgress;
  }

  async takeVideo(params: {
    jobId: string;
    userId: string;
  }): Promise<{ video: Buffer; fileName: string }> {
    const res = await this.call({
      method: "GET",
      path: `${INTERNAL_RENDER_BASE}/${encodeURIComponent(params.jobId)}/video`,
      userId: params.userId,
    });
    const video = Buffer.from(await res.arrayBuffer());
    // The service hands the download name back out-of-band, url-encoded, so a
    // title with a comma or a quote survives the header intact.
    const encoded = res.headers.get(RENDER_FILENAME_HEADER);
    const fileName = encoded ? decodeURIComponent(encoded) : "app-session.mp4";
    return { video, fileName };
  }

  async cancel(params: { jobId: string; userId: string }): Promise<void> {
    await this.call({
      method: "DELETE",
      path: `${INTERNAL_RENDER_BASE}/${encodeURIComponent(params.jobId)}`,
      userId: params.userId,
    });
  }

  private async call(params: {
    method: string;
    path: string;
    userId: string;
    body?: string;
  }): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${params.path}`, {
        method: params.method,
        // Every one of these operations is fast — start hands back a job id and
        // returns, the render runs in the background, status/download/cancel
        // read memory — so a bound this far above a normal response only ever
        // trips on a service whose event loop is wedged. Without it a hung
        // render pod would hang the web request behind it indefinitely.
        signal: AbortSignal.timeout(RENDER_SERVICE_REQUEST_TIMEOUT_MS),
        headers: {
          // Names this traffic at the render service, so its access logs can
          // tell the web tier's proxied requests from anything else internal.
          "user-agent": RENDER_PROXY_USER_AGENT,
          // Ownership of a render is enforced at the service — a job id is a
          // bearer token for someone's video — so the id the web tier already
          // authenticated is forwarded rather than trusted from the client.
          [RENDER_USER_ID_HEADER]: params.userId,
          ...(params.body ? { "content-type": "application/json" } : {}),
        },
        body: params.body,
      });
    } catch (error) {
      // The service is unreachable — a pod restart, a network blip. Nothing
      // about the request is wrong, so it is a 503, not a 500.
      logger.error(
        { err: error, method: params.method, path: params.path },
        "App recording render service is unreachable",
      );
      throw new ApiError(
        503,
        "The video renderer is temporarily unavailable. Try the download again in a moment.",
      );
    }
    if (!res.ok) throw await remoteApiError(res);
    return res;
  }
}

/** Backstop ceiling on one proxied call — see the note at the fetch. */
const RENDER_SERVICE_REQUEST_TIMEOUT_MS = 120_000;

/** Identifies web-tier proxy traffic in the render service's access logs. */
const RENDER_PROXY_USER_AGENT = "archestra-web-proxy";

/**
 * Re-raise a render-service error as the caller's own. The service formats
 * errors exactly as the main API does, so an ApiError raised there arrives as
 * `{ error: { message } }` and is thrown here with its status intact — a
 * missing job stays a 404, a stall a 504, a broken recording a 400.
 */
async function remoteApiError(res: Response): Promise<ApiError> {
  let message = "The video could not be rendered.";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) message = body.error.message;
  } catch {
    // Non-JSON body; the generic message stands.
  }
  return new ApiError(res.status, message);
}

/**
 * Build the render client for a deployment: a proxy to the render service when
 * a URL is configured, in-process otherwise. Exported so a test can exercise
 * the proxy without this process's own config naming a service.
 *
 * @public — used by the singleton below and by the client's own tests.
 */
export function createRenderJobClient(
  rendererUrl: string | undefined,
): RenderJobClient {
  return rendererUrl
    ? new RemoteRenderJobClient(rendererUrl)
    : new InProcessRenderJobClient();
}

/**
 * @public — the app-recording routes' single entry to rendering. In-process
 * unless a render service URL is configured, then a proxy to that service.
 */
export const renderJobClient = createRenderJobClient(
  config.hackathonRecorder.rendererUrl,
);
