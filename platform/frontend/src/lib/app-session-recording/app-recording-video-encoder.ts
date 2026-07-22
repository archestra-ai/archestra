import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  Mp4OutputFormat,
  Output,
  VideoSample,
  VideoSampleSource,
} from "mediabunny";
import type { PlaybackAudio } from "./app-recording-audio";

/**
 * Encodes rendered frames into an MP4, inside the browser that rendered them.
 *
 * The renderer captures each frame through the compositor (the only way to see
 * the sandboxed app) and hands it back here as a JPEG, because the browser is
 * also the only H.264 encoder in reach — the deployment image carries no
 * ffmpeg, and the one bundled with browser tooling is VP8-only.
 *
 * H.264 in MP4 rather than WebM: an exported demo gets pasted into Slides,
 * Keynote, PowerPoint and QuickTime, which variously refuse WebM outright or
 * gate it behind an add-on.
 *
 * Frame timestamps come from the frame INDEX, never from a clock. The renderer
 * seeks the replay to an exact millisecond per frame, so index-derived
 * timestamps make the output's timeline exactly the recording's timeline —
 * however fast or slow the machine actually rendered it.
 *
 * Frames are ENQUEUED, not awaited: `enqueue` registers the frame on an
 * internal promise chain and returns the backlog depth immediately, so the
 * renderer's next seek-and-capture overlaps this frame's decode and encode
 * instead of waiting behind it. The chain keeps samples in index order — the
 * muxer requires monotonic timestamps, and concurrent decodes would otherwise
 * finish out of order. A frame identical to the previous one arrives as
 * `repeat`: no JPEG travels and nothing is re-decoded, the retained previous
 * bitmap is simply re-added at the next timestamp (re-encoded, so the output
 * stays constant-frame-rate).
 */
class VideoEncoderSession {
  private active: EncoderSession | null = null;

  async start(params: {
    width: number;
    height: number;
    fps: number;
    /** Region to crop out of each JPEG. Absent when frames arrive pre-cropped
     * (the legacy capture path clips at the compositor). */
    crop?: { x: number; y: number; width: number; height: number };
    /** The recording's captured sound, decoded onto the export timeline. Muxed
     * as an AAC track so the video carries the original audio. Absent/null when
     * the recording was silent. */
    audio?: PlaybackAudio | null;
  }): Promise<void> {
    // One page renders one video. Silently replacing a live session would
    // finalize the newcomer and abandon the first render's output and source,
    // so a second start is refused rather than allowed to corrupt both.
    if (this.active) {
      throw new Error("A video is already being encoded on this page.");
    }
    const output = new Output({
      format: new Mp4OutputFormat(),
      target: new BufferTarget(),
    });
    const source = new VideoSampleSource({
      codec: "avc",
      bitrate: exportBitrate(params),
    });
    output.addVideoTrack(source, { frameRate: params.fps });
    // AAC for MP4 (the same compatibility reason as H.264 above — Slides,
    // Keynote, QuickTime). All tracks must be added before start(); a codec the
    // render browser can't encode just drops the audio rather than the whole
    // export.
    let audioSource: AudioSampleSource | null = null;
    if (params.audio && params.audio.channelData.length > 0) {
      try {
        audioSource = new AudioSampleSource({
          codec: "aac",
          bitrate: AUDIO_EXPORT_BITRATE,
        });
        output.addAudioTrack(audioSource);
      } catch {
        audioSource = null;
      }
    }
    await output.start();
    if (audioSource && params.audio) {
      await feedAudioTrack(audioSource, params.audio);
    }
    this.active = {
      output,
      source,
      audioSource,
      fps: params.fps,
      crop: params.crop ?? null,
      chain: Promise.resolve(),
      pending: 0,
      failure: null,
      lastBitmap: null,
    };
  }

