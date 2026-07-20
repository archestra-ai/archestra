import {
  APP_RECORDING_MAX_EXPORT_MS,
  APP_RECORDING_RENDER_FPS,
  APP_RECORDING_RENDER_REGION_SELECTOR,
  APP_RECORDING_RENDER_ROUTE,
  type AppRecordingBundle,
} from "@archestra/shared";
import config from "@/config";
import logger from "@/logging";
import { ApiError } from "@/types";
import { ensureRenderRuntime } from "./app-recording-render-runtime";

/**
 * Render a recorded app session to an MP4, offline and frame-exact.
 *
 * The replayed app lives in a nested sandboxed iframe on an opaque origin, so
 * no page script can ever read its pixels — which rules out rasterizing the
 * DOM from the host. This renders through the COMPOSITOR instead: a real
 * Chromium loads the ordinary replay page and every frame is a screenshot
 * cropped to the two viewports. What the compositor draws is what lands in the
 * file, including the sandboxed app, its WebGL canvases and its blend modes,
 * with the isolation completely untouched.
 *
 * Frames are stepped, never sampled. Wall-clock time drives nothing: playback
 * is seeked to an exact millisecond and animations are scrubbed to the same
 * instant before each capture, so the same bundle renders the same frames on
 * any machine at any speed — and rendering runs faster or slower than realtime
 * without changing the result. Sampling a live replay on a timer produces
 * judder and is not reproducible.
 *
 * Encoding happens inside that same browser (WebCodecs H.264), so no ffmpeg or
 * any other binary is needed beyond the browser itself.
 */
export async function renderRecordingVideo(params: {
  bundle: AppRecordingBundle;
  /** Whose render this is — one at a time, per person. */
  userId: string;
  /** Frames per second of the output. */
  fps?: number;
  abortSignal?: AbortSignal;
}): Promise<Buffer> {
  const release = admitRender(params.userId);
  try {
    return await render(params);
  } finally {
    release();
  }
}

