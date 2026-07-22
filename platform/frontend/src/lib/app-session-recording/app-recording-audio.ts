import { normalizeCuts } from "@archestra/shared";
import type { RuntimeRecordingEvent } from "./app-recording-binary";

// WebCodecs audio types aren't in the project's TS lib (and its `types`
// allowlist keeps @types/* out), so the minimal surface we use is declared here
// and the constructors are read off globalThis. AudioContext/AudioBuffer/… are
// standard lib.dom and used directly.
interface DecodedAudioFrame {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly timestamp: number;
  copyTo(
    destination: Float32Array,
    options: { planeIndex: number; format: string },
  ): void;
  close(): void;
}
interface AudioDecoderLike {
  configure(config: {
    codec: string;
    sampleRate: number;
    numberOfChannels: number;
    // Uint8Array rather than the real BufferSource: our data is always a plain
    // Uint8Array, and pinning to that (instead of lib.dom's ArrayBuffer-generic
    // BufferSource) avoids an ArrayBufferLike/ArrayBuffer mismatch at call sites
    // that never construct a SharedArrayBuffer-backed view in the first place.
    description?: Uint8Array;
  }): void;
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  close(): void;
}
type AudioDecoderCtor = new (init: {
  output: (frame: DecodedAudioFrame) => void;
  error: (error: unknown) => void;
}) => AudioDecoderLike;
type EncodedAudioChunkCtor = new (init: {
  type: string;
  timestamp: number;
  data: Uint8Array;
}) => unknown;

const AudioDecoderClass = (
  globalThis as unknown as { AudioDecoder?: AudioDecoderCtor }
).AudioDecoder;
const EncodedAudioChunkClass = (
  globalThis as unknown as { EncodedAudioChunk?: EncodedAudioChunkCtor }
).EncodedAudioChunk;

/**
 * Host-side audio for a recording — decode once, play everywhere.
 *
 * The recorder captures the app's sound as one Opus stream (`audio-config` +
 * `audio-chunk` events). Unlike the visual streams, audio is NOT posted back
 * into the sandboxed app frame on replay: the app iframe can't autoplay, and
 * the exporter can't hear it anyway. Instead this module decodes the captured
 * Opus in the player's own document into one PCM buffer laid out on the
 * COMPRESSED/cut playback timeline, so the exact same decode drives both live
 * replay (an {@link AudioPlaybackController}) and the offline video export (the
 * PCM handed to the MP4 encoder as an AAC track).
 */

/** Decoded audio laid out on the playback timeline: planar, silence-filled. */
export interface PlaybackAudio {
  sampleRate: number;
  numberOfChannels: number;
  /** Frames per channel — the whole playback duration. */
  length: number;
  /** One Float32Array per channel, aligned to the compressed playback clock. */
  channelData: Float32Array[];
}

type RuntimeAudioConfig = Extract<
  RuntimeRecordingEvent,
  { kind: "audio-config" }
>;
type RuntimeAudioChunk = Extract<
  RuntimeRecordingEvent,
  { kind: "audio-chunk" }
>;

/** Whether a recording carries any captured audio at all. */
export function recordingHasAudio(
  events: readonly RuntimeRecordingEvent[],
): boolean {
  return events.some(
    (event) => event.kind === "audio-config" || event.kind === "audio-chunk",
  );
}

/**
 * Decode the recording's Opus into PCM positioned on the playback timeline.
 *
 * Chunks carry their raw recording time `t`; each decoded frame is written at
 * `toPlaybackMs(t)` (the compressed clock the player and export both run on),
 * and frames inside a cut are dropped so a cut range plays silent rather than
 * bursting the removed audio at the collapse instant — the audio counterpart of
 * how the transcript drops cut messages. Returns null when the recording has no
 * audio or the browser can't decode it (WebCodecs absent) — callers stay silent.
 */
