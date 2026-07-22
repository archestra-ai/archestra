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
interface AudioDecoderConfigLike {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  // Uint8Array rather than the real BufferSource: our data is always a plain
  // Uint8Array, and pinning to that (instead of lib.dom's ArrayBuffer-generic
  // BufferSource) avoids an ArrayBufferLike/ArrayBuffer mismatch at call sites
  // that never construct a SharedArrayBuffer-backed view in the first place.
  description?: Uint8Array;
}
interface AudioDecoderLike {
  configure(config: AudioDecoderConfigLike): void;
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  close(): void;
}
interface AudioDecoderCtor {
  new (init: {
    output: (frame: DecodedAudioFrame) => void;
    error: (error: unknown) => void;
  }): AudioDecoderLike;
  isConfigSupported?: (
    config: AudioDecoderConfigLike,
  ) => Promise<{ supported: boolean }>;
}
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

/** The browser-facing outcome of preparing a recording's audio track. */
export type PlaybackAudioPreparation =
  | { status: "ready"; audio: PlaybackAudio }
  | { status: "absent" }
  | { status: "unsupported"; codec: string }
  | { status: "failed"; codec: string };

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
 * Decode the recording's audio into PCM positioned on the playback timeline.
 *
 * This compatibility wrapper preserves the exporter's nullable contract; the
 * interactive player uses {@link preparePlaybackAudio} so it can distinguish
 * an unsupported browser from a recording with no audio.
 */
export async function buildPlaybackAudio(params: {
  events: readonly RuntimeRecordingEvent[];
  cuts: readonly { fromMs: number; toMs: number }[];
  /** The compressed playback duration (buildPlayback().duration). */
  durationMs: number;
  toPlaybackMs: (rawMs: number) => number;
}): Promise<PlaybackAudio | null> {
  const result = await preparePlaybackAudio(params);
  return result.status === "ready" ? result.audio : null;
}

/**
 * Prepare browser playback audio with an explicit, non-throwing result.
 *
 * WebCodecs is optional and codec support varies independently from the media
 * codecs a browser can play in an `<audio>` element. Probe the exact recorded
 * config when the browser exposes `isConfigSupported`, then still guard the
 * real decode. Opus gets a lazily loaded WASM/libopus second chance; if both
 * decoders fail, playback degrades to silent visuals.
 *
 * Chunks carry their raw recording time `t`; each decoded frame is written at
 * `toPlaybackMs(t)` (the compressed clock the player and export both run on),
 * and frames inside a cut are dropped so a cut range plays silent rather than
 * bursting the removed audio at the collapse instant.
 */
export async function preparePlaybackAudio(params: {
  events: readonly RuntimeRecordingEvent[];
  cuts: readonly { fromMs: number; toMs: number }[];
  /** The compressed playback duration (buildPlayback().duration). */
  durationMs: number;
  toPlaybackMs: (rawMs: number) => number;
}): Promise<PlaybackAudioPreparation> {
  const { events, cuts, durationMs, toPlaybackMs } = params;
  const config = events.find(
    (event): event is RuntimeAudioConfig => event.kind === "audio-config",
  );
  const chunks = events
    .filter((event): event is RuntimeAudioChunk => event.kind === "audio-chunk")
    .sort((a, b) => a.tsUs - b.tsUs);
  if (!config || chunks.length === 0) return { status: "absent" };

  const merged = normalizeCuts(cuts.map((cut) => ({ ...cut })));
  const inCut = (t: number) =>
    merged.some((cut) => cut.fromMs < t && t < cut.toMs);

  const nativeSupported = await supportsNativeAudioDecode(config);
  let frames = nativeSupported ? await decodeChunks(config, chunks) : null;
  if ((!frames || frames.length === 0) && config.codec === "opus") {
    frames = await decodeOpusChunksWithWasm(config, chunks);
  }
  if (!frames || frames.length === 0) {
    return {
      status:
        nativeSupported || config.codec === "opus" ? "failed" : "unsupported",
      codec: config.codec,
    };
  }

  try {
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
        const startSample = Math.round(
          (toPlaybackMs(rawT) / 1000) * sampleRate,
        );
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
    return {
      status: "ready",
      audio: { sampleRate, numberOfChannels, length, channelData },
    };
  } catch {
    closeFrames(frames);
    return { status: "failed", codec: config.codec };
  }
}

