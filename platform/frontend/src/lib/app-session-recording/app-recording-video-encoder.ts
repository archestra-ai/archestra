import {
  BufferTarget,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSample,
  VideoSampleSource,
} from "mediabunny";

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
 */
class VideoEncoderSession {
  private active: EncoderSession | null = null;

  async start(width: number, height: number, fps: number): Promise<void> {
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
      bitrate: QUALITY_HIGH,
    });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    this.active = { output, source, fps, width, height };
  }

  async encode(jpegBase64: string, index: number): Promise<void> {
    const active = this.require();
    const bitmap = await createImageBitmap(base64ToBlob(jpegBase64));
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
      bitmap.close();
    }
  }

  async finish(): Promise<string> {
    const active = this.require();
    this.active = null;
    active.source.close();
    await active.output.finalize();
    const buffer = (active.output.target as BufferTarget).buffer;
    if (!buffer) throw new Error("The encoder produced no video.");
    return bytesToBase64(new Uint8Array(buffer));
  }

  private require(): EncoderSession {
    if (!this.active) throw new Error("No render is in progress.");
    return this.active;
  }
}

const encoder = new VideoEncoderSession();

export const startEncoder = (
  width: number,
  height: number,
  fps: number,
): Promise<void> => encoder.start(width, height, fps);

export const encodeFrame = (jpegBase64: string, index: number): Promise<void> =>
  encoder.encode(jpegBase64, index);

export const finishEncoder = (): Promise<string> => encoder.finish();

// =============================================================================
// Internal helpers
// =============================================================================

interface EncoderSession {
  output: Output;
  source: VideoSampleSource;
  fps: number;
  width: number;
  height: number;
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