export async function buildPlaybackAudio(params: {
  events: readonly RuntimeRecordingEvent[];
  cuts: readonly { fromMs: number; toMs: number }[];
  /** The compressed playback duration (buildPlayback().duration). */
  durationMs: number;
  toPlaybackMs: (rawMs: number) => number;
}): Promise<PlaybackAudio | null> {
  const { events, cuts, durationMs, toPlaybackMs } = params;
  if (!AudioDecoderClass || !EncodedAudioChunkClass) return null;
  const config = events.find(
    (event): event is RuntimeAudioConfig => event.kind === "audio-config",
  );
  const chunks = events
    .filter((event): event is RuntimeAudioChunk => event.kind === "audio-chunk")
    .sort((a, b) => a.tsUs - b.tsUs);
  if (!config || chunks.length === 0) return null;

  const merged = normalizeCuts(cuts.map((cut) => ({ ...cut })));
  const inCut = (t: number) =>
    merged.some((cut) => cut.fromMs < t && t < cut.toMs);

  const frames = await decodeChunks(config, chunks);
  if (!frames || frames.length === 0) return null;

  const sampleRate = frames[0].sampleRate || config.sampleRate;
  const numberOfChannels =
    frames[0].numberOfChannels || config.numberOfChannels;
  const length = Math.max(1, Math.ceil((durationMs / 1000) * sampleRate));
  const channelData: Float32Array[] = [];
  for (let c = 0; c < numberOfChannels; c++) {
    channelData.push(new Float32Array(length));
  }

  // Opus decodes one frame per chunk in order, so index pairing recovers each
  // frame's raw time; a length mismatch (unexpected) falls back to the encoder
  // timestamp map, and anything still unresolved is skipped rather than
  // misplaced.
  const paired = frames.length === chunks.length;
  const rawTByTs = new Map<number, number>();
  if (!paired) for (const chunk of chunks) rawTByTs.set(chunk.tsUs, chunk.t);

  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    try {
      const rawT = paired
        ? chunks[index].t
        : rawTByTs.get(Math.round(frame.timestamp));
      if (rawT === undefined || inCut(rawT)) continue;
      const startSample = Math.round((toPlaybackMs(rawT) / 1000) * sampleRate);
      const frameLen = frame.numberOfFrames;
      const scratch = new Float32Array(frameLen);
      for (let c = 0; c < numberOfChannels; c++) {
        try {
          frame.copyTo(scratch, { planeIndex: c, format: "f32-planar" });
        } catch {
          continue;
        }
        const dest = channelData[c];
        for (let i = 0; i < frameLen; i++) {
          const at = startSample + i;
          if (at >= 0 && at < length) dest[at] = scratch[i];
        }
      }
    } finally {
      frame.close();
    }
  }
  return { sampleRate, numberOfChannels, length, channelData };
}

/**
 * How far the audio may drift from the clock before {@link
 * AudioPlaybackController.sync} restarts it. Comfortably above the clock's
 * ~100ms display cadence, so smooth playback never restarts (which would
 * stutter) while a seek — a large jump — always resyncs.
 */
const AUDIO_SYNC_DRIFT_MS = 250;

/**
 * Live audio for the player: one prebuilt {@link PlaybackAudio} buffer scheduled
 * against the host clock. Follows play/pause/seek by (re)starting a
 * `AudioBufferSourceNode` at the clock offset; both the clock and the buffer run
 * on the compressed timeline at real speed, so they stay in step without
 * per-frame correction.
 */
export class AudioPlaybackController {
  private readonly audio: PlaybackAudio;
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private muted = false;
  private playing = false;
  /** ctx.currentTime when the live source started, for drift estimation. */
  private startedAtCtxTime: number | null = null;
  private startedOffsetMs = 0;

  constructor(audio: PlaybackAudio) {
    this.audio = audio;
  }

