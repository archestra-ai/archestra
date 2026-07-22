import {
  APP_RECORDING_MAX_EXPORT_MS,
  APP_RECORDING_RENDER_FPS,
  APP_RECORDING_RENDER_REGION_SELECTOR,
  APP_RECORDING_RENDER_ROUTE,
  type AppRecordingBundle,
} from "@archestra/shared";
import type { CDPSession } from "playwright-core";
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
 * Chromium loads the ordinary replay page and every frame is captured from
 * compositor output. What the compositor draws is what lands in the file,
 * including the sandboxed app, its WebGL canvases and its blend modes, with
 * the isolation completely untouched.
 *
 * Frames are stepped, never sampled. Wall-clock time drives nothing: playback
 * is seeked to an exact millisecond and animations are scrubbed to the same
 * instant before each capture, so the same bundle renders the same frames on
 * any machine at any speed — and rendering runs faster or slower than realtime
 * without changing the result. Sampling a live replay on a timer produces
 * judder and is not reproducible.
 *
 * The frame loop is built not to wait on anything it doesn't have to:
 *
 * - Compositing is DRIVEN, not awaited, where the browser allows it: under
 *   begin-frame control one protocol command composites exactly one fully
 *   drawn frame and returns its pixels, replacing the settle-then-screenshot
 *   dance (two rAF waits plus a separate capture) of the fallback path. A
 *   browser that refuses the protocol is detected up front and relaunched
 *   without it.
 * - Encoding is ENQUEUED, not awaited: the page chains frames onto an ordered
 *   internal queue, so the next seek-and-capture overlaps the previous
 *   frame's JPEG decode and H.264 encode. A bounded backlog keeps memory flat.
 * - Unchanged frames are never re-sent: a frame whose pixels match the
 *   previous one (compositor reported no damage, or same digest) is re-added
 *   in the page from the retained previous bitmap — no JPEG crosses the
 *   protocol and nothing is re-decoded. The player hides its transport chrome
 *   while filming so an idle replay moment really does produce zero damage.
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
  params.abortSignal?.throwIfAborted();
  // Installs the browser on first use; a boot-time warm usually means this
  // has already happened by the time anyone clicks Download.
  const runtime = await ensureRenderRuntime();
  params.abortSignal?.throwIfAborted();
  const chromium = await loadChromium();
  params.abortSignal?.throwIfAborted();

  // Begin-frame control is probed before any real work, so an unsupported
  // browser costs one launch-and-goto — once per process, not per render.
  if (beginFrameVerdict !== false) {
    try {
      const video = await renderWithBrowser({
        ...params,
        fps,
        chromium,
        runtime,
        beginFrameControl: true,
      });
      beginFrameVerdict = true;
      return video;
    } catch (error) {
      if (!(error instanceof BeginFrameUnsupportedError)) throw error;
      beginFrameVerdict = false;
      logger.info(
        { reason: error.message },
        "Begin-frame compositing is unavailable in this browser; rendering with settled captures",
      );
    }
  }
  return renderWithBrowser({
    ...params,
    fps,
    chromium,
    runtime,
    beginFrameControl: false,
  });
}

/**
 * Whether this process's browser supports begin-frame compositing. Probed on
 * the first render, remembered after: the browser binary cannot change under
 * a running process, so re-probing would only re-pay the doomed launch.
 */
let beginFrameVerdict: boolean | null = null;

