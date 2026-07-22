// Archestra app-session recording SDK — the capture + replay half of the
// injected Apps SDK. Served APPENDED to archestra-app-sdk.js (see server.ts)
// only when app session recording is enabled, so disabled deployments never
// deliver this code to apps and removing the feature is deleting this file.
// ── Session recorder + replay driver ──────────────────────────────────────
// Powers the host's "Record session" demos. Dormant until the trusted host
// posts a recording-control message (relayed through the sandbox proxy):
//  - record mode captures pointer/keyboard/input/scroll/viewport activity and
//    posts it up in batches ({type:"mcp-apps:recording-event", events}) —
//    the same lane shape as diagnostics; the host discards batches unless the
//    user is actively recording.
//  - replay mode re-drives recorded events against a fresh instance of the
//    app: a virtual cursor, coordinate-dispatched mouse events, native-setter
//    input values (synthetic keys cannot type), key events for app listeners,
//    and scroll restoration. Best-effort by design — a failed step must never
//    break the app.
(() => {
  const CONTROL_TYPE = "mcp-apps:recording-control";
  const REPLAY_TYPE = "mcp-apps:replay-control";
  const EVENT_TYPE = "mcp-apps:recording-event";
  const FLUSH_INTERVAL_MS = 250;
  const FLUSH_BUFFER_MAX = 200;
  const MOVE_SAMPLE_MS = 40;
  const SCROLL_SAMPLE_MS = 100;

  let recording = false;
  let buffer = [];
  let flushTimer = null;
  let lastMoveTs = 0;
  let lastScrollTs = 0;
  let teardownFns = [];


  const post = (msg) => {
    try {
      window.parent.postMessage(msg, "*");
    } catch {
      // never let recording break the app
    }
  };

  const flush = () => {
    if (buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    post({ type: EVENT_TYPE, events });
  };

  // Events carry an absolute epoch `ts`; the host rebases them onto the
  // recording clock (same machine, same clock).
  const push = (event) => {
    // The recording gate — with one seam: encoded video chunks may land during
    // the post-stop drain, while the encoder flushes what it already owns.
    if (
      !recording &&
      !(videoDraining && event.kind === "video-chunk")
    ) {
      return;
    }
    event.ts = Date.now();
    // Recorded input doubles as an activity signal for the canvas sampler: an
    // event-driven draw (a click repainting a chart) follows input, not rAF.
    // Captured output (stills, video chunks/configs) must not count, or
    // capture would self-sustain.
    if (
      event.kind !== "canvas" &&
      event.kind !== "video-chunk" &&
      event.kind !== "video-config"
    ) {
      inputActivityUntil = event.ts + INPUT_ACTIVITY_MS;
    }
    buffer.push(event);
    if (buffer.length >= FLUSH_BUFFER_MAX) flush();
  };

  // Replay-resilient selector: a unique id when there is one, otherwise a
  // structural :nth-of-type path. The replayed app is the same HTML fed the
  // same recorded MCP responses, so structural paths resolve to the same
  // nodes they were captured on.
  const selectorFor = (el) => {
    try {
      if (
        el.id &&
        document.querySelectorAll("#" + CSS.escape(el.id)).length === 1
      ) {
        return "#" + CSS.escape(el.id);
      }
    } catch {
      // CSS.escape unavailable or exotic id — fall through to the path
    }
    const path = [];
    let node = el;
    while (
      node &&
      node.nodeType === 1 &&
      node !== document.documentElement
    ) {
      let index = 1;
      let sibling = node;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === node.tagName) index++;
      }
      path.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + index + ")");
      node = node.parentElement;
    }
    return path.length ? "html > " + path.join(" > ") : "html";
  };

  // Anchor a pointer event to its target element: the selector plus the
  // pointer's offset within the element's rect. The player replays the app in
  // a viewport of ITS OWN size (never the recorded one), so the app lays out
  // differently and raw coordinates alone would drift off their elements —
  // replay re-resolves the anchor in the current layout instead.
  const targetAnchor = (e) => {
    try {
      const el = e.target && e.target.nodeType === 1 ? e.target : null;
      if (!el) return {};
      const rect = el.getBoundingClientRect();
      return {
        selector: selectorFor(el).slice(0, 1000),
        ox: Math.round(e.clientX - rect.left),
        oy: Math.round(e.clientY - rect.top),
      };
    } catch {
      return {};
    }
  };

  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    teardownFns.push(() => target.removeEventListener(type, handler, options));
  };

  // ── Output capture ──
  // What the app BECAME, not just what was done to it.
  //
  // Re-running an app from its recorded input only reproduces the session if
  // the app is a pure function of that input, and real ones are not: they draw
  // from Math.random, they run on their own clock, they read state the host
  // holds. A recorded game replayed that way plays a different game. So the
  // visible result is recorded directly and replayed as itself.

  /**
   * WebGL capture prerequisite, installed at SDK load — the SDK is injected at
   * the head of the document as a classic script, so this wrap is in place
   * before any app code (module scripts run only after parse) can create a
   * context.
   *
   * toDataURL reads a WebGL canvas's drawing buffer, and by default that
   * buffer is cleared the moment each frame reaches the screen — sampled from
   * a timer, every read comes back blank, so a WebGL app would record nothing
   * but empty frames. preserveDrawingBuffer can only be chosen at context
   * creation, and a recording can start at any moment in the app's life, so
   * while the recording SDK is present every WebGL context is created
   * preservable. The cost is one extra buffer copy per composited frame —
   * paid only on deployments that enabled recording, which is what gates
   * serving this file at all.
   */
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, attrs) {
    if (/^(webgl2?|experimental-webgl)$/.test(String(kind))) {
      return origGetContext.call(this, kind, {
        ...(attrs && typeof attrs === "object" ? attrs : {}),
        preserveDrawingBuffer: true,
      });
    }
    return origGetContext.apply(this, arguments);
  };

  /**
   * Canvas pixels.
   *
   * A canvas is invisible to a MutationObserver — an app can repaint its entire
   * screen without producing a single mutation — and its contents cannot be
   * re-derived from input. Sampled rather than hooked: wrapping every 2D
   * context method would be far more code and still miss WebGL.
   *
   * Sampling runs on requestAnimationFrame, so an animating app is captured at
   * the rate it is presented — full motion, not a slideshow — and the encode
   * backpressure gate below is the throughput governor: a machine that can't
   * encode at display rate degrades to the rate it sustains instead of
   * stalling the app. Three layers keep a quiet app cheap: frames are only
   * attempted while the app looks active (it scheduled animation frames, or
   * recorded input just happened), an inactive app drops to a slow keepalive
   * probe, and a frame whose bytes didn't change is never emitted.
   */
  /** Capture floor while the app shows no animation or input activity. */
  const CANVAS_KEEPALIVE_MS = 500;
  /** How long a recorded input event counts as activity (event-driven draws). */
  const INPUT_ACTIVITY_MS = 1_000;
  /**
   * Captured frames are capped at this many pixels (~1080p-class). Encode cost
   * is linear in pixel count but runs off the main thread, and the queue-depth
   * guard below sheds load on machines that can't keep up — the cap only
   * exists for the truly huge sources (a full-viewport canvas on a 2x display
   * approaches ~6MP). It sits high enough that a HiDPI canvas keeps most of
   * its native resolution: the old ~720p cap threw away nearly half of a 2x
   * backing store's linear detail, which replayed as the "low-res" look.
   */
  const CANVAS_CAPTURE_MAX_PIXELS = 1920 * 1080;
  const canvasLastFrame = new WeakMap();
  /** Canvases with a capture currently encoding — see the backpressure note. */
  const canvasCaptureBusy = new WeakSet();
  /** When each canvas last attempted a capture, for the idle keepalive. */
  const canvasLastAttemptAt = new WeakMap();
  let canvasRafId = null;
  /** The app scheduled an animation frame since the sampler last looked. */
  let appRafScheduled = false;
  /** Until when recorded input keeps counting as app activity. */
  let inputActivityUntil = 0;
  let scratchCanvas = null;

  // ── Encoded video capture (WebCodecs) ──
  // A canvas filmed as stills re-encodes the whole screen every frame; a video
  // codec spends those bytes once per keyframe and encodes motion deltas in
  // between — the difference between megabytes-per-second of WebPs and a few
  // hundred kilobytes of VP9 at the same fidelity. Where VideoEncoder exists,
  // each canvas gets one encoder stream: a config event opens it, keyframes
  // land on a fixed cadence so a seek never re-decodes more than a cadence's
  // worth of deltas, and chunks flow through the same event pipeline as
  // everything else — as raw bytes; base64 exists only in the stored bundle.
  //
  // VP9/VP8 only, deliberately: every Chromium build decodes them (the offline
  // renderer may run a codecs-free Chromium where H.264 decode is absent), and
  // VP9 hardware encode is common on the machines that record. A browser that
  // can encode neither (or has no WebCodecs) records WebP stills instead.
  const VIDEO_CODEC_CANDIDATES = ["vp09.00.10.08", "vp8"];
  /**
   * Fallback rate control, only for encoders without per-frame quantizers:
   * bits scale with the captured area (one fixed rate that suits 720p starves
   * 1080p), clamped so tiny canvases stay decent and huge ones stay bounded.
   */
  const VIDEO_BITRATE_PER_PIXEL = 2.0;
  const VIDEO_BITRATE_MIN = 1_000_000;
  const VIDEO_BITRATE_MAX = 4_000_000;
  /**
   * Keyframe cadence. Keys at ~1080p cost hundreds of kilobytes each, so the
   * cadence is a real share of the whole byte budget; a seek re-decodes at
   * most a cadence's worth of deltas, which stays well under a second of
   * decode work.
   */
  const VIDEO_KEYFRAME_MS = 2_000;
  /** How deep the encoder's input queue may grow before frames are skipped. */
  const VIDEO_MAX_QUEUE = 2;
  // ── Constant quality (per-frame quantizer), where the encoder supports it.
  // Quality stays fixed and bytes follow content: an unchanged scene encodes
  // to skip-block deltas of a few hundred bytes, motion costs what it costs.
  // Two feedback loops keep it safe: queue pressure raises the quantizer —
  // cheaper frames also encode FASTER, so a slow machine softens briefly
  // instead of dropping frames — and a byte-rate governor nudges it up when
  // the rolling output rate crosses its ceiling, so a worst-case all-motion
  // recording stays bounded instead of growing without limit.
  const VIDEO_BASE_QP = 30; // VP9 0..63 — visually clean for UI/3D content
  /** Keys are what seeks land on and posters paint — spend more on them. */
  const VIDEO_KEY_QP_BONUS = 2;
  const VIDEO_MIN_QP = 12;
  const VIDEO_MAX_QP = 56;
  const VIDEO_QP_BOOST_STEP = 3;
  const VIDEO_QP_BOOST_MAX = 18;
  /**
   * The governor's ceiling is a TOTAL across every stream in the recording,
   * not per canvas — bundles are stored, uploaded and rendered whole, so the
   * number that matters is the recording's byte rate, and a three-canvas app
   * must not cost three times a one-canvas app. Content that outruns even the
   * maximum quantizer settles at the frame shed's line — this ceiling times
   * its headroom — so the ceiling is sized from there: a worst-case
   * all-motion 30s cut stays ~14MB of video (~19MB as a shared bundle), and
   * a minutes-long raw take stays under the ~100MB ceilings of the render
   * and gallery-upload paths. Content below the ceiling never feels it.
   */
  const VIDEO_GOVERNOR_MAX_BPS = 3_000_000;
  /**
   * Wide enough for the frame shed to hold the ceiling even when single
   * frames are enormous: the shed can only space frames out, so its floor is
   * one worst-case frame per window span — a ~2MB frame (1080p noise at max
   * quantizer) against 5s is ~3 Mbit/s, inside the ceiling. Against a short
   * window the same frame busts the cap all by itself and the rate floor
   * lands far above the ceiling no matter how hard the shed works.
   */
  const VIDEO_GOVERNOR_WINDOW_MS = 5_000;
  /**
   * Reaches VIDEO_MAX_QP from base: on content VP9 cannot cheapen (noise,
   * particles), a ceiling short of the maximum quantizer pins there and the
   * rate runs away anyway — convergence has to be reachable, not hoped for.
   */
  const VIDEO_GOVERNOR_QP_MAX = VIDEO_MAX_QP - VIDEO_BASE_QP;
  /**
   * One quantizer step per adjustment, at most this often. Chunk arrivals
   * scale with streams times frame rate, and stepping per chunk would swing
   * the whole range in a fraction of a second; paced, a full climb takes a
   * couple of seconds — fast enough to bound a burst, slow enough not to
   * flicker between quality levels.
   */
  const VIDEO_GOVERNOR_STEP_MS = 80;
  /**
   * The hard brake behind the quantizer: frames stop being FED once the
   * rolling rate runs this far past the ceiling. Quality-first is the right
   * first response, but it cannot be the only one — a quantizer reduces what
   * redundancy the codec can find, and content with none (noise, particles,
   * camera grain) encodes at hundreds of megabits even at maximum quantizer.
   * Measured, not assumed: 1080p noise at QP 56 still emits ~200 Mbit/s.
   * Bytes, not quality, are the contract, so past this line the frame rate
   * gives way instead: deltas are skipped until the window drains.
   */
  const VIDEO_SHED_HEADROOM = 1.25;
  /**
   * Keyframes outrank the shed — a stream without them stops being seekable —
   * but under sustained over-budget content they stretch to this cadence
   * instead of their usual one. The floor on what a pathological recording
   * can cost: keys alone at this spacing stay around half the ceiling.
   */
  const VIDEO_KEY_MAX_INTERVAL_MS = 6_000;
  /** canvas → { encoder, sel, width, height, lastKeyMs, errored, ... } */
  const videoStreams = new WeakMap();
  /** undefined = not probed yet; null = unsupported; else the chosen mode
   *  { codec, quantizer } — quantizer true = constant-quality encoding. */
  let videoMode;
  let videoCodecProbe = null;
  let videoDraining = false;
  // The governor's shared state: every stream's chunks land in one rolling
  // window, and the one quantizer surcharge applies to all of them.
  let videoGovernorQp = 0;
  let videoGovernorAdjustedAt = 0;
  const videoRateWindow = [];

  const videoBitrateFor = (pixels) =>
    Math.max(
      VIDEO_BITRATE_MIN,
      Math.min(VIDEO_BITRATE_MAX, Math.round(pixels * VIDEO_BITRATE_PER_PIXEL)),
    );

  const probeVideoCodec = () => {
    if (videoCodecProbe) return videoCodecProbe;
    videoCodecProbe = (async () => {
      if (typeof VideoEncoder !== "function") return null;
      // Constant quality first — VP9 only, VP8 has no per-frame quantizer in
      // WebCodecs. A browser without quantizer mode falls back to bitrate.
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec: VIDEO_CODEC_CANDIDATES[0],
          width: 1280,
          height: 720,
          bitrateMode: "quantizer",
          latencyMode: "realtime",
        });
        if (support && support.supported) {
          return { codec: VIDEO_CODEC_CANDIDATES[0], quantizer: true };
        }
      } catch {
        // fall through to the bitrate candidates
      }
      for (const codec of VIDEO_CODEC_CANDIDATES) {
        try {
          const support = await VideoEncoder.isConfigSupported({
            codec,
            width: 1280,
            height: 720,
            bitrate: videoBitrateFor(1280 * 720),
            latencyMode: "realtime",
          });
          if (support && support.supported) return { codec, quantizer: false };
        } catch {
          // an unparseable candidate just means "not this one"
        }
      }
      return null;
    })().then((mode) => {
      videoMode = mode;
      return mode;
    });
    return videoCodecProbe;
  };

  const pushVideoConfig = (sel, width, height, description) => {
    const event = {
      kind: "video-config",
      sel,
      codec: videoMode.codec,
      codedWidth: width,
      codedHeight: height,
    };
    if (description) {
      // Copy out of the encoder-owned buffer; the event outlives the callback.
      event.description = new Uint8Array(
        description instanceof ArrayBuffer
          ? description.slice(0)
          : description.buffer.slice(
              description.byteOffset,
              description.byteOffset + description.byteLength,
            ),
      );
    }
    push(event);
  };

  const createVideoStream = (sel, width, height) => {
    const stream = {
      sel,
      width,
      height,
      lastKeyMs: Number.NEGATIVE_INFINITY,
      errored: false,
      encoder: null,
      descriptionSent: false,
      // Queue pressure is a property of this one encoder — the governor's
      // byte-rate state is shared across streams instead.
      qpBoost: 0,
      // What this stream's frames have been costing lately — the frame
      // shed's estimate for the one it is about to admit.
      lastChunkBytes: 0,
    };
    try {
      stream.encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          try {
            // Codec extradata, when a codec carries any, arrives with the
            // first chunk — reopen the stream with it so the decoder gets it.
            const description =
              metadata &&
              metadata.decoderConfig &&
              metadata.decoderConfig.description;
            if (description && !stream.descriptionSent) {
              stream.descriptionSent = true;
              pushVideoConfig(sel, width, height, description);
            }
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            push({
              kind: "video-chunk",
              sel,
              type: chunk.type === "key" ? "key" : "delta",
              tsUs: Math.max(0, Math.round(chunk.timestamp || 0)),
              bytes,
            });
            stream.lastChunkBytes = bytes.byteLength;
            governVideoRate(bytes.byteLength);
          } catch {
            // a dropped chunk must never break the app
          }
        },
        error: () => {
          stream.errored = true;
        },
      });
      const config = {
        codec: videoMode.codec,
        width,
        height,
        // Realtime, deliberately — NOT the quality preset. Quality mode's
        // lookahead can emit a wall-clock-forced keyframe OUT OF DECODE ORDER
        // when the input cadence is irregular (capture idles at the keepalive
        // rate between bursts), and one stale key makes the whole stored tail
        // undecodable. Realtime has no lookahead, so output order is strict —
        // and under a per-frame quantizer the quality preset measured zero
        // size or quality benefit anyway (its wins live in rate control,
        // which quantizer mode replaces). The hint keeps edges (wireframes,
        // text) ahead of motion smoothness.
        latencyMode: "realtime",
        contentHint: "detail",
      };
      if (videoMode.quantizer) {
        config.bitrateMode = "quantizer";
      } else {
        config.bitrate = videoBitrateFor(width * height);
      }
      stream.encoder.configure(config);
    } catch {
      return null;
    }
    pushVideoConfig(sel, width, height, null);
    return stream;
  };

  /**
   * Feed one canvas frame into its encoder stream, creating or reopening the
   * stream as needed (first frame, canvas resize, encoder closed by a prior
   * stop). VideoFrame reads the canvas GPU-side — no toDataURL readback, no
   * main-thread image encode — and the encoder's own queue is the throttle:
   * when it falls behind, frames are skipped, never queued up.
   */
  const feedVideoFrame = (canvas) => {
    const pixels = canvas.width * canvas.height;
    if (!pixels) return;
    // Codecs subsample chroma in 2x2 blocks, so coded dimensions stay even.
    let width = canvas.width;
    let height = canvas.height;
    if (pixels > CANVAS_CAPTURE_MAX_PIXELS) {
      const scale = Math.sqrt(CANVAS_CAPTURE_MAX_PIXELS / pixels);
      width = Math.round(canvas.width * scale);
      height = Math.round(canvas.height * scale);
    }
    width = Math.max(2, width - (width % 2));
    height = Math.max(2, height - (height % 2));

    let stream = videoStreams.get(canvas);
    if (
      stream &&
      (stream.errored ||
        !stream.encoder ||
        stream.encoder.state === "closed" ||
        stream.width !== width ||
        stream.height !== height)
    ) {
      if (stream.errored) return; // this canvas falls back to stills
      try {
        if (stream.encoder && stream.encoder.state !== "closed") {
          stream.encoder.close();
        }
      } catch {}
      stream = null;
    }
    if (!stream) {
      stream = createVideoStream(
        selectorFor(canvas).slice(0, 1000),
        width,
        height,
      );
      if (!stream) return;
      videoStreams.set(canvas, stream);
    }
    // Queue pressure: in quantizer mode the first response is a cheaper —
    // and therefore faster-to-encode — frame, so a machine that falls behind
    // softens briefly instead of stuttering; only a queue past the hard cap
    // still skips the frame outright.
    const queue = stream.encoder.encodeQueueSize;
    if (queue >= 1) {
      stream.qpBoost = Math.min(
        stream.qpBoost + VIDEO_QP_BOOST_STEP,
        VIDEO_QP_BOOST_MAX,
      );
    } else if (stream.qpBoost > 0) {
      stream.qpBoost -= 1;
    }
    if (queue > VIDEO_MAX_QUEUE) return;

    let source = canvas;
    if (width !== canvas.width || height !== canvas.height) {
      if (!scratchCanvas) scratchCanvas = document.createElement("canvas");
      if (scratchCanvas.width !== width) scratchCanvas.width = width;
      if (scratchCanvas.height !== height) scratchCanvas.height = height;
      const ctx = scratchCanvas.getContext("2d");
      if (!ctx) return;
      // The one place capture resamples — use the good filter for it.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      try {
        ctx.drawImage(canvas, 0, 0, width, height);
      } catch {
        return; // tainted canvas — nothing to record
      }
      source = scratchCanvas;
    }
    const atMs = nowMs();
    const keyDue = atMs - stream.lastKeyMs >= VIDEO_KEYFRAME_MS;
    // The byte-hard backstop. Once the recording's rolling rate — including
    // what THIS frame is about to cost, estimated from the stream's previous
    // chunk — would run past the ceiling with headroom, the quantizer has
    // already given what it can: deltas are dropped outright, and even a due
    // key waits, up to the hard key interval that keeps the stream seekable.
    // Predicting the frame's cost matters when frames are huge — checking
    // only what already landed admits every giant frame exactly once, and on
    // content where one frame busts the whole window that is the difference
    // between holding the ceiling and doubling it. Feeding nothing drains the
    // window within seconds, so this self-limits to bursts around the cap:
    // pathological content records as a slideshow, never as a runaway bundle.
    const predictedBps =
      videoWindowBps(atMs) +
      (stream.lastChunkBytes * 8 * 1000) / VIDEO_GOVERNOR_WINDOW_MS;
    if (predictedBps > VIDEO_GOVERNOR_MAX_BPS * VIDEO_SHED_HEADROOM) {
      const keyOverdue = atMs - stream.lastKeyMs >= VIDEO_KEY_MAX_INTERVAL_MS;
      if (!keyOverdue) return;
    }
    const keyFrame = keyDue;
    let frame;
    try {
      frame = new VideoFrame(source, { timestamp: Math.round(atMs * 1000) });
    } catch {
      return;
    }
    try {
      const options = { keyFrame };
      if (videoMode.quantizer) {
        const qp = Math.min(
          VIDEO_MAX_QP,
          Math.max(
            VIDEO_MIN_QP,
            VIDEO_BASE_QP + stream.qpBoost + videoGovernorQp,
          ),
        );
        options.vp9 = {
          quantizer: keyFrame
            ? Math.max(VIDEO_MIN_QP, qp - VIDEO_KEY_QP_BONUS)
            : qp,
        };
      }
      stream.encoder.encode(frame, options);
      if (keyFrame) stream.lastKeyMs = atMs;
    } catch {
      stream.errored = true;
    } finally {
      frame.close();
    }
  };

  /**
   * The recording's rolling video output rate — every stream's chunks in one
   * window. What the governor steers by and the frame shed cuts on.
   */
  const videoWindowBps = (now) => {
    while (
      videoRateWindow.length &&
      videoRateWindow[0].t < now - VIDEO_GOVERNOR_WINDOW_MS
    ) {
      videoRateWindow.shift();
    }
    let bytes = 0;
    for (const entry of videoRateWindow) bytes += entry.bytes;
    return (bytes * 8 * 1000) / VIDEO_GOVERNOR_WINDOW_MS;
  };

  /**
   * The byte-rate governor: constant quality has no ceiling of its own, so
   * when the recording's rolling output rate — all streams together — crosses
   * the cap, quality gives way one quantizer step at a time (and comes back
   * the same way once safely under). Bounds a worst-case all-motion recording
   * without touching typical ones. The window is fed in every mode — the
   * frame shed reads it too — while the quantizer response only exists where
   * per-frame quantizers do.
   */
  const governVideoRate = (chunkBytes) => {
    const now = nowMs();
    videoRateWindow.push({ t: now, bytes: chunkBytes });
    const bps = videoWindowBps(now);
    if (!videoMode || !videoMode.quantizer) return;
    if (now - videoGovernorAdjustedAt < VIDEO_GOVERNOR_STEP_MS) return;
    if (bps > VIDEO_GOVERNOR_MAX_BPS) {
      if (videoGovernorQp < VIDEO_GOVERNOR_QP_MAX) {
        videoGovernorQp += 1;
        videoGovernorAdjustedAt = now;
      }
    } else if (bps < VIDEO_GOVERNOR_MAX_BPS * 0.85 && videoGovernorQp > 0) {
      videoGovernorQp -= 1;
      videoGovernorAdjustedAt = now;
    }
  };

  /**
   * Flush every live encoder after the recording gate closes, so the chunks
   * the encoders still own make it into the capture: `videoDraining` holds the
   * push gate open for exactly those chunks, and the buffer is flushed again
   * when the last encoder settles — inside the host's post-stop grace window.
   */
  const drainVideoStreams = () => {
    let canvases;
    try {
      canvases = Array.from(document.querySelectorAll("canvas"));
    } catch {
      return;
    }
    const streams = [];
    const flushes = [];
    for (const canvas of canvases) {
      const stream = videoStreams.get(canvas);
      if (!stream || !stream.encoder || stream.encoder.state === "closed") {
        continue;
      }
      streams.push(stream);
      if (!stream.errored) {
        try {
          flushes.push(stream.encoder.flush());
        } catch {}
      }
    }
    if (streams.length === 0) return;
    videoDraining = true;
    Promise.allSettled(flushes).then(() => {
      videoDraining = false;
      flush();
      for (const stream of streams) {
        try {
          stream.encoder.close();
        } catch {}
      }
    });
  };

  /**
   * Read one canvas's current pixels into an encoded-image Blob (the stills
   * fallback for browsers without WebCodecs), off the app's critical path: an
   * oversized bitmap is first downscaled into a reused scratch canvas, and
   * the encode goes through toBlob — which snapshots the bitmap at call time
   * and encodes off the main thread — rather than toDataURL, whose whole
   * encode runs synchronously on it. The bytes stay a Blob end to end;
   * nothing here (or anywhere on the live path) renders base64. `sync`
   * forces the synchronous path for the one capture that cannot wait (the
   * final frame at stop, taken just before the recording gate closes). Calls
   * `done` with null when the canvas can't be captured (tainted, zero-sized,
   * encoder failure) — a skipped frame must never break the app.
   */
  const captureCanvas = (canvas, sync, done) => {
    try {
      const pixels = canvas.width * canvas.height;
      if (!pixels) return done(null);
      let source = canvas;
      if (pixels > CANVAS_CAPTURE_MAX_PIXELS) {
        const scale = Math.sqrt(CANVAS_CAPTURE_MAX_PIXELS / pixels);
        if (!scratchCanvas) scratchCanvas = document.createElement("canvas");
        // Assigning the size also clears the scratch between captures.
        scratchCanvas.width = Math.max(1, Math.round(canvas.width * scale));
        scratchCanvas.height = Math.max(1, Math.round(canvas.height * scale));
        const ctx = scratchCanvas.getContext("2d");
        if (!ctx) return done(null);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(canvas, 0, 0, scratchCanvas.width, scratchCanvas.height);
        source = scratchCanvas;
      }
      if (!sync && typeof source.toBlob === "function") {
        // WebP keeps a flat-colour game screen to a couple of kilobytes.
        source.toBlob((blob) => done(blob || null), "image/webp", 0.85);
        return;
      }
      done(dataUrlToBlob(source.toDataURL("image/webp", 0.85)));
    } catch {
      // A canvas holding cross-origin pixels is tainted and throws — skip it.
      done(null);
    }
  };

  /** data URL → Blob, in memory — the sync capture path and legacy replay. */
  const dataUrlToBlob = (dataUrl) => {
    try {
      const comma = dataUrl.indexOf(",");
      if (comma < 0) return null;
      const header = dataUrl.slice(0, comma);
      const payload = dataUrl.slice(comma + 1);
      const mime = (/^data:([^;,]+)/.exec(header) || [])[1] || "image/webp";
      if (header.indexOf(";base64") >= 0) {
        const binary = atob(payload);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return new Blob([bytes], { type: mime });
      }
      return new Blob([decodeURIComponent(payload)], { type: mime });
    } catch {
      return null;
    }
  };

  /**
   * A frame's identity for change detection: size plus FNV-1a over the encoded
   * bytes. Encoded image data is high-entropy, so byte-identical digests mean
   * byte-identical frames for any practical purpose — and it needs no
   * SubtleCrypto, which an opaque-origin frame doesn't have.
   */
  const blobDigest = async (blob) => {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let hash = 0x811c9dc5;
      for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 0x01000193);
      }
      return blob.size + ":" + (hash >>> 0).toString(16);
    } catch {
      return null;
    }
  };

  const sampleCanvases = (sync, idle) => {
    let canvases;
    try {
      canvases = document.querySelectorAll("canvas");
    } catch {
      return;
    }
    for (const canvas of canvases) {
      const now = Date.now();
      // A quiet app is probed, not filmed: with no animation or input signal,
      // a canvas only re-attempts at the keepalive rate (catching the odd draw
      // made outside rAF and input handlers), and the byte-identical check
      // below discards probes that found nothing new.
      if (
        idle &&
        now - (canvasLastAttemptAt.get(canvas) || 0) < CANVAS_KEEPALIVE_MS
      ) {
        continue;
      }
      // The video path, wherever the codec probe granted one. Still resolving
      // (a few frames at most) skips rather than committing this canvas to
      // stills for the whole recording. A canvas whose encoder errored falls
      // through to stills for good. The stop-time sync capture is stills-only:
      // video canvases are closed out by the encoder drain instead.
      if (videoMode === undefined && videoCodecProbe) continue;
      const stream = videoStreams.get(canvas);
      if (videoMode && !(stream && stream.errored)) {
        if (sync) continue;
        canvasLastAttemptAt.set(canvas, now);
        feedVideoFrame(canvas);
        continue;
      }
      // One capture in flight per canvas: a frame that lands while the
      // previous one is still encoding is skipped, not queued, so on a machine
      // where encoding is slower than the display rate the capture rate backs
      // off by itself instead of stacking encodes. The stop-time sync capture
      // bypasses the gate — any in-flight encode it overlaps can only complete
      // after the recording gate has closed, where its late push is discarded.
      if (!sync && canvasCaptureBusy.has(canvas)) continue;
      canvasLastAttemptAt.set(canvas, now);
      if (!sync) canvasCaptureBusy.add(canvas);
      captureCanvas(canvas, sync, (blob) => {
        canvasCaptureBusy.delete(canvas);
        if (!blob) return;
        const sel = selectorFor(canvas).slice(0, 1000);
        if (sync) {
          // The final frame cannot wait for an async digest; a possible
          // duplicate of the last pushed frame is harmless.
          push({ kind: "canvas", sel, blob });
          return;
        }
        blobDigest(blob).then((digest) => {
          if (digest && canvasLastFrame.get(canvas) === digest) return;
          if (digest) canvasLastFrame.set(canvas, digest);
          push({ kind: "canvas", sel, blob });
        });
      });
    }
  };

  /**
   * The per-presented-frame sampling loop, alive only while recording. Runs on
   * the browser's own frame clock so captures line up with what the viewer was
   * actually shown, and pause with the tab. The activity flag is consumed each
   * frame: an app animating via rAF re-sets it every frame it schedules, so
   * "active" decays the moment the app's loop stops.
   */
  const canvasCaptureLoop = () => {
    if (!recording) {
      canvasRafId = null;
      return;
    }
    canvasRafId = origRaf(canvasCaptureLoop);
    const idle = !appRafScheduled && Date.now() >= inputActivityUntil;
    appRafScheduled = false;
    sampleCanvases(false, idle);
  };

  /**
   * DOM changes, as the smallest re-renderable unit: the changed element's own
   * markup for structure and text, a single value for an attribute.
   */
  let domObserver = null;
  const startDomCapture = () => {
    if (typeof MutationObserver !== "function") return;
    domObserver = new MutationObserver((records) => {
      // One emission per element per batch — a burst of text changes inside the
      // same node is one new innerHTML, not twenty.
      const html = new Set();
      for (const record of records) {
        try {
          if (record.type === "attributes") {
            const el = record.target;
            if (!el || el.nodeType !== 1) continue;
            push({
              kind: "dom",
              op: "attr",
              sel: selectorFor(el).slice(0, 1000),
              name: record.attributeName,
              value: el.getAttribute(record.attributeName),
            });
          } else {
            const el =
              record.target.nodeType === 1
                ? record.target
                : record.target.parentElement;
            if (el) html.add(el);
          }
        } catch {
          // a single unreadable record must never stop the capture
        }
      }
      for (const el of html) {
        try {
          push({
            kind: "dom",
            op: "html",
            sel: selectorFor(el).slice(0, 1000),
            html: el.innerHTML,
          });
        } catch {}
      }
    });
    try {
      domObserver.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      domObserver = null;
    }
  };


  /**
   * The app's LIVE DOM the instant recording starts — the true seed for the
   * replay's first frame.
   *
   * Replay otherwise begins from the served SOURCE html (segment 0), which is
   * the app BEFORE its own code ran. But the app has always already run by the
   * time a recording starts: it rendered on load, and its intro/onboarding may
   * long since have been dismissed. None of that is a mutation the observer can
   * see after the fact, so without this the replay opens on a screen the session
   * never showed — an app frozen behind an intro the user had already skipped —
   * and only catches up if the app happens to re-render that region later.
   *
   * Sent through the event channel as a control the host consumes to seed the
   * segment; it is never stored as a timeline event. `outerHTML` carries the
   * injected SDK envelope (kept alive through replay's script neutralization)
   * and the app's live markup; canvas pixels aren't serializable this way and
   * are seeded separately by {@link sampleCanvases}.
   */
  const captureInitialDom = () => {
    try {
      push({
        kind: "snapshot",
        html: "<!doctype html>\n" + document.documentElement.outerHTML,
      });
    } catch {
      // A recording with no initial snapshot still replays from the source html.
    }
  };

  const startRecording = () => {
    if (recording) return;
    recording = true;
    buffer = [];
    // A fresh take starts at base quality: governor pressure earned by the
    // previous take's content says nothing about this one's.
    videoGovernorQp = 0;
    videoGovernorAdjustedAt = 0;
    videoRateWindow.length = 0;
    push({
      kind: "viewport",
      width: window.innerWidth,
      height: window.innerHeight,
    });
    // Seed the first replay frame from what is on screen now, before wiring up
    // the observers that capture everything after.
    captureInitialDom();
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    // What the app becomes, alongside what is done to it. The codec probe
    // resolves the capture mode (encoded video vs WebP stills) within a few
    // frames; the seed sample is unconditional (idle apps still show their
    // first frame); the loop then captures at presented-frame rate while the
    // app is active.
    probeVideoCodec();
    startDomCapture();
    sampleCanvases();
    canvasRafId = origRaf(canvasCaptureLoop);

    listen(window, "resize", () => {
      push({
        kind: "viewport",
        width: window.innerWidth,
        height: window.innerHeight,
      });
    });
    listen(
      document,
      "mousemove",
      (e) => {
        const now = Date.now();
        if (now - lastMoveTs < MOVE_SAMPLE_MS) return;
        lastMoveTs = now;
        push({
          kind: "pointer",
          type: "move",
          x: e.clientX,
          y: e.clientY,
          ...targetAnchor(e),
        });
      },
      true,
    );
    const pointerHandler = (type) => (e) => {
      push({
        kind: "pointer",
        type,
        x: e.clientX,
        y: e.clientY,
        button: e.button,
        ...targetAnchor(e),
      });
    };
    listen(document, "mousedown", pointerHandler("down"), true);
    listen(document, "mouseup", pointerHandler("up"), true);
    listen(document, "click", pointerHandler("click"), true);
    // Whether a node is a text-editable field — used to keep raw keystrokes
    // out of the recording (their effect is reproduced from the committed
    // input value instead, which is redacted for secret fields).
    const isEditableTarget = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const tag = el.tagName;
      if (tag === "TEXTAREA") return true;
      if (el.isContentEditable) return true;
      if (tag !== "INPUT") return false;
      const type = (el.type || "text").toLowerCase();
      return type !== "checkbox" && type !== "radio" && type !== "button";
    };
    const keyHandler = (type) => (e) => {
      // Never record the literal characters typed into an editable field: for
      // a printable key `e.key`/`e.code` are the character itself, so logging
      // them would leak a password one keystroke at a time and defeat the
      // value-level mask below. Replay reproduces text entry from the
      // (redacted) committed value, not from synthetic key events — so only
      // control keys (Enter/Tab/Escape/arrows) and modifier chords
      // (Ctrl/Cmd/Alt shortcuts) need recording here.
      const printable = String(e.key).length === 1;
      const modifierChord = e.ctrlKey || e.metaKey || e.altKey;
      if (printable && !modifierChord && isEditableTarget(e.target)) return;
      push({
        kind: "key",
        type,
        key: String(e.key).slice(0, 32),
        code: String(e.code).slice(0, 64),
        alt: e.altKey || undefined,
        ctrl: e.ctrlKey || undefined,
        meta: e.metaKey || undefined,
        shift: e.shiftKey || undefined,
      });
    };
    listen(document, "keydown", keyHandler("down"), true);
    listen(document, "keyup", keyHandler("up"), true);
    // A field is treated as secret when its type is `password`, or when its
    // type/name/id/autocomplete hints at a credential — so a reveal-password
    // toggle (which flips type to `text`) and secret-bearing text fields
    // (API keys, OTP codes, card numbers) are masked too, not just literal
    // password inputs.
    const SECRET_HINT = /pass|secret|token|otp|one-?time|cvc|cvv|card|ssn|pin\b|credential|private[-_]?key/i;
    const isSecretField = (el) => {
      if ((el.type || "").toLowerCase() === "password") return true;
      const hint =
        (el.getAttribute("autocomplete") || "") +
        " " +
        (el.getAttribute("name") || "") +
        " " +
        (el.id || "");
      return SECRET_HINT.test(hint);
    };
    // Committed control values — replay sets these directly, so text entry
    // reproduces even though synthetic key events cannot type.
    const valueHandler = (e) => {
      const el = e.target;
      if (!el || !el.tagName) return;
      const tag = el.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
      const entry = { kind: "input", selector: selectorFor(el).slice(0, 1000) };
      if (el.type === "checkbox" || el.type === "radio") {
        entry.checked = !!el.checked;
      } else {
        let value = String(el.value == null ? "" : el.value);
        // never capture secrets: a secret field records only a length mask
        if (isSecretField(el)) {
          value = "•".repeat(Math.min(value.length, 32));
        }
        entry.value = value.slice(0, 20000);
      }
      push(entry);
    };
    listen(document, "input", valueHandler, true);
    listen(document, "change", valueHandler, true);
    listen(
      document,
      "scroll",
      (e) => {
        const now = Date.now();
        if (now - lastScrollTs < SCROLL_SAMPLE_MS) return;
        lastScrollTs = now;
        const target = e.target;
        if (
          target === document ||
          target === document.documentElement ||
          target === document.body
        ) {
          push({
            kind: "scroll",
            selector: null,
            x: window.scrollX,
            y: window.scrollY,
          });
        } else if (target && target.nodeType === 1) {
          push({
            kind: "scroll",
            selector: selectorFor(target).slice(0, 1000),
            x: target.scrollLeft,
            y: target.scrollTop,
          });
        }
      },
      true,
    );
  };

  const stopRecording = () => {
    if (!recording) return;
    // One last look before the gate closes, so the recording ends on the frame
    // the app actually finished on rather than a sample interval short of it.
    // Synchronous: an async capture would land after the gate closed and be
    // discarded. Video canvases are handled by the encoder drain below — their
    // last sampled frame is already in the encoder.
    sampleCanvases(true);
    recording = false;
    drainVideoStreams();
    for (const fn of teardownFns) {
      try {
        fn();
      } catch {
        // teardown is best-effort
      }
    }
    teardownFns = [];
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (canvasRafId != null) {
      origCancelRaf(canvasRafId);
      canvasRafId = null;
    }
    if (domObserver) {
      // One last look, so the final frame and the last DOM change are in the
      // recording rather than a sample interval short of it.
      try {
        domObserver.disconnect();
      } catch {}
      domObserver = null;
    }
    flush();
  };

  // ── replay driver ──
  // The replayed pointer is an arrow, drawn as a white silhouette over a dark
  // outline — the way the player draws its own cursor glyphs, and the way the
  // OS draws the real one. A coloured dot reads as a recording light rather
  // than as the mouse, and a themed accent would disappear against the
  // background of whichever app is replaying; white over dark carries on all
  // of them. The viewBox is 1:1 with the rendered pixels, so the tip sits at
  // exactly (1,1) — that offset is the hotspot, and the transform origin, so
  // the point stays on the recorded coordinate through the press scale.
  const CURSOR_HOTSPOT = 1;
  let cursorEl = null;
  const ensureCursor = () => {
    if (cursorEl && cursorEl.isConnected) return cursorEl;
    cursorEl = document.createElement("div");
    cursorEl.setAttribute("aria-hidden", "true");
    cursorEl.style.cssText =
      "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;" +
      "transform-origin:1px 1px;transition:transform 60ms linear;" +
      "filter:drop-shadow(0 1px 3px rgba(0,0,0,.45));" +
      "transform:translate(-9999px,-9999px)";
    cursorEl.innerHTML =
      '<svg width="16" height="21" viewBox="0 0 16 21" style="display:block">' +
      '<path d="M1 1 L1 17.2 L5.1 13.4 L7.9 19.4 L10.9 18 L8.1 12.1 L14.2 12.1 Z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    (document.body || document.documentElement).appendChild(cursorEl);
    return cursorEl;
  };
  let cursorX = -9999;
  let cursorY = -9999;
  let cursorDown = false;
  const paintCursor = () => {
    ensureCursor().style.transform =
      "translate(" +
      (cursorX - CURSOR_HOTSPOT) +
      "px," +
      (cursorY - CURSOR_HOTSPOT) +
      "px)" +
      (cursorDown ? " scale(.85)" : "");
  };
  const moveCursor = (x, y) => {
    cursorX = x;
    cursorY = y;
    paintCursor();
  };
  // The ripple below already says that a click happened, so the arrow only
  // dips under the press the way a real cursor appears to.
  const pressCursor = (down) => {
    cursorDown = down;
    paintCursor();
  };
  // A click has no visible effect when the app doesn't change on click, so the
  // replay would look inert. Paint a short expanding ring at the click point
  // so viewers can see where — and that — a click happened. Best-effort and
  // self-removing; never blocks the app.
  const spawnClickRipple = (x, y) => {
    try {
      const ripple = document.createElement("div");
      ripple.setAttribute("aria-hidden", "true");
      ripple.style.cssText =
        "position:fixed;left:" +
        (x - 8) +
        "px;top:" +
        (y - 8) +
        "px;width:16px;height:16px;border-radius:50%;" +
        "border:2px solid rgba(37,99,235,.8);box-sizing:border-box;" +
        "z-index:2147483646;pointer-events:none;opacity:.9;" +
        "transition:transform 420ms ease-out,opacity 420ms ease-out;" +
        "transform:scale(.4)";
      (document.body || document.documentElement).appendChild(ripple);
      requestAnimationFrame(() => {
        ripple.style.transform = "scale(2.6)";
        ripple.style.opacity = "0";
      });
      setTimeout(() => ripple.remove(), 480);
    } catch {
      // click affordance is best-effort
    }
  };
  // React and friends patch value setters on instances; going through the
  // prototype's native setter makes the framework see the change.
  const nativeSet = (el, prop, value) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el),
        prop,
      );
      if (desc && desc.set) {
        desc.set.call(el, value);
        return;
      }
    } catch {
      // fall through to direct assignment
    }
    el[prop] = value;
  };
  // Replay drives the app with synthetic events, and two kinds of chrome can
  // never be reproduced that way — documented limits, not bugs to chase: a
  // native <select>/date-picker popup only opens for a *trusted* gesture, and
  // the CSS :hover state follows the real hardware pointer, which never moved.
  // What IS reproducible is every DOM-based control — but a modern component
  // library (Radix/shadcn and friends) opens its menus on Pointer events, so
  // replay emits pointerdown/up/move next to the mouse events, and synthesizes
  // the over/out crossing so an app's (or React's) hover handlers fire.
  let hoverTarget = null;
  const PointerCtor = typeof PointerEvent === "function" ? PointerEvent : null;
  const POINTER_INIT = { pointerId: 1, pointerType: "mouse", isPrimary: true };
  const dispatchAt = (Ctor, target, type, x, y, button, extra) => {
    if (!target) return;
    try {
      target.dispatchEvent(
        new Ctor(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button: button || 0,
          ...extra,
        }),
      );
    } catch {
      // dispatch is best-effort
    }
  };
  // Fire a pointer event (when the constructor exists) paired with its mouse
  // event at (x, y), so both Pointer- and Mouse-based components respond.
  const dispatchPointerAndMouse = (pointerType, mouseType, x, y, button) => {
    const target =
      document.elementFromPoint(x, y) ||
      document.body ||
      document.documentElement;
    if (!target) return null;
    if (PointerCtor && pointerType) {
      dispatchAt(PointerCtor, target, pointerType, x, y, button, POINTER_INIT);
    }
    if (mouseType) dispatchAt(MouseEvent, target, mouseType, x, y, button);
    return target;
  };
  // Synthesize the hover crossing when the element under the cursor changes:
  // out on the element left, over on the one entered. Both bubble, so React
  // derives onMouseEnter/onPointerEnter from them — that is what makes
  // JS-driven hover menus and highlights appear in replay. (Pure CSS :hover
  // still won't: it follows the real pointer, which never moved.)
  const updateHover = (x, y, target) => {
    if (target === hoverTarget) return;
    const from = hoverTarget;
    hoverTarget = target;
    const cross = (el, type, related) => {
      if (!el) return;
      if (PointerCtor) {
        dispatchAt(PointerCtor, el, "pointer" + type, x, y, 0, {
          ...POINTER_INIT,
          relatedTarget: related,
        });
      }
      dispatchAt(MouseEvent, el, "mouse" + type, x, y, 0, {
        relatedTarget: related,
      });
    };
    cross(from, "out", target);
    cross(target, "over", from);
  };
  // A native <select> popup is OS chrome and never opens from a synthetic
  // event, so a recorded "open the dropdown, pick an option" plays back inert.
  // Draw a stand-in option list instead: open it when a replayed click lands
  // on a <select>, highlight the chosen option when the value change replays,
  // then dismiss it. The stand-in is pointer-events:none and aria-hidden, so
  // it can never affect the app or be hit by elementFromPoint.
  let selectMenu = null; // { el, node, timer }
  const closeSelectMenu = () => {
    if (!selectMenu) return;
    clearTimeout(selectMenu.timer);
    if (selectMenu.node) selectMenu.node.remove();
    selectMenu = null;
  };
  const solidBackground = (el) => {
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) {
        return bg;
      }
      node = node.parentElement;
    }
    return null;
  };
  const openSelectMenu = (select) => {
    try {
      if (!select || select.disabled || select.multiple || select.size > 1) {
        return;
      }
      if (!select.options || select.options.length === 0) return;
      closeSelectMenu();
      const cs = getComputedStyle(select);
      const fg = cs.color || "#111";
      const bg = solidBackground(select) || "#ffffff";
      const rect = select.getBoundingClientRect();
      const node = document.createElement("div");
      node.setAttribute("aria-hidden", "true");
      // Set as properties, not as one concatenated `cssText`: several of these
      // values come from the app's own computed style, and a declaration that
      // is built by string-joining is one stray `;` away from meaning
      // something else entirely. A property setter cannot escape its own
      // declaration.
      Object.assign(node.style, {
        position: "fixed",
        left: rect.left + "px",
        top: rect.bottom + "px",
        minWidth: rect.width + "px",
        maxHeight: "260px",
        overflow: "hidden",
        boxSizing: "border-box",
        zIndex: "2147483640",
        pointerEvents: "none",
        background: bg,
        color: fg,
        border: "1px solid rgba(128,128,128,.4)",
        borderRadius: "6px",
        boxShadow: "0 8px 24px rgba(0,0,0,.35)",
        padding: "4px 0",
        fontSize: cs.fontSize || "13px",
        fontFamily: cs.fontFamily || "system-ui,sans-serif",
      });
      for (const opt of Array.from(select.options)) {
        const item = document.createElement("div");
        item.textContent = opt.label || opt.textContent || opt.value || "";
        item.setAttribute("data-value", opt.value);
        Object.assign(item.style, {
          padding: "6px 12px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          background: opt.value === select.value ? "#2563eb" : "",
          color: opt.value === select.value ? "#fff" : "",
        });
        node.appendChild(item);
      }
      (document.body || document.documentElement).appendChild(node);
      // Flip above the control if the list would overflow the viewport bottom.
      const h = node.getBoundingClientRect().height;
      if (rect.bottom + h > window.innerHeight && rect.top - h > 0) {
        node.style.top = rect.top - h + "px";
      }
      // Safety dismissal so a dropdown whose selection is never replayed
      // (opened, then clicked away) doesn't linger.
      const timer = setTimeout(closeSelectMenu, 2500);
      selectMenu = { el: select, node, timer };
    } catch {
      // stand-in dropdown is best-effort
    }
  };
  // The value change landed: highlight the picked option, then dismiss.
  const resolveSelectMenu = (select) => {
    if (!selectMenu || selectMenu.el !== select) return;
    try {
      for (const item of Array.from(selectMenu.node.children)) {
        const on = item.getAttribute("data-value") === select.value;
        item.style.background = on ? "#2563eb" : "";
        item.style.color = on ? "#fff" : "";
      }
      clearTimeout(selectMenu.timer);
      selectMenu.timer = setTimeout(closeSelectMenu, 450);
    } catch {
      closeSelectMenu();
    }
  };
  // Re-anchor a recorded pointer event in the current layout. The replayed
  // app lays out at the player's own viewport — never the recorded one — so
  // the recorded target element is re-resolved and the pointer aimed at the
  // same spot within it. An interaction whose target sits outside this
  // viewport scrolls it into view first (the recorded session's visible area,
  // brought on screen as needed). Events without an anchor (older recordings)
  // fall back to their raw coordinates.
  const resolveReplayPoint = (event) => {
    const fallback = { x: event.x, y: event.y };
    if (!event.selector) return fallback;
    try {
      const el = document.querySelector(event.selector);
      if (!el) return fallback;
      let rect = el.getBoundingClientRect();
      const offscreen =
        rect.bottom < 0 ||
        rect.right < 0 ||
        rect.top > window.innerHeight ||
        rect.left > window.innerWidth;
      // Only interactions pull their target into view; a passing move just
      // tracks it (scrolling on every hover sample would thrash the page).
      if (offscreen && (event.type === "down" || event.type === "click")) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        rect = el.getBoundingClientRect();
      }
      const ox =
        typeof event.ox === "number"
          ? Math.max(0, Math.min(event.ox, rect.width))
          : rect.width / 2;
      const oy =
        typeof event.oy === "number"
          ? Math.max(0, Math.min(event.oy, rect.height))
          : rect.height / 2;
      return { x: rect.left + ox, y: rect.top + oy };
    } catch {
      return fallback;
    }
  };

  const applyReplayEvent = (event) => {
    try {
      if (event.kind === "pointer") {
        const point = resolveReplayPoint(event);
        moveCursor(point.x, point.y);
        if (event.type === "move") {
          const target = dispatchPointerAndMouse(
            "pointermove",
            "mousemove",
            point.x,
            point.y,
            0,
          );
          updateHover(point.x, point.y, target);
        } else if (event.type === "down") {
          pressCursor(true);
          spawnClickRipple(point.x, point.y);
          const downTarget = dispatchPointerAndMouse(
            "pointerdown",
            "mousedown",
            point.x,
            point.y,
            event.button,
          );
          // A click on a native <select> opens the stand-in option list.
          const select =
            downTarget && downTarget.closest
              ? downTarget.closest("select")
              : null;
          if (select) openSelectMenu(select);
        } else if (event.type === "up") {
          pressCursor(false);
          dispatchPointerAndMouse(
            "pointerup",
            "mouseup",
            point.x,
            point.y,
            event.button,
          );
        } else if (event.type === "click") {
          // Read-only replay must never move REAL focus into the frame: the
          // host keeps keyboard focus so viewer keystrokes drive the player,
          // not the app (a focused button would otherwise eat Space/Enter).
          // The synthetic click alone reproduces the app's click behavior.
          dispatchPointerAndMouse(
            null,
            "click",
            point.x,
            point.y,
            event.button,
          );
        }
      } else if (event.kind === "key") {
        const target = document.activeElement || document.body || document;
        target.dispatchEvent(
          new KeyboardEvent(event.type === "down" ? "keydown" : "keyup", {
            bubbles: true,
            cancelable: true,
            key: event.key,
            code: event.code,
            altKey: !!event.alt,
            ctrlKey: !!event.ctrl,
            metaKey: !!event.meta,
            shiftKey: !!event.shift,
          }),
        );
      } else if (event.kind === "input") {
        const el = event.selector
          ? document.querySelector(event.selector)
          : null;
        if (!el) return;
        // Value is committed via the native setter + input/change below; no
        // real focus() — the read-only frame must not hold keyboard focus.
        if (typeof event.checked === "boolean") {
          nativeSet(el, "checked", event.checked);
        } else if (typeof event.value === "string") {
          nativeSet(el, "value", event.value);
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        // Land the selection in the stand-in dropdown, if one is open.
        if (el.tagName === "SELECT") resolveSelectMenu(el);
      } else if (event.kind === "scroll") {
        if (event.selector) {
          const el = document.querySelector(event.selector);
          if (el) {
            el.scrollLeft = event.x;
            el.scrollTop = event.y;
          }
        } else {
          window.scrollTo(event.x, event.y);
        }
      }
      // viewport/mcp/segment events are handled host-side.
    } catch {
      // replay is best-effort; never break the app
    }
  };

  // ── Pause freeze: while the replay is paused, halt the app's own motion so
  // nothing keeps moving inside the frame. CSS animations/transitions pause via
  // an injected style; requestAnimationFrame, setTimeout, and setInterval
  // callbacks are held and re-armed on resume with the time they had left, so
  // rAF-, timeout-, and interval-driven motion all freeze.
  let replayFrozen = false;
  let freezeStyleEl = null;
  const rafQueue = [];
  const origRaf = window.requestAnimationFrame.bind(window);
  const origCancelRaf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    // An app scheduling animation frames is the record-side sampler's cue that
    // pixels are moving (the sampler itself uses origRaf, so it never counts).
    appRafScheduled = true;
    if (replayFrozen) {
      rafQueue.push(cb);
      return 0;
    }
    return origRaf(cb);
  };


  // Virtual-clock timers: track each so it can be cancelled on pause and
  // re-armed on resume with its remaining delay, rather than firing while
  // frozen. Fake ids start high to avoid colliding with native timer ids.
  const nowMs = () =>
    window.performance && performance.now ? performance.now() : Date.now();
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);
  const timers = new Map();
  let nextTimerId = 900719925;
  const armTimer = (id, rec) => {
    rec.dueAt = nowMs() + rec.remaining;
    const fire = () => {
      if (rec.kind === "interval") {
        rec.remaining = rec.period;
        rec.dueAt = nowMs() + rec.period;
        rec.realId = origSetTimeout(fire, rec.period);
      } else {
        timers.delete(id);
      }
      try {
        rec.cb.apply(undefined, rec.args);
      } catch (_) {}
    };
    rec.realId = origSetTimeout(fire, rec.remaining);
  };
  window.setTimeout = function (cb) {
    if (typeof cb !== "function")
      return origSetTimeout.apply(window, arguments);
    const id = ++nextTimerId;
    const rec = {
      kind: "timeout",
      cb,
      args: Array.prototype.slice.call(arguments, 2),
      remaining: Math.max(0, +arguments[1] || 0),
    };
    timers.set(id, rec);
    if (!replayFrozen) armTimer(id, rec);
    return id;
  };
  window.setInterval = function (cb) {
    if (typeof cb !== "function")
      return origSetInterval.apply(window, arguments);
    const id = ++nextTimerId;
    const period = Math.max(4, +arguments[1] || 0);
    const rec = {
      kind: "interval",
      cb,
      args: Array.prototype.slice.call(arguments, 2),
      remaining: period,
      period,
    };
    timers.set(id, rec);
    if (!replayFrozen) armTimer(id, rec);
    return id;
  };
  window.clearTimeout = (id) => {
    const rec = timers.get(id);
    if (rec) {
      if (rec.realId != null) origClearTimeout(rec.realId);
      timers.delete(id);
    } else origClearTimeout(id);
  };
  window.clearInterval = (id) => {
    const rec = timers.get(id);
    if (rec) {
      if (rec.realId != null) origClearTimeout(rec.realId);
      timers.delete(id);
    } else origClearInterval(id);
  };

  // Canvas frames decode asynchronously — an <img> fed a data URL, decoded on
  // the browser's own thread pool with no ordering guarantee — so a frame drawn
  // "when it loads" is drawn in decode-completion order, not the order the host
  // dispatched it. A heavier frame sent earlier can finish after a lighter one
  // sent later, land on top of it, and leave the canvas showing the OLDER frame:
  // the replay flickers backwards and can settle on the first-generated object
  // instead of the last. So every paint is stamped with its dispatch order (the
  // host posts them in timeline order, and postMessage preserves that order into
  // this frame), and a frame that finishes decoding after a later-dispatched
  // frame has already painted its canvas is dropped. A remount hands us a new
  // canvas element, whose absent WeakMap entry restarts the guard cleanly.
  const canvasPaintSeq = new WeakMap();
  let nextPaintSeq = 0;

  /**
   * Put a recorded piece of the app's output back on screen.
   *
   * The replayed document runs none of the app's own code, so nothing here is
   * competing with a live app: these ARE the app, played back. A step that
   * cannot be applied is skipped rather than allowed to stop the replay — one
   * missing element must not cost every frame after it.
   */
  /**
   * Size the canvas's bitmap to the recorded frame and paint it. Sizing
   * matters because replay serves the app's SOURCE html and never runs its
   * code: a canvas the app sized in its own JS is still at the HTML default
   * 300x150 here, so drawing a full frame into it would squeeze the whole app
   * down to a thumbnail while the markup around it stayed full size.
   * Assigning width resets the bitmap, so only on an actual change.
   */
  const drawFrameToCanvas = (canvas, frame, width, height) => {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  };

  // ── Encoded video playback: one VideoDecoder per recorded stream, keyed by
  // the stream's canvas selector. A config event (re)opens the stream — the
  // host re-sends it on every seek, making it the decoder-reset point — and
  // chunks decode in the order the host posts them. Decoded frames share the
  // stills' paint-order guard, so a stale still can never overwrite a newer
  // video frame or vice versa.
  const videoPlayback = new Map();
  const openVideoPlaybackStream = (event) => {
    try {
      if (typeof VideoDecoder !== "function") return;
      const existing = videoPlayback.get(event.sel);
      if (existing) {
        try {
          existing.decoder.close();
        } catch {}
      }
      const sel = event.sel;
      const state = { decoder: null, sawKey: false };
      state.decoder = new VideoDecoder({
        output: (frame) => {
          try {
            const canvas = document.querySelector(sel);
            if (canvas && canvas.getContext) {
              const seq = ++nextPaintSeq;
              const drawnSeq = canvasPaintSeq.get(canvas);
              if (drawnSeq === undefined || seq > drawnSeq) {
                canvasPaintSeq.set(canvas, seq);
                drawFrameToCanvas(
                  canvas,
                  frame,
                  frame.displayWidth || frame.codedWidth,
                  frame.displayHeight || frame.codedHeight,
                );
              }
            }
          } catch {}
          frame.close();
        },
        error: () => {
          // a broken stream shows its last good frame; never break the replay
        },
      });
      const config = {
        codec: event.codec,
        codedWidth: event.codedWidth,
        codedHeight: event.codedHeight,
        optimizeForLatency: true,
      };
      if (event.description) {
        config.description =
          event.description instanceof Uint8Array
            ? event.description
            : new Uint8Array(event.description);
      }
      state.decoder.configure(config);
      videoPlayback.set(sel, state);
    } catch {}
  };
  /**
   * Emit everything a stream's decoder still holds. Sent by the host after a
   * rebuild burst (seek, poster): the burst is fed to a fresh decoder and then
   * stops, and a decoder may hold decoded frames until more input or a flush
   * arrives — without this a backward seek painted nothing at all. Flushing
   * reimposes the decoder's key-chunk requirement, so the key gate re-arms:
   * continuation deltas are skipped until the next keyframe.
   */
  const flushVideoPlayback = (event) => {
    try {
      const state = videoPlayback.get(event.sel);
      if (!state || state.decoder.state !== "configured") return;
      state.sawKey = false;
      state.decoder.flush().catch(() => {});
    } catch {}
  };
  const feedVideoPlaybackChunk = (event) => {
    try {
      const state = videoPlayback.get(event.sel);
      if (!state || state.decoder.state !== "configured") return;
      // Deltas before the stream's first keyframe are undecodable — a decoder
      // fed one errors out and takes the rest of the stream with it.
      if (!state.sawKey) {
        if (event.type !== "key") return;
        state.sawKey = true;
      }
      if (!(event.bytes instanceof Uint8Array)) return;
      state.decoder.decode(
        new EncodedVideoChunk({
          type: event.type === "key" ? "key" : "delta",
          timestamp: event.tsUs || 0,
          data: event.bytes,
        }),
      );
    } catch {}
  };

  const paintRecordedOutput = (event) => {
    try {
      if (event.kind === "video-config") {
        openVideoPlaybackStream(event);
        return;
      }
      if (event.kind === "video-chunk") {
        feedVideoPlaybackChunk(event);
        return;
      }
      if (event.kind === "video-flush") {
        flushVideoPlayback(event);
        return;
      }
      if (event.kind === "canvas") {
        const canvas = document.querySelector(event.sel);
        if (!canvas || !canvas.getContext) return;
        // Stamp the dispatch order now, synchronously, before the async decode
        // reorders things — this is the frame's true position in the timeline.
        const seq = ++nextPaintSeq;
        // Frames arrive as Blobs; `data` strings only from a bundle written by
        // an older recorder.
        const blob =
          event.blob instanceof Blob
            ? event.blob
            : typeof event.data === "string"
              ? dataUrlToBlob(event.data)
              : null;
        if (!blob) return;
        createImageBitmap(blob)
          .then((bitmap) => {
            try {
              // A later-dispatched frame already won this canvas while this
              // one was decoding: its pixels are the more recent truth, so
              // this stale frame is dropped rather than allowed to overwrite
              // them.
              const drawnSeq = canvasPaintSeq.get(canvas);
              if (drawnSeq !== undefined && drawnSeq > seq) {
                bitmap.close();
                return;
              }
              canvasPaintSeq.set(canvas, seq);
              drawFrameToCanvas(canvas, bitmap, bitmap.width, bitmap.height);
              bitmap.close();
            } catch {}
          })
          .catch(() => {});
        return;
      }
      if (event.kind === "dom") {
        const el = document.querySelector(event.sel);
        if (!el) return;
        if (event.op === "attr") {
          // An `on*` attribute is code, not state: restoring one would arm a
          // handler in a replay whose whole premise is that the app does not
          // run again.
          if (isHandlerAttr(event.name)) return;
          if (event.value === null || event.value === undefined) {
            el.removeAttribute(event.name);
          } else {
            el.setAttribute(event.name, event.value);
          }
        } else if (typeof event.html === "string") {
          el.replaceChildren(inertMarkup(event.html, el));
        }
      }
    } catch {
      // best effort, always
    }
  };

  const isHandlerAttr = (name) =>
    typeof name === "string" && /^on/i.test(name);

  /**
   * Parse recorded markup into an inert fragment, in the target element's own
   * parsing context, with anything that would run removed.
   *
   * A replay shows what the app produced; it must never run the app a second
   * time. Script elements are re-typed before the document loads, but a DOM
   * snapshot taken mid-session can still carry inline handlers — and an
   * `onerror` on a broken image needs no interaction at all to fire. So the
   * markup is parsed inside the template element's OWNER DOCUMENT, which the
   * platform gives no browsing context: nothing there loads a resource or runs
   * a handler. What it yields is then stripped of scripts and `on*` attributes
   * as a second line of defence.
   *
   * The parsing CONTEXT matters as much as its inertness. The captured html is
   * the target's own innerHTML, so its top-level nodes are bare children with no
   * wrapping tag — and the HTML fragment parser decides their namespace and
   * insertion mode from the element it is parsing INTO. Parse `<path>`/`<rect>`
   * with a plain `<template>` and they land in the HTML namespace as
   * non-rendering unknown elements (the recorded chart replays blank); the same
   * befalls MathML (`<mrow>`/`<mi>`). Table rows and `<option>`s can be dropped
   * outright. Matching the context to the target's real namespace and tag makes
   * the parse reproduce exactly what the browser built live — SVG in the SVG
   * namespace, MathML in MathML, an HTML integration point (`foreignObject`) or
   * a `<tr>`/`<select>` in the right HTML insertion mode.
   */
  const inertMarkup = (html, contextEl) => {
    const template = document.createElement("template");
    // The template's content is owned by an inert document (no browsing
    // context); creating the parse context there keeps the whole parse inert.
    const inertDoc = template.content.ownerDocument;
    const context =
      contextEl && contextEl.namespaceURI
        ? inertDoc.createElementNS(contextEl.namespaceURI, contextEl.localName)
        : template;
    context.innerHTML = html;
    // A `<template>` keeps its parsed tree on `.content`; every other element
    // holds its children directly.
    const root = context.content || context;
    for (const node of root.querySelectorAll("script")) {
      node.remove();
    }
    for (const node of root.querySelectorAll("*")) {
      for (const attr of Array.from(node.attributes)) {
        if (isHandlerAttr(attr.name)) node.removeAttribute(attr.name);
      }
    }
    // Move the parsed children into a fragment (moving preserves each node's
    // namespace); the throwaway context element is never inserted.
    const fragment = inertDoc.createDocumentFragment();
    while (root.firstChild) fragment.appendChild(root.firstChild);
    return fragment;
  };

  const freezeReplay = () => {
    if (replayFrozen) return;
    replayFrozen = true;
    if (!freezeStyleEl) {
      freezeStyleEl = document.createElement("style");
      freezeStyleEl.textContent =
        "*,*::before,*::after{animation-play-state:paused!important;transition:none!important}";
    }
    (document.head || document.documentElement).appendChild(freezeStyleEl);
    const t = nowMs();
    timers.forEach((rec) => {
      if (rec.realId != null) {
        origClearTimeout(rec.realId);
        rec.realId = null;
        rec.remaining = Math.max(0, (rec.dueAt != null ? rec.dueAt : t) - t);
      }
    });
  };
  const unfreezeReplay = () => {
    if (!replayFrozen) return;
    replayFrozen = false;
    if (freezeStyleEl && freezeStyleEl.parentNode) freezeStyleEl.remove();
    timers.forEach((rec, id) => {
      if (rec.realId == null) armTimer(id, rec);
    });
    const queued = rafQueue.splice(0);
    for (const cb of queued) origRaf(cb);
  };

  window.addEventListener("message", (e) => {
    // Only the parent chain (the trusted host via the sandbox proxy relay)
    // may drive recording/replay.
    if (e.source !== window.parent) return;
    const data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.type === CONTROL_TYPE) {
      if (data.action === "start") startRecording();
      else if (data.action === "stop") stopRecording();
    } else if (data.type === REPLAY_TYPE) {
      if (data.action === "apply" && data.event) {
        applyReplayEvent(data.event);
      } else if (data.action === "reset") {
        if (cursorEl) {
          cursorEl.remove();
          cursorEl = null;
        }
        hoverTarget = null;
        closeSelectMenu();
        for (const state of videoPlayback.values()) {
          try {
            state.decoder.close();
          } catch {}
        }
        videoPlayback.clear();
      } else if (data.action === "paint" && data.event) {
        paintRecordedOutput(data.event);
      } else if (data.action === "pause") {
        freezeReplay();
      } else if (data.action === "resume") {
        unfreezeReplay();
      }
    }
  });

  // Announce that THIS document's replay listener exists, on the same
  // host-allow-listed channel the recorder uses. The player must not gate
  // replay delivery on the bridge connect: that can resolve against a
  // transient document (the sandbox re-delivers html while settling), and
  // paints posted then die with it — verified live as a replay frame whose
  // SDK parsed AFTER the host had already marked it ready. Every document
  // announces for itself, so the player re-delivers to whichever document
  // ends up being the one on screen.
  post({ type: EVENT_TYPE, replayReady: true });
})();
