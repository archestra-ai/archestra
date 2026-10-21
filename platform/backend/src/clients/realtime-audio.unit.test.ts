import { describe, expect, test } from "vitest";
import { realtimePcmToWav, wavToRealtimePcm } from "./realtime-audio";

describe("Realtime audio files", () => {
  test("wraps returned PCM as a playable WAV and decodes it without changing samples", () => {
    const pcm = Buffer.alloc(4800);
    pcm.writeInt16LE(-1234, 0);
    pcm.writeInt16LE(2345, 2);
    const wav = realtimePcmToWav(pcm);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wavToRealtimePcm(wav.toString("base64"))).toEqual(pcm);
  });
  test("accepts the unknown data length used in generated streaming WAVs", () => {
    const pcm = Buffer.alloc(4800);
    const wav = realtimePcmToWav(pcm);
    wav.writeUInt32LE(0xffffffff, 4);
    wav.writeUInt32LE(0xffffffff, 40);
    expect(wavToRealtimePcm(wav.toString("base64"))).toEqual(pcm);
  });
  test("mixes stereo PCM and resamples a WAV to the required sample rate", () => {
    const wav = realtimePcmToWav(Buffer.from([100, 0, 200, 0, 100, 0, 200, 0]));
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(48000, 24);
    wav.writeUInt32LE(192000, 28);
    wav.writeUInt16LE(4, 32);
    const pcm = wavToRealtimePcm(wav.toString("base64"));
    expect(pcm.length).toBe(2);
    expect(pcm.readInt16LE(0)).toBe(150);
  });
  test("rejects malformed and truncated files before opening an upstream session", () => {
    expect(() =>
      wavToRealtimePcm(Buffer.from("not a WAV").toString("base64")),
    ).toThrow("PCM16 WAV");
    const wav = realtimePcmToWav(Buffer.alloc(100));
    expect(() =>
      wavToRealtimePcm(wav.subarray(0, 50).toString("base64")),
    ).toThrow("truncated");
  });
});
