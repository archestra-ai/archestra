import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RuntimeRecordingEvent } from "./app-recording-binary";

const opusMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  decodeFrame: vi.fn(),
  free: vi.fn(),
}));

vi.mock("opus-decoder", () => ({
  OpusDecoder: class {
    readonly ready = Promise.resolve();

    constructor(options: unknown) {
      opusMocks.construct(options);
    }

    decodeFrame = opusMocks.decodeFrame;
    free = opusMocks.free;
  },
}));

const description = new Uint8Array([1, 2, 3]);
const audioEvents = [
  {
    kind: "audio-config",
    t: 0,
    codec: "opus",
    sampleRate: 48_000,
    numberOfChannels: 2,
    description,
  },
  {
    kind: "audio-chunk",
    t: 0,
    tsUs: 0,
    bytes: new Uint8Array([4, 5, 6]),
  },
] as RuntimeRecordingEvent[];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  opusMocks.decodeFrame.mockReturnValue({
    channelData: [
      new Float32Array([0.25, 0.5]),
      new Float32Array([-0.25, -0.5]),
    ],
    samplesDecoded: 2,
    sampleRate: 48_000,
    errors: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("app recording playback audio", () => {
  test("uses the WASM Opus fallback when WebCodecs audio is absent", async () => {
    vi.stubGlobal("AudioDecoder", undefined);
    vi.stubGlobal("EncodedAudioChunk", undefined);
    const { preparePlaybackAudio } = await import("./app-recording-audio");

    const result = await preparePlaybackAudio(params());

    expect(result.status).toBe("ready");
    expect(opusMocks.construct).toHaveBeenCalledWith({
      sampleRate: 48_000,
      preSkip: 0,
      channels: 2,
      streamCount: 1,
      coupledStreamCount: 1,
    });
    expect(opusMocks.decodeFrame).toHaveBeenCalledWith(
      new Uint8Array([4, 5, 6]),
    );
    expect(opusMocks.free).toHaveBeenCalledOnce();
  });

  test("reports an unsupported codec when no native or software decoder exists", async () => {
    vi.stubGlobal("AudioDecoder", undefined);
    vi.stubGlobal("EncodedAudioChunk", undefined);
    const { preparePlaybackAudio } = await import("./app-recording-audio");

    await expect(
      preparePlaybackAudio(params(eventsWithCodec("aac"))),
    ).resolves.toEqual({ status: "unsupported", codec: "aac" });
    expect(opusMocks.construct).not.toHaveBeenCalled();
  });

  test("probes the exact config before bypassing native decoding", async () => {
    const isConfigSupported = vi.fn().mockResolvedValue({ supported: false });
    const constructed = vi.fn();
    class UnsupportedAudioDecoder {
      static isConfigSupported = isConfigSupported;
      constructor() {
        constructed();
      }
    }
    vi.stubGlobal("AudioDecoder", UnsupportedAudioDecoder);
    vi.stubGlobal("EncodedAudioChunk", class {});
    const { preparePlaybackAudio } = await import("./app-recording-audio");

    await expect(preparePlaybackAudio(params())).resolves.toMatchObject({
      status: "ready",
    });
    expect(isConfigSupported).toHaveBeenCalledWith({
      codec: "opus",
      sampleRate: 48_000,
      numberOfChannels: 2,
      description,
    });
    expect(constructed).not.toHaveBeenCalled();
    expect(opusMocks.decodeFrame).toHaveBeenCalledOnce();
  });

  test("decodes after a successful capability probe", async () => {
    const isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    const close = vi.fn();
    class SupportedAudioDecoder {
      static isConfigSupported = isConfigSupported;
      private readonly output: (frame: object) => void;

      constructor({ output }: { output: (frame: object) => void }) {
        this.output = output;
      }

      configure() {}

      decode() {
        this.output({
          sampleRate: 48_000,
          numberOfChannels: 2,
          numberOfFrames: 2,
          timestamp: 0,
          copyTo(
            destination: Float32Array,
            { planeIndex }: { planeIndex: number },
          ) {
            destination.set(planeIndex === 0 ? [0.25, 0.5] : [-0.25, -0.5]);
          },
          close,
        });
      }

      async flush() {}
      close() {}
    }
    vi.stubGlobal("AudioDecoder", SupportedAudioDecoder);
    vi.stubGlobal("EncodedAudioChunk", class {});
    const { preparePlaybackAudio } = await import("./app-recording-audio");

    const result = await preparePlaybackAudio(params());

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected decoded audio");
    expect(result.audio.channelData[0].slice(0, 2)).toEqual(
      new Float32Array([0.25, 0.5]),
    );
    expect(result.audio.channelData[1].slice(0, 2)).toEqual(
      new Float32Array([-0.25, -0.5]),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(opusMocks.construct).not.toHaveBeenCalled();
  });

  test("reports a guarded failure when a nominally supported decode fails", async () => {
    opusMocks.decodeFrame.mockImplementation(() => {
      throw new Error("software decode failed");
    });
    class FailingAudioDecoder {
      static isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
      configure() {
        throw new Error("codec initialization failed");
      }
      decode() {}
      async flush() {}
      close() {}
    }
    vi.stubGlobal("AudioDecoder", FailingAudioDecoder);
    vi.stubGlobal("EncodedAudioChunk", class {});
    const { buildPlaybackAudio, preparePlaybackAudio } = await import(
      "./app-recording-audio"
    );

    await expect(preparePlaybackAudio(params())).resolves.toEqual({
      status: "failed",
      codec: "opus",
    });
    await expect(buildPlaybackAudio(params())).resolves.toBeNull();
  });

  test("notifies the player when browser audio output cannot initialize", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("audio output unavailable");
        }
      },
    );
    const { AudioPlaybackController } = await import("./app-recording-audio");
    const onUnavailable = vi.fn();
    const controller = new AudioPlaybackController(
      {
        sampleRate: 48_000,
        numberOfChannels: 1,
        length: 48,
        channelData: [new Float32Array(48)],
      },
      onUnavailable,
    );

    expect(() => controller.play(0)).not.toThrow();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  test("closes a partially initialized audio graph exactly once", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "AudioContext",
      class {
        readonly destination = {};

        createGain() {
          return { gain: { value: 1 }, connect() {} };
        }

        createBuffer() {
          throw new Error("audio buffer unavailable");
        }

        close() {
          close();
          return Promise.resolve();
        }
      },
    );
    const { AudioPlaybackController } = await import("./app-recording-audio");
    const onUnavailable = vi.fn();
    const controller = new AudioPlaybackController(
      {
        sampleRate: 48_000,
        numberOfChannels: 1,
        length: 48,
        channelData: [new Float32Array(48)],
      },
      onUnavailable,
    );

    controller.play(0);

    expect(close).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  test("decodes a real Opus packet through the bundled WASM fallback", async () => {
    vi.doUnmock("opus-decoder");
    vi.stubGlobal("AudioDecoder", undefined);
    vi.stubGlobal("EncodedAudioChunk", undefined);
    const events = audioEvents.map((event) =>
      event.kind === "audio-chunk"
        ? { ...event, bytes: new Uint8Array([0xf8, 0xff, 0xfe]) }
        : event,
    );
    const { preparePlaybackAudio } = await import("./app-recording-audio");

    const result = await preparePlaybackAudio(params(events));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected decoded audio");
    expect(result.audio.sampleRate).toBe(48_000);
    expect(result.audio.numberOfChannels).toBe(2);
    expect(result.audio.channelData[0]).toHaveLength(480);
  });
});

function params(events = audioEvents) {
  return {
    events,
    cuts: [],
    durationMs: 10,
    toPlaybackMs: (rawMs: number) => rawMs,
  };
}

function eventsWithCodec(codec: string): RuntimeRecordingEvent[] {
  return audioEvents.map((event) =>
    event.kind === "audio-config" ? { ...event, codec } : event,
  );
}