async function renderWithBrowser(params: {
  bundle: AppRecordingBundle;
  fps: number;
  abortSignal?: AbortSignal;
  chromium: Awaited<ReturnType<typeof loadChromium>>;
  runtime: Awaited<ReturnType<typeof ensureRenderRuntime>>;
  beginFrameControl: boolean;
}): Promise<Buffer> {
  const { fps, beginFrameControl } = params;
  const browser = await params.chromium.launch({
    executablePath: params.runtime.chromiumPath,
    // The replay page renders the recorded app, which the sandbox already
    // contains; the first three flags only make a containerized Chromium
    // start at all.
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--font-render-hinting=none",
      // Deterministic compositing: the browser never draws on its own — every
      // frame is composited by an explicit beginFrame command and is fully
      // drawn by the time that command acks. The documented begin-frame-
      // control set; threaded animation/scrolling and checker-imaging would
      // let paints trail the frame that supposedly contained them.
      ...(beginFrameControl
        ? [
            "--enable-begin-frame-control",
            "--run-all-compositor-stages-before-draw",
            "--disable-new-content-rendering-timeout",
            "--disable-threaded-animation",
            "--disable-threaded-scrolling",
            "--disable-checker-imaging",
          ]
        : []),
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
    let cdp: CDPSession;
    try {
      cdp = await page.context().newCDPSession(page);
      if (beginFrameControl) {
        // Probe on the fresh about:blank page, BEFORE the expensive page
        // load: an unsupported browser (today's Chromium dropped the domain
        // outright) is found in milliseconds, so the doomed launch costs
        // almost nothing. A browser without begin-frame control either
        // rejects the command or ACCEPTS IT AND NEVER ANSWERS — a hang is as
        // much a "no" as an error, so the probe is deadline-bounded and both
        // outcomes relaunch the same way.
        await withDeadline({
          work: cdp.send("HeadlessExperimental.beginFrame", {}),
          ms: BEGIN_FRAME_PROBE_TIMEOUT_MS,
          what: "probing deterministic compositing",
          signal: params.abortSignal,
        });
      }
      await cancellable(
        page.goto(renderUrl, { waitUntil: "domcontentloaded" }),
        params.abortSignal,
      );
    } catch (error) {
      params.abortSignal?.throwIfAborted();
      // Under the deterministic flags an unsupporting build can wedge as
      // early as page load, so everything before the mode's first real use
      // counts as the browser refusing it. A genuinely broken page fails the
      // relaunched attempt too, with its proper report.
      if (beginFrameControl) {
        throw new BeginFrameUnsupportedError(
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
    // Drive page-side work that awaits animation frames. Under begin-frame
    // control nothing composites — and no rAF fires — unless we pump.
    const drive = <T>(work: Promise<T>): Promise<T> =>
      beginFrameControl ? pumpFrames(cdp, work) : work;
    // The page installs its controls from a React effect, so the document is
    // parsed well before they exist — waiting on load state is not enough.
    // Interval polling, never rAF polling: under begin-frame control a rAF
    // poller would wait on frames nobody is pumping yet.
    try {
      await cancellable(
        page.waitForFunction(
          () => typeof window.__archestraRenderSeed === "function",
          undefined,
          { timeout: PAGE_READY_TIMEOUT_MS, polling: 100 },
        ),
        params.abortSignal,
      );
    } catch {
      // A cancelled render is not a broken page — rethrow it as itself rather
      // than reporting the author's own cancel as a page that never loaded.
      params.abortSignal?.throwIfAborted();
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
        work: drive(page.evaluate(() => window.__archestraRenderReady())),
        ms: REPLAY_READY_TIMEOUT_MS,
        what: "waiting for the recorded app to load",
        signal: params.abortSignal,
      });
    } catch (error) {
      // A cancelled render is not a broken app frame.
      params.abortSignal?.throwIfAborted();
      // The replay's readiness settle is the first thing that WAITS on pumped
      // frames — a build whose compositor ignores the pump surfaces here, and
      // must relaunch plainly rather than report a stall. (A genuinely
      // unloadable app fails the relaunched attempt too, with the full
      // diagnosis below.)
      if (beginFrameControl) {
        throw new BeginFrameUnsupportedError(
          error instanceof Error ? error.message : String(error),
        );
      }
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

    const clip = { x: box.x, y: box.y, width, height, scale: 1 };
    const frameCount = Math.max(1, Math.ceil((durationMs / 1000) * fps));
    if (frameCount > MAX_FRAMES) {
      throw new ApiError(
        422,
        `This recording is too long to export (${Math.round(durationMs / 1000)}s).`,
      );
    }

    await page.evaluate((opts) => window.__archestraRenderEncoderStart(opts), {
      width,
      height,
      fps,
      // beginFrame screenshots have no clip parameter — they capture the
      // whole viewport, and the encoder crops the region back out. The
      // settled path clips at the compositor and sends frames pre-cropped.
      crop: beginFrameControl
        ? { x: Math.round(box.x), y: Math.round(box.y), width, height }
        : undefined,
    });

    let encodedFrames = 0;
    let repeatedFrames = 0;
    let previousDigest: string | null = null;
    for (let i = 0; i < frameCount; i++) {
      params.abortSignal?.throwIfAborted();
      let data: string | null;
      try {
        // Seek, settle, then capture: the frame must be composited at the
        // seeked instant, not at whatever the previous frame left on screen.
        await withDeadline({
          work: drive(
            page.evaluate(
              (ms) => window.__archestraRenderSeek(ms),
              (i / fps) * 1000,
            ),
          ),
          ms: FRAME_TIMEOUT_MS,
          what: `rendering frame ${i + 1} of ${frameCount}`,
          signal: params.abortSignal,
        });
        if (beginFrameControl) {
          const frame = (await withDeadline({
            work: cdp.send("HeadlessExperimental.beginFrame", {
              screenshot: {
                format: "jpeg",
                quality: FRAME_QUALITY,
                optimizeForSpeed: true,
              },
            }),
            ms: FRAME_TIMEOUT_MS,
            what: `capturing frame ${i + 1} of ${frameCount}`,
            signal: params.abortSignal,
          })) as { hasDamage?: boolean; screenshotData?: string };
          // No damage since the last composite = the previous frame, pixel
          // for pixel — the compositor itself said this frame is a repeat.
          data = frame.screenshotData ?? null;
        } else {
          const shot = await withDeadline({
            work: cdp.send("Page.captureScreenshot", {
              format: "jpeg",
              quality: FRAME_QUALITY,
              captureBeyondViewport: false,
              // Faster JPEG encode over smaller bytes — the frame is
              // re-encoded to H.264 anyway, and it crosses a local pipe.
              optimizeForSpeed: true,
              clip,
            }),
            ms: FRAME_TIMEOUT_MS,
            what: `capturing frame ${i + 1} of ${frameCount}`,
            signal: params.abortSignal,
          });
          data = shot.data;
        }
      } catch (error) {
        params.abortSignal?.throwIfAborted();
        // The first frame proves the mode end to end: a compositor that took
        // the probe but cannot actually step-and-capture surfaces here and
        // relaunches plainly. Past frame 0 the mode has proven itself and a
        // failure is a real stall, reported as one.
        if (beginFrameControl && i === 0) {
          throw new BeginFrameUnsupportedError(
            error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      }
      if (data === null && previousDigest === null) {
        throw new ApiError(500, "The compositor produced no first frame.");
      }
      // An unchanged frame is re-added in the page from the retained previous
      // bitmap: no JPEG crosses the protocol, nothing is re-decoded.
      const digest = data === null ? null : fnv1a(data);
      const unchanged =
        previousDigest !== null && (data === null || digest === previousDigest);
      const backlog = await withDeadline({
        work: unchanged
          ? page.evaluate(
              (index) => window.__archestraRenderRepeatFrame(index),
              i,
            )
          : page.evaluate(
              ({ data, index }) =>
                window.__archestraRenderEncodeFrame(data, index),
              { data: data as string, index: i },
            ),
        ms: FRAME_TIMEOUT_MS,
        what: `encoding frame ${i + 1} of ${frameCount}`,
        signal: params.abortSignal,
      });
      if (unchanged) {
        repeatedFrames++;
      } else {
        encodedFrames++;
        previousDigest = digest;
      }
      // The queue hides encode latency, it must not hide encode collapse:
      // past the window, wait it out (and surface any queued failure) before
      // capturing more.
      if (backlog > ENCODE_BACKLOG_LIMIT) {
        await withDeadline({
          work: page.evaluate(() => window.__archestraRenderEncodeDrain()),
          ms: FRAME_TIMEOUT_MS,
          what: `encoding frame ${i + 1} of ${frameCount}`,
          signal: params.abortSignal,
        });
      }
    }
    const encoded = await withDeadline({
      work: page.evaluate(() => window.__archestraRenderEncoderFinish()),
      ms: ENCODER_FINISH_TIMEOUT_MS,
      what: "assembling the video file",
      signal: params.abortSignal,
    });
    logger.info(
      {
        frames: frameCount,
        encodedFrames,
        repeatedFrames,
        beginFrameControl,
        fps,
        width,
        height,
        bytes: encoded.length,
      },
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
/**
 * How many frames may sit in the page's encode queue before the loop waits it
 * out. Deep enough to hide a frame's decode+encode behind the next capture,
 * shallow enough that a stalled encoder stops the render within a beat — and
 * bounds the queue's held JPEGs to a few megabytes.
 */
const ENCODE_BACKLOG_LIMIT = 6;
/** Breather between pumped frames — the ack itself paces the pump. */
const PUMP_STEP_MS = 4;
/** A supporting compositor acks a beginFrame in milliseconds; one that has
 * ignored it for this long is never going to answer. */
const BEGIN_FRAME_PROBE_TIMEOUT_MS = 10_000;

/** Thrown only by the begin-frame probe: the one error that means "relaunch
 * without it", never "the render failed". */
class BeginFrameUnsupportedError extends Error {}

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * Drive the compositor while page-side work awaits animation frames.
 *
 * Under begin-frame control the browser never composites on its own, so any
 * in-page code awaiting requestAnimationFrame — the seek settle's two-frame
 * wait above all — waits for frames nobody else will produce. While `work` is
 * outstanding, keep issuing beginFrames; each acks only once its frame is
 * fully drawn (--run-all-compositor-stages-before-draw), so the ack itself
 * paces the loop. The in-flight command is always finished before returning —
 * a caller's next protocol message must never race a half-issued frame.
 */
async function pumpFrames<T>(cdp: CDPSession, work: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = work.finally(() => {
    settled = true;
  });
  tracked.catch(() => {});
  const pumping = (async () => {
    while (!settled) {
      try {
        await cdp.send("HeadlessExperimental.beginFrame", {});
      } catch {
        // The browser is closing underneath us; the awaited work says why.
        return;
      }
      if (settled) return;
      await new Promise((resolve) => setTimeout(resolve, PUMP_STEP_MS));
    }
  })();
  try {
    return await tracked;
  } finally {
    await pumping;
  }
}

/** Tiny non-cryptographic digest — plenty to say "same JPEG as last frame". */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`;
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
    __archestraRenderEncoderStart(params: {
      width: number;
      height: number;
      fps: number;
      crop?: { x: number; y: number; width: number; height: number };
    }): Promise<void>;
    /** Enqueue a frame; resolves with the encoder's backlog depth. */
    __archestraRenderEncodeFrame(
      jpegBase64: string,
      index: number,
    ): Promise<number>;
    /** Re-add the previous frame at this index (compositor saw no change). */
    __archestraRenderRepeatFrame(index: number): Promise<number>;
    /** Wait out the encode backlog; rethrows a queued frame's failure. */
    __archestraRenderEncodeDrain(): Promise<void>;
    __archestraRenderEncoderFinish(): Promise<string>;
  }
}
