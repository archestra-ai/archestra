import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addAudioTrack: vi.fn(),
  addVideoTrack: vi.fn(),
  audioAdd: vi.fn(),
  canEncodeAudio: vi.fn(),
  outputCancel: vi.fn(),
  outputStart: vi.fn(),
  registerAacEncoder: vi.fn(),
}));

vi.mock("@mediabunny/aac-encoder", () => ({
  registerAacEncoder: mocks.registerAacEncoder,
}));

vi.mock("mediabunny", () => {
  class BufferTarget {
    buffer: ArrayBuffer | null = new ArrayBuffer(1);
  }

  class Output {
    target: BufferTarget;

    constructor({ target }: { target: BufferTarget }) {
      this.target = target;
    }

    addAudioTrack = mocks.addAudioTrack;
    addVideoTrack = mocks.addVideoTrack;
    cancel = mocks.outputCancel;
    start = mocks.outputStart;
  }

  class AudioSample {
    close = vi.fn();
  }

  class AudioSampleSource {
    add = mocks.audioAdd;
  }
  class VideoSampleSource {}

  return {
    AudioSample,
    AudioSampleSource,
    BufferTarget,
    Mp4OutputFormat: class {},
    Output,
    VideoSample: class {},
    VideoSampleSource,
    canEncodeAudio: mocks.canEncodeAudio,
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.audioAdd.mockResolvedValue(undefined);
  mocks.outputCancel.mockResolvedValue(undefined);
  mocks.outputStart.mockResolvedValue(undefined);
});

describe("app recording video encoder", () => {
  test("uses native AAC without loading the fallback", async () => {
    mocks.canEncodeAudio.mockResolvedValue(true);
    const { startEncoder } = await import("./app-recording-video-encoder");

    await startEncoder(encoderParams());

    expect(mocks.registerAacEncoder).not.toHaveBeenCalled();
    expect(mocks.addAudioTrack).toHaveBeenCalledOnce();
    expect(mocks.audioAdd).toHaveBeenCalledOnce();
    expect(mocks.outputStart).toHaveBeenCalledOnce();
  });

  test("uses the WASM AAC fallback when native AAC is unavailable", async () => {
    mocks.canEncodeAudio
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { startEncoder } = await import("./app-recording-video-encoder");

    await startEncoder(encoderParams());

    expect(mocks.registerAacEncoder).toHaveBeenCalledOnce();
    expect(mocks.canEncodeAudio).toHaveBeenCalledTimes(2);
    expect(mocks.addAudioTrack).toHaveBeenCalledOnce();
    expect(mocks.audioAdd).toHaveBeenCalledOnce();
  });

  test("omits audio when neither AAC encoder supports its layout", async () => {
    mocks.canEncodeAudio.mockResolvedValue(false);
    const { startEncoder } = await import("./app-recording-video-encoder");

    await startEncoder(encoderParams());

    expect(mocks.registerAacEncoder).toHaveBeenCalledOnce();
    expect(mocks.addAudioTrack).not.toHaveBeenCalled();
    expect(mocks.addVideoTrack).toHaveBeenCalledOnce();
    expect(mocks.outputStart).toHaveBeenCalledOnce();
  });

  test("restarts video-only if the fallback fails while encoding", async () => {
    mocks.canEncodeAudio
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.audioAdd.mockRejectedValue(new Error("WASM encoder failed"));
    const { startEncoder } = await import("./app-recording-video-encoder");

    await expect(startEncoder(encoderParams())).resolves.toBeUndefined();

    expect(mocks.outputCancel).toHaveBeenCalledOnce();
    expect(mocks.addAudioTrack).toHaveBeenCalledOnce();
    expect(mocks.addVideoTrack).toHaveBeenCalledTimes(2);
    expect(mocks.outputStart).toHaveBeenCalledTimes(2);
  });
});

function encoderParams() {
  return {
    width: 1280,
    height: 720,
    fps: 24,
    audio: {
      channelData: [new Float32Array(48_000), new Float32Array(48_000)],
      length: 48_000,
      numberOfChannels: 2,
      sampleRate: 48_000,
    },
  };
}