async function render(params: {
  bundle: AppRecordingBundle;
  fps?: number;
  abortSignal?: AbortSignal;
}): Promise<Buffer> {
  const fps = params.fps ?? APP_RECORDING_RENDER_FPS;
  // Cancellation is checked at every step that can block, not only per frame:
  // launching a browser and waiting for the replay page to hydrate take seconds
  // (a first-ever render installs the browser and takes far longer), and a
  // cancel that only lands once the frame loop starts leaves the author's one
  // render slot held for all of it — which reads as "a video is already being
  // prepared" when they try again.
  const abort = () => params.abortSignal?.throwIfAborted();
  abort();
  // Installs the browser on first use; a boot-time warm usually means this
  // has already happened by the time anyone clicks Download.
  const runtime = await ensureRenderRuntime();
  abort();
  const chromium = await loadChromium();
  abort();

  const browser = await chromium.launch({
    executablePath: runtime.chromiumPath,
    // The replay page renders the recorded app, which the sandbox already
    // contains; these flags only make a containerized Chromium start at all.
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--font-render-hinting=none",
    ],
  });
  try {
    const page = await browser.newPage({
      viewport: {
        width: RENDER_VIEWPORT.width,
        height: RENDER_VIEWPORT.height,
      },
      deviceScaleFactor: 1,
    });
    // A render that fails in the page fails with a stack trace from inside an
    // evaluate, which says nothing about the cause. Keep the page's own errors
    // so the thrown message can carry the real one.
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });
    // The app pane is an iframe, and an iframe that will not load fails as a
    // REQUEST, never as a script error: a frame refused by CSP, a host that
    // will not resolve, a certificate this browser declines. None of those
    // reach `pageerror`, so without this the one failure a render actually
    // suffers is the one it can say nothing about.
    page.on("requestfailed", (request) => {
      pageErrors.push(
        `${request.url()} failed: ${request.failure()?.errorText ?? "unknown"}`,
      );
    });

    const renderUrl = `${config.hackathonRecorder.renderBaseUrl}${APP_RECORDING_RENDER_ROUTE}`;
    await cancellable(
      page.goto(renderUrl, { waitUntil: "domcontentloaded" }),
      params.abortSignal,
    );
    // The page installs its controls from a React effect, so the document is
    // parsed well before they exist — waiting on load state is not enough.
    try {
      await cancellable(
        page.waitForFunction(
          () => typeof window.__archestraRenderSeed === "function",
          undefined,
          { timeout: PAGE_READY_TIMEOUT_MS },
        ),
        params.abortSignal,
      );
    } catch {
      // A cancelled render is not a broken page — rethrow it as itself rather
      // than reporting the author's own cancel as a page that never loaded.
      abort();
      logger.error(
        { renderUrl, pageErrors },
        "The replay render page never became ready",
      );
      throw new ApiError(
        500,
        `The replay render page never loaded${pageErrors.length ? `: ${pageErrors[0]}` : ` (${renderUrl})`}.`,
      );
    }

    // Hand the bundle to the page rather than fetching it there: recordings
    // live in the author's browser, never on this server, so the only copy is
    // the one that arrived with this request.
    await withDeadline({
      work: page.evaluate(
        (bundle) => window.__archestraRenderSeed(bundle),
        params.bundle as unknown as Record<string, unknown>,
      ),
      ms: SEED_TIMEOUT_MS,
      what: "loading the recording",
      signal: params.abortSignal,
    });
    let durationMs: number;
    try {
      durationMs = await withDeadline({
        work: page.evaluate(() => window.__archestraRenderReady()),
        ms: REPLAY_READY_TIMEOUT_MS,
        what: "waiting for the recorded app to load",
        signal: params.abortSignal,
      });
    } catch (error) {
      // A cancelled render is not a broken app frame.
      abort();
      // The page already knows WHY the app pane never came up — a blocked
      // frame, a refused certificate, a name that would not resolve — and that
      // reason is the entire diagnosis. Reporting only that the wait expired
      // sends whoever reads it hunting through a cluster for something the
      // browser could have told them outright.
      logger.error(
        { renderUrl, pageErrors },
        "The recorded app never loaded in the render browser",
      );
      throw new ApiError(
        500,
        `${error instanceof Error ? error.message : "The recorded app never loaded in the render browser"}${
          pageErrors.length ? ` — ${pageErrors[0]}` : ""
        }`,
      );
    }
    if (!durationMs || durationMs <= 0) {
      throw new ApiError(422, "This recording has nothing to render.");
    }
    // The limit is on the final cut, and this is the only place that knows it:
    // the replay reports what it would actually play, with the author's cuts
    // already applied. The raw recording is a different and always larger
    // number — refusing a session trimmed to 14s for being 35s long is what
    // measuring that one gets you.
    if (durationMs > APP_RECORDING_MAX_EXPORT_MS) {
      throw new ApiError(
        400,
        `This cut runs ${Math.round(durationMs / 1000)}s. Trim it to ${Math.round(APP_RECORDING_MAX_EXPORT_MS / 1000)} seconds or less to export a video.`,
      );
    }

    const region = await page
      .locator(APP_RECORDING_RENDER_REGION_SELECTOR)
      .first();
    const box = await region.boundingBox();
    if (!box)
      throw new ApiError(500, "The replay never laid out for rendering.");
    // H.264 chroma subsampling needs even dimensions; an odd box makes the
    // encoder pad or refuse outright.
    const width = even(box.width);
    const height = even(box.height);

    const cdp = await page.context().newCDPSession(page);
    const clip = { x: box.x, y: box.y, width, height, scale: 1 };
    const frameCount = Math.max(1, Math.ceil((durationMs / 1000) * fps));
    if (frameCount > MAX_FRAMES) {
      throw new ApiError(
        422,
        `This recording is too long to export (${Math.round(durationMs / 1000)}s).`,
      );
    }

    await page.evaluate(
      ({ w, h, f }) => window.__archestraRenderEncoderStart(w, h, f),
      { w: width, h: height, f: fps },
    );
    for (let i = 0; i < frameCount; i++) {
      params.abortSignal?.throwIfAborted();
      // Seek, settle, then capture: the frame must be composited at the
      // seeked instant, not at whatever the previous frame left on screen.
      await withDeadline({
        work: page.evaluate(
          (ms) => window.__archestraRenderSeek(ms),
          (i / fps) * 1000,
        ),
        ms: FRAME_TIMEOUT_MS,
        what: `rendering frame ${i + 1} of ${frameCount}`,
        signal: params.abortSignal,
      });
      const shot = await withDeadline({
        work: cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: FRAME_QUALITY,
          captureBeyondViewport: false,
          clip,
        }),
        ms: FRAME_TIMEOUT_MS,
        what: `capturing frame ${i + 1} of ${frameCount}`,
        signal: params.abortSignal,
      });
      await withDeadline({
        work: page.evaluate(
          ({ data, index }) => window.__archestraRenderEncodeFrame(data, index),
          { data: shot.data, index: i },
        ),
        ms: FRAME_TIMEOUT_MS,
        what: `encoding frame ${i + 1} of ${frameCount}`,
        signal: params.abortSignal,
      });
    }
    const encoded = await withDeadline({
      work: page.evaluate(() => window.__archestraRenderEncoderFinish()),
      ms: ENCODER_FINISH_TIMEOUT_MS,
      what: "assembling the video file",
      signal: params.abortSignal,
    });
    logger.info(
      { frames: frameCount, fps, width, height, bytes: encoded.length },
      "Rendered an app session recording to video",
    );
    return Buffer.from(encoded, "base64");
  } finally {
    await browser.close().catch(() => {});
  }
}