  /**
   * Reconcile audio with the host clock in one call, from a single effect:
   * pause when the clock isn't running, start when it is, and restart only on a
   * real jump (a seek) — smooth advance stays within {@link
   * AUDIO_SYNC_DRIFT_MS} and is left alone so the buffer free-runs in step.
   */
  sync(offsetMs: number, playing: boolean) {
    if (!playing) {
      this.pause();
      return;
    }
    const expected = this.expectedOffsetMs();
    if (
      expected === null ||
      Math.abs(expected - offsetMs) > AUDIO_SYNC_DRIFT_MS
    ) {
      this.play(offsetMs);
    }
  }

  /** (Re)start playback at the given playback-clock offset. */
  play(offsetMs: number) {
    this.ensure();
    if (!this.ctx || !this.buffer || !this.gain) return;
    this.stopSource();
    this.playing = true;
    // A user gesture (opening the player, pressing play, toggling mute) is what
    // reaches here, so resuming a suspended context is allowed.
    void this.ctx.resume().catch(() => {});
    const offsetSec = Math.max(0, offsetMs / 1000);
    if (offsetSec >= this.buffer.duration) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain);
    try {
      source.start(0, offsetSec);
    } catch {
      return;
    }
    this.source = source;
    this.startedAtCtxTime = this.ctx.currentTime;
    this.startedOffsetMs = offsetMs;
  }

  pause() {
    this.playing = false;
    this.startedAtCtxTime = null;
    this.stopSource();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
  }

  dispose() {
    this.stopSource();
    try {
      void this.ctx?.close();
    } catch {}
    this.ctx = null;
    this.buffer = null;
    this.gain = null;
  }

  /** The offset the live source has reached, or null when not playing. */
  private expectedOffsetMs(): number | null {
    if (!this.playing || !this.ctx || this.startedAtCtxTime === null) {
      return null;
    }
    return (
      this.startedOffsetMs +
      (this.ctx.currentTime - this.startedAtCtxTime) * 1000
    );
  }

  private ensure() {
    if (this.ctx) return;
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.gain.value = this.muted ? 0 : 1;
      gain.connect(ctx.destination);
      const buffer = ctx.createBuffer(
        this.audio.numberOfChannels,
        this.audio.length,
        this.audio.sampleRate,
      );
      for (let c = 0; c < this.audio.numberOfChannels; c++) {
        // Our Float32Arrays are always plain `new Float32Array(length)` —
        // ArrayBuffer-backed, never a SharedArrayBuffer view — so the cast past
        // lib.dom's ArrayBuffer-generic typing is safe.
        buffer.copyToChannel(
          this.audio.channelData[c] as Float32Array<ArrayBuffer>,
          c,
        );
      }
      this.ctx = ctx;
      this.gain = gain;
      this.buffer = buffer;
    } catch {
      this.ctx = null;
    }
  }

  private stopSource() {
    if (!this.source) return;
    try {
      this.source.onended = null;
      this.source.stop();
    } catch {}
    try {
      this.source.disconnect();
    } catch {}
    this.source = null;
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

/** Decode every Opus chunk to ordered PCM frames; null on decoder failure. */
async function decodeChunks(
  config: RuntimeAudioConfig,
  chunks: RuntimeAudioChunk[],
): Promise<DecodedAudioFrame[] | null> {
  if (!AudioDecoderClass || !EncodedAudioChunkClass) return null;
  const frames: DecodedAudioFrame[] = [];
  let decoder: AudioDecoderLike | null = null;
  try {
    decoder = new AudioDecoderClass({
      output: (frame) => frames.push(frame),
      error: () => {},
    });
    decoder.configure({
      codec: config.codec,
      sampleRate: config.sampleRate,
      numberOfChannels: config.numberOfChannels,
      ...(config.description ? { description: config.description } : {}),
    });
    for (const chunk of chunks) {
      decoder.decode(
        new EncodedAudioChunkClass({
          type: "key",
          timestamp: chunk.tsUs,
          data: chunk.bytes,
        }),
      );
    }
    await decoder.flush();
  } catch {
    for (const frame of frames) {
      try {
        frame.close();
      } catch {}
    }
    return null;
  } finally {
    try {
      decoder?.close();
    } catch {}
  }
  return frames;
}