/**
 * How far the audio may drift from the clock before {@link
 * AudioPlaybackController.sync} restarts it. Comfortably above the clock's
 * ~100ms display cadence, so smooth playback never restarts (which would
 * stutter) while a seek — a large jump — always resyncs.
 */
const AUDIO_SYNC_DRIFT_MS = 250;

interface PlaybackAudioGraph {
  ctx: AudioContext;
  buffer: AudioBuffer;
  gain: GainNode;
}

/**
 * Live audio for the player: one prebuilt {@link PlaybackAudio} buffer scheduled
 * against the host clock. Follows play/pause/seek by (re)starting a
 * `AudioBufferSourceNode` at the clock offset; both the clock and the buffer run
 * on the compressed timeline at real speed, so they stay in step without
 * per-frame correction.
 */
export class AudioPlaybackController {
  private readonly audio: PlaybackAudio;
  private graph: PlaybackAudioGraph | null = null;
  private source: AudioBufferSourceNode | null = null;
  private muted = false;
  private playing = false;
  /** ctx.currentTime when the live source started, for drift estimation. */
  private startedAtCtxTime: number | null = null;
  private startedOffsetMs = 0;
  private unavailable = false;
  private disposed = false;
  private readonly onUnavailable?: () => void;

  constructor(audio: PlaybackAudio, onUnavailable?: () => void) {
    this.audio = audio;
    this.onUnavailable = onUnavailable;
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
    const graph = this.ensure();
    if (!graph) {
      this.markUnavailable();
      return;
    }
    this.stopSource();
    this.playing = true;
    // A user gesture (opening the player, pressing play, toggling mute) is what
    // reaches here, so resuming a suspended context is allowed.
    void graph.ctx.resume().catch(() => this.markUnavailable());
    const offsetSec = Math.max(0, offsetMs / 1000);
    if (offsetSec >= graph.buffer.duration) return;
    const source = graph.ctx.createBufferSource();
    source.buffer = graph.buffer;
    source.connect(graph.gain);
    try {
      source.start(0, offsetSec);
    } catch {
      this.markUnavailable();
      return;
    }
    this.source = source;
    this.startedAtCtxTime = graph.ctx.currentTime;
    this.startedOffsetMs = offsetMs;
  }