  /** Queue a frame; returns the backlog depth (this frame included). */
  enqueue(jpegBase64: string, index: number): number {
    const active = this.require();
    this.throwFailure(active);
    active.pending++;
    active.chain = active.chain
      .then(() => encodeFrameNow(active, jpegBase64, index))
      .catch((error) => {
        active.failure ??= error;
      })
      .finally(() => {
        active.pending--;
      });
    return active.pending;
  }

  /** Queue the PREVIOUS frame again at this index — the compositor reported
   * no change, so nothing travels and nothing is decoded. */
  repeat(index: number): number {
    const active = this.require();
    this.throwFailure(active);
    active.pending++;
    active.chain = active.chain
      .then(async () => {
        if (!active.lastBitmap) {
          throw new Error("No previous frame to repeat.");
        }
        await addSample(active, active.lastBitmap, index);
      })
      .catch((error) => {
        active.failure ??= error;
      })
      .finally(() => {
        active.pending--;
      });
    return active.pending;
  }

  /** Wait out everything queued so far; rethrows a queued frame's failure. */
  async drain(): Promise<void> {
    const active = this.require();
    await active.chain;
    this.throwFailure(active);
  }

  async finish(): Promise<string> {
    const active = this.require();
    this.active = null;
    await active.chain;
    active.lastBitmap?.close();
    active.lastBitmap = null;
    if (active.failure) throw active.failure;
    active.source.close();
    active.audioSource?.close();
    await active.output.finalize();
    const buffer = (active.output.target as BufferTarget).buffer;
    if (!buffer) throw new Error("The encoder produced no video.");
    return bytesToBase64(new Uint8Array(buffer));
  }

  private require(): EncoderSession {
    if (!this.active) throw new Error("No render is in progress.");
    return this.active;
  }

  /** A queued frame's failure surfaces on the NEXT call — the renderer stops
   * within its pipeline window instead of blindly feeding a dead encoder. */
  private throwFailure(active: EncoderSession): void {
    if (active.failure) {
      throw active.failure instanceof Error
        ? active.failure
        : new Error(String(active.failure));
    }
  }
}

const encoder = new VideoEncoderSession();

export const startEncoder = (
  params:
    | {
        width: number;
        height: number;
        fps: number;
        crop?: { x: number; y: number; width: number; height: number };
        audio?: PlaybackAudio | null;
      }
    | number,
  height?: number,
  fps?: number,
): Promise<void> => {
  // Positional form: a renderer from before the queueing rework. The renderer
  // process and this page deploy separately (routinely skewed in dev, where
  // the renderer runs a built bundle while this page hot-reloads; briefly
  // skewed mid-rollout), and the old caller must keep working.
  if (typeof params === "number") {
    return encoder.start({
      width: params,
      height: Number(height),
      fps: Number(fps),
    });
  }
  return encoder.start(params);
};

export const enqueueFrame = async (
  jpegBase64: string,
  index: number,
): Promise<number> => {
  const pending = encoder.enqueue(jpegBase64, index);
  // A pre-rework renderer awaits every frame but never drains; past this
  // depth, absorb the wait here so unbounded feeding cannot pile the queue's
  // held JPEGs into memory. The reworked renderer drains long before this.
  if (pending > LEGACY_SELF_DRAIN_DEPTH) await encoder.drain();
  return pending;
};

export const repeatFrame = (index: number): number => encoder.repeat(index);

export const drainEncoder = (): Promise<void> => encoder.drain();

export const finishEncoder = (): Promise<string> => encoder.finish();

// =============================================================================
// Internal helpers
// =============================================================================

/** Where a legacy renderer's never-drained queue is absorbed instead. */
const LEGACY_SELF_DRAIN_DEPTH = 24;

/** AAC bitrate for the exported audio track — transparent for demo sound. */
const AUDIO_EXPORT_BITRATE = 128_000;
/** One second of PCM per muxed AudioSample: coarse enough to be cheap, fine
 *  enough that the encoder starts emitting early. */