/** The download name for a session video: `<slugified title>-session.mp4`. */
export function recordingVideoFileName(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app";
  return `${slug}-session.mp4`;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Admit one render, or refuse it. Returns the release.
 *
 * A render drives a whole browser for tens of seconds, so concurrency has to be
 * bounded somewhere that a client cannot talk its way past: the export button
 * disables itself, but it is one fetch away from being bypassed, and it forgets
 * it was ever pressed as soon as the player is closed and reopened. Without a
 * bound here, a handful of clicks — or one loop — is enough to hold the host's
 * memory and CPU on browsers.
 *
 * One at a time per person, so a double submit waits for nothing and simply
 * says so, and a small ceiling overall so several people cannot collectively do
 * what one person is stopped from doing.
 *
 * In-process, and therefore per-replica: the ceiling is a resource guard for
 * the machine actually doing the work, not an account-level quota.
 *
 * @public — exported for testability
 */
export function admitRender(userId: string): () => void {
  if (renderingUsers.has(userId)) {
    throw new ApiError(
      429,
      "A video is already being prepared for you. It downloads on its own when it is done.",
    );
  }
  if (renderingUsers.size >= MAX_CONCURRENT_RENDERS) {
    throw new ApiError(
      429,
      "Too many videos are being prepared right now. Try again in a minute.",
    );
  }
  renderingUsers.add(userId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    renderingUsers.delete(userId);
  };
}

/** Who is mid-render. Also the concurrency count — one render per person. */
const renderingUsers = new Set<string>();
/**
 * Deliberately small. Each render is a browser plus a CPU-bound encode, so the
 * useful number is close to the core count, not to the request rate.
 */
const MAX_CONCURRENT_RENDERS = 2;

/** JPEG quality of an intermediate frame — it is re-encoded to H.264 after. */
const FRAME_QUALITY = 92;
/** Anti-runaway ceiling: ~10 minutes at 30fps. */
const MAX_FRAMES = 18_000;
/** Roomy enough that the player lays out at its own maximum, never clipped. */
const RENDER_VIEWPORT = { width: 1680, height: 1400 };
/** Generous: a dev server may be compiling this route for the first time. */
const PAGE_READY_TIMEOUT_MS = 60_000;
/** Handing over the bundle — a long session's frames make it a big argument. */
const SEED_TIMEOUT_MS = 60_000;
/** Fetching, parsing and running the recorded app's own HTML. */
const REPLAY_READY_TIMEOUT_MS = 90_000;
/**
 * One frame's seek, capture or encode. A frame costs tens of milliseconds, so
 * this bounds a stall rather than a slow machine — set high enough that a
 * loaded host is never mistaken for a broken one.
 */
const FRAME_TIMEOUT_MS = 30_000;
/** Muxing and handing back a multi-megabyte file as base64. */
const ENCODER_FINISH_TIMEOUT_MS = 120_000;

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * Await `work`, but fail if it outlives `ms` — naming the step that stalled.
 *
 * Nothing the page is asked to do has a timeout of its own: `page.evaluate`
 * waits on the page's promise for as long as it takes, so one step that never
 * settles holds the job in "running" until the ten-minute sweep collects it.
 * From the author's side that is indistinguishable from a hang — the toast
 * promising a download simply never resolves. A step that takes minutes is
 * already broken, so bound each one and report which it was.
 */
function withDeadline<T>(params: {
  work: Promise<T>;
  ms: number;
  what: string;
  signal?: AbortSignal;
}): Promise<T> {
  const { work, ms, what, signal } = params;
  // The loser of the race still settles; without this its rejection lands with
  // nothing attached to it once the browser closes underneath.
  work.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new ApiError(
          504,
          `Your video stalled while ${what}. Nothing was changed — try the download again.`,
        ),
      );
    }, ms);
  });
  return Promise.race([cancellable(work, signal), expiry]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Await `work`, but give up the moment the render is cancelled.
 *
 * Playwright's waits take a timeout and never a signal, so a cancelled render
 * would otherwise sit through the whole of one — up to a minute on the page's
 * readiness wait — with the author's single render slot still held. Whatever
 * was in flight is torn down with the browser in the caller's `finally`.
 */
function cancellable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  // The loser of the race still settles; without this its rejection lands with
  // nothing attached to it once the browser closes underneath.
  work.catch(() => {});
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    }),
  ]);
}

/**
 * `playwright-core` ships no browser of its own, which is the point: the
 * browser is installed on demand. Imported lazily so a deployment that never
 * renders a video never pays for the module.
 */
async function loadChromium() {
  try {
    const { chromium } = await import("playwright-core");
    return chromium;
  } catch (error) {
    logger.error({ err: error }, "playwright-core is unavailable");
    throw new ApiError(
      503,
      "Video export is not available on this deployment.",
    );
  }
}

declare global {
  interface Window {
    __archestraRenderSeed(bundle: Record<string, unknown>): Promise<void>;
    __archestraRenderReady(): Promise<number>;
    __archestraRenderSeek(ms: number): Promise<void>;
    __archestraRenderEncoderStart(
      width: number,
      height: number,
      fps: number,
    ): Promise<void>;
    __archestraRenderEncodeFrame(
      jpegBase64: string,
      index: number,
    ): Promise<void>;
    __archestraRenderEncoderFinish(): Promise<string>;
  }
}