  pause() {
    this.playing = false;
    this.startedAtCtxTime = null;
    this.stopSource();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.graph) this.graph.gain.gain.value = muted ? 0 : 1;
  }

  dispose() {
    this.disposed = true;
    this.stopSource();
    try {
      void this.graph?.ctx.close();
    } catch {}
    this.graph = null;
  }

  /** The offset the live source has reached, or null when not playing. */
  private expectedOffsetMs(): number | null {
    if (!this.playing || !this.graph || this.startedAtCtxTime === null) {
      return null;
    }
    return (
      this.startedOffsetMs +
      (this.graph.ctx.currentTime - this.startedAtCtxTime) * 1000
    );
  }

  private ensure(): PlaybackAudioGraph | null {
    if (this.unavailable || this.disposed) return null;
    if (this.graph) return this.graph;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
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
      this.graph = { ctx, gain, buffer };
      return this.graph;
    } catch {
      try {
        void ctx?.close().catch(() => {});
      } catch {}
      return null;
    }
  }

  private markUnavailable() {
    if (this.unavailable || this.disposed) return;
    this.unavailable = true;
    this.pause();
    try {
      void this.graph?.ctx.close().catch(() => {});
    } catch {}
    this.graph = null;
    this.onUnavailable?.();
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

/** Whether WebCodecs can attempt the recording's exact audio configuration. */
async function supportsNativeAudioDecode(
  config: RuntimeAudioConfig,
): Promise<boolean> {
  if (!AudioDecoderClass || !EncodedAudioChunkClass) return false;
  if (!AudioDecoderClass.isConfigSupported) return true;
  try {
    const support = await AudioDecoderClass.isConfigSupported(
      audioDecoderConfig(config),
    );
    return support.supported;
  } catch {
    return false;
  }
}

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
    decoder.configure(audioDecoderConfig(config));
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

/**
 * Software Opus fallback for browsers without a usable WebCodecs decoder.
 * Imported only on the fallback path; each raw recorded packet is decoded on
 * its own so its capture timestamp remains available for cut/idle compression.
 */
async function decodeOpusChunksWithWasm(
  config: RuntimeAudioConfig,
  chunks: RuntimeAudioChunk[],
): Promise<DecodedAudioFrame[] | null> {
  const options = opusDecoderOptions(config);
  if (!options) return null;
  try {
    const { OpusDecoder } = await import("opus-decoder");
    const decoder = new OpusDecoder(options);
    try {
      await decoder.ready;
      const frames: DecodedAudioFrame[] = [];
      for (const chunk of chunks) {
        const decoded = decoder.decodeFrame(chunk.bytes);
        if (decoded.samplesDecoded <= 0 || decoded.channelData.length === 0) {
          continue;
        }
        const planes = decoded.channelData;
        frames.push({
          sampleRate: decoded.sampleRate,
          numberOfChannels: planes.length,
          numberOfFrames: decoded.samplesDecoded,
          timestamp: chunk.tsUs,
          copyTo(destination, { planeIndex }) {
            const plane = planes[planeIndex];
            if (!plane) throw new RangeError("Invalid Opus channel plane.");
            destination.fill(0);
            destination.set(plane.subarray(0, destination.length));
          },
          close() {},
        });
      }
      return frames;
    } finally {
      decoder.free();
    }
  } catch {
    return null;
  }
}

type OpusSampleRate = 8_000 | 12_000 | 16_000 | 24_000 | 48_000;
interface OpusDecoderOptions {
  sampleRate: OpusSampleRate;
  preSkip: number;
  channels: number;
  streamCount: number;
  coupledStreamCount: number;
  channelMappingTable?: number[];
}

/** "OpusHead" — RFC 7845 section 5.1 identification-header signature. */
const OPUS_HEAD_MAGIC = new Uint8Array([
  0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64,
]);

/** Build libopus options from the RFC 7845 `OpusHead` decoder description. */
function opusDecoderOptions(
  config: RuntimeAudioConfig,
): OpusDecoderOptions | null {
  const description = config.description;
  const hasOpusHead =
    description !== undefined &&
    description.length >= 19 &&
    OPUS_HEAD_MAGIC.every((byte, index) => description[index] === byte);
  const channels = hasOpusHead ? description[9] : config.numberOfChannels;
  if (channels < 1 || channels > 255) return null;
  const preSkip = hasOpusHead ? description[10] | (description[11] << 8) : 0;
  const sampleRate = opusSampleRate(config.sampleRate);

  if (!hasOpusHead || description[18] === 0) {
    if (channels > 2) return null;
    return {
      sampleRate,
      preSkip,
      channels,
      streamCount: 1,
      coupledStreamCount: channels === 2 ? 1 : 0,
    };
  }

  if (description.length < 21 + channels) return null;
  return {
    sampleRate,
    preSkip,
    channels,
    streamCount: description[19],
    coupledStreamCount: description[20],
    channelMappingTable: Array.from(description.subarray(21, 21 + channels)),
  };
}

function opusSampleRate(sampleRate: number): OpusSampleRate {
  return sampleRate === 8_000 ||
    sampleRate === 12_000 ||
    sampleRate === 16_000 ||
    sampleRate === 24_000
    ? sampleRate
    : 48_000;
}

function audioDecoderConfig(
  config: RuntimeAudioConfig,
): AudioDecoderConfigLike {
  return {
    codec: config.codec,
    sampleRate: config.sampleRate,
    numberOfChannels: config.numberOfChannels,
    ...(config.description ? { description: config.description } : {}),
  };
}

function closeFrames(frames: DecodedAudioFrame[]) {
  for (const frame of frames) {
    try {
      frame.close();
    } catch {}
  }
}