const AUDIO_EXPORT_CHUNK_SEC = 1;

/**
 * Feed the whole decoded audio track into the muxer as one-second AudioSamples
 * on the shared 0-based seconds timeline (the same clock the video's index/fps
 * timestamps sit on), so audio and video line up without any fps conversion.
 * The PCM is planar Float32; each sample carries all channels for its slice.
 */
async function feedAudioTrack(
  source: AudioSampleSource,
  audio: PlaybackAudio,
): Promise<void> {
  const { channelData, numberOfChannels, sampleRate, length } = audio;
  const framesPerChunk = Math.max(
    1,
    Math.round(sampleRate * AUDIO_EXPORT_CHUNK_SEC),
  );
  for (let start = 0; start < length; start += framesPerChunk) {
    const frames = Math.min(framesPerChunk, length - start);
    const planar = new Float32Array(frames * numberOfChannels);
    for (let c = 0; c < numberOfChannels; c++) {
      planar.set(channelData[c].subarray(start, start + frames), c * frames);
    }
    const sample = new AudioSample({
      data: planar,
      format: "f32-planar",
      numberOfChannels,
      sampleRate,
      timestamp: start / sampleRate,
    });
    try {
      await source.add(sample);
    } finally {
      sample.close();
    }
  }
}

/**
 * Export bits scale with the region. mediabunny's QUALITY_HIGH preset
 * resolved to ~1.3 Mbps for a ~1.5MP frame — fine for the mostly-static chat
 * pane, visibly soft on the animating app pane. ~0.14 bits per pixel per
 * frame keeps motion crisp (~5 Mbps for the typical region at 24fps, a 30s
 * file around 20MB); the clamp bounds tiny and huge regions.
 */
const EXPORT_BITS_PER_PIXEL_FRAME = 0.14;

function exportBitrate(params: {
  width: number;
  height: number;
  fps: number;
}): number {
  return Math.min(
    10_000_000,
    Math.max(
      2_000_000,
      Math.round(
        params.width * params.height * params.fps * EXPORT_BITS_PER_PIXEL_FRAME,
      ),
    ),
  );
}

interface EncoderSession {
  output: Output;
  source: VideoSampleSource;
  /** The muxed audio track's source, or null when the recording was silent. */
  audioSource: AudioSampleSource | null;
  fps: number;
  crop: { x: number; y: number; width: number; height: number } | null;
  /** Serializes decode+encode in index order (the muxer needs monotonic
   * timestamps; concurrent decodes finish in any order). */
  chain: Promise<void>;
  /** Frames enqueued but not yet encoded — the renderer's backpressure gauge. */
  pending: number;
  failure: unknown;
  /** The last DECODED frame, retained so an unchanged frame re-adds it
   * without another JPEG round-trip. Closed on replacement and at finish. */
  lastBitmap: ImageBitmap | null;
}

async function encodeFrameNow(
  active: EncoderSession,
  jpegBase64: string,
  index: number,
): Promise<void> {
  const blob = base64ToBlob(jpegBase64);
  const bitmap = active.crop
    ? await createImageBitmap(
        blob,
        active.crop.x,
        active.crop.y,
        active.crop.width,
        active.crop.height,
      )
    : await createImageBitmap(blob);
  active.lastBitmap?.close();
  active.lastBitmap = bitmap;
  await addSample(active, bitmap, index);
}

async function addSample(
  active: EncoderSession,
  bitmap: ImageBitmap,
  index: number,
): Promise<void> {
  // mediabunny places a frame on the timeline in seconds; deriving that from
  // the index is what makes the render reproducible.
  const sample = new VideoSample(bitmap, {
    timestamp: index / active.fps,
    duration: 1 / active.fps,
  });
  try {
    await active.source.add(sample);
  } finally {
    sample.close();
  }
}

function base64ToBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}

/** Chunked so a multi-megabyte video never blows the argument limit. */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
