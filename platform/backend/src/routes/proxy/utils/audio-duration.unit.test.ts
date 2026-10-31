import { describe, expect, test } from "vitest";
import { audioDurationSeconds } from "./audio-duration";

function wav(params: { seconds: number; rate: number; dataSize?: number }) {
  const data = params.rate * 2 * params.seconds;
  const file = Buffer.alloc(44 + data);
  file.write("RIFF", 0, "latin1");
  file.writeUInt32LE(36 + data, 4);
  file.write("WAVEfmt ", 8, "latin1");
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(params.rate, 24);
  file.writeUInt32LE(params.rate * 2, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write("data", 36, "latin1");
  file.writeUInt32LE(params.dataSize ?? data, 40);
  return file;
}

function id3(size: number): Buffer {
  const tag = Buffer.alloc(10 + size);
  tag.write("ID3", 0, "latin1");
  tag[3] = 4;
  tag[9] = size & 0x7f;
  tag[8] = (size >> 7) & 0x7f;
  return tag;
}

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 417-byte frames of 1152 samples. */
function mp3Frames(count: number, firstFrame?: (frame: Buffer) => void) {
  const frames = Array.from({ length: count }, (_, index) => {
    const frame = Buffer.alloc(417);
    frame.set([0xff, 0xfb, 0x90, 0x00]);
    if (index === 0) firstFrame?.(frame);
    return frame;
  });
  return Buffer.concat(frames);
}

function oggPage(params: {
  serial: number;
  granule: bigint;
  packet?: Buffer;
}): Buffer {
  const packet = params.packet ?? Buffer.alloc(0);
  const page = Buffer.alloc(27 + 1 + packet.length);
  page.write("OggS", 0, "latin1");
  page.writeBigInt64LE(params.granule, 6);
  page.writeUInt32LE(params.serial, 14);
  page[26] = 1;
  page[27] = packet.length;
  packet.copy(page, 28);
  return page;
}

describe("audioDurationSeconds", () => {
  test("counts a WAV file's sample frames at its sample rate", () => {
    expect(audioDurationSeconds(wav({ seconds: 3, rate: 8000 }))).toBe(3);
  });

  test("refuses a WAV header whose byte rate disagrees with its samples", () => {
    // A minute of 16 kHz mono 16-bit PCM claiming 60 times its byte rate
    // would bill as one second.
    const file = wav({ seconds: 60, rate: 16000 });
    file.writeUInt32LE(1_920_000, 28);
    expect(audioDurationSeconds(file)).toBeUndefined();
  });

  test("leaves a compressed WAV encoding unmeasured", () => {
    const file = wav({ seconds: 2, rate: 8000 });
    file.writeUInt16LE(0x0011, 20); // IMA ADPCM
    expect(audioDurationSeconds(file)).toBeUndefined();
  });

  test("reads a streamed WAV whose data size was left at its maximum", () => {
    expect(
      audioDurationSeconds(
        wav({ seconds: 2, rate: 16000, dataSize: 0xffffffff }),
      ),
    ).toBe(2);
  });

  test("reads FLAC's sample count and rate from STREAMINFO, after an ID3 tag", () => {
    const info = Buffer.alloc(34);
    info.writeUInt16BE(4096, 0);
    info.writeUInt16BE(4096, 2);
    // 20-bit rate, 3-bit channels - 1, 5-bit bits per sample - 1, 36-bit samples.
    const packed =
      (44100n << 44n) | (1n << 41n) | (15n << 36n) | BigInt(44100 * 2.5);
    info.writeBigUInt64BE(packed, 10);
    const flac = Buffer.concat([
      id3(20),
      Buffer.from("fLaC", "latin1"),
      Buffer.from([0x80, 0, 0, 34]),
      info,
    ]);
    expect(audioDurationSeconds(flac)).toBe(2.5);
  });

  test("counts the frames of a constant-bitrate MP3, after an ID3 tag", () => {
    const mp3 = Buffer.concat([id3(30), mp3Frames(100)]);
    expect(audioDurationSeconds(mp3)).toBeCloseTo((100 * 1152) / 44100, 6);
  });

  test("reads a VBR MP3's frame count and trims the LAME encoder delay and padding", () => {
    const mp3 = mp3Frames(2, (frame) => {
      const xing = 4 + 32;
      frame.write("Info", xing, "latin1");
      frame.writeUInt32BE(1, xing + 4); // frame count present
      frame.writeUInt32BE(50, xing + 8);
      const lame = xing + 12;
      frame.write("LAME3.100", lame, "latin1");
      // 576 samples of delay and 1000 of padding, 12 bits each.
      frame.set(
        [576 >> 4, ((576 & 0xf) << 4) | (1000 >> 8), 1000 & 0xff],
        lame + 21,
      );
    });
    expect(audioDurationSeconds(mp3)).toBeCloseTo(
      (50 * 1152 - 1576) / 44100,
      6,
    );
  });

  test("reads the last granule position of an Ogg Vorbis stream", () => {
    const head = Buffer.alloc(30);
    head.write("\x01vorbis", 0, "latin1");
    head.writeUInt32LE(48000, 12);
    const ogg = Buffer.concat([
      oggPage({ serial: 7, granule: 0n, packet: head }),
      oggPage({ serial: 7, granule: 48000n }),
      oggPage({ serial: 7, granule: 96000n }),
    ]);
    expect(audioDurationSeconds(ogg)).toBe(2);
  });

  test("counts Ogg Opus at 48 kHz less its pre-skip", () => {
    const head = Buffer.alloc(19);
    head.write("OpusHead", 0, "latin1");
    head[8] = 1;
    head[9] = 1;
    head.writeUInt16LE(312, 10);
    head.writeUInt32LE(16000, 12);
    const ogg = Buffer.concat([
      oggPage({ serial: 3, granule: 0n, packet: head }),
      oggPage({ serial: 3, granule: 96312n }),
    ]);
    expect(audioDurationSeconds(ogg)).toBe(2);
  });

  test("reads an M4A movie header's duration against its timescale", () => {
    const ftyp = Buffer.alloc(16);
    ftyp.writeUInt32BE(16, 0);
    ftyp.write("ftypM4A ", 4, "latin1");
    const mvhd = Buffer.alloc(28);
    mvhd.writeUInt32BE(28, 0);
    mvhd.write("mvhd", 4, "latin1");
    mvhd.writeUInt32BE(1000, 8 + 12);
    mvhd.writeUInt32BE(2500, 8 + 16);
    const moov = Buffer.alloc(8);
    moov.writeUInt32BE(8 + mvhd.length, 0);
    moov.write("moov", 4, "latin1");
    expect(audioDurationSeconds(Buffer.concat([ftyp, moov, mvhd]))).toBe(2.5);
  });

  test("returns undefined for a format or file it cannot read", () => {
    // WebM, as browser recorders write it.
    expect(
      audioDurationSeconds(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])),
    ).toBeUndefined();
    // A WAV header without a data chunk.
    expect(
      audioDurationSeconds(
        Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfmt \u0000ÿ", "latin1"),
      ),
    ).toBeUndefined();
    expect(
      audioDurationSeconds(Buffer.from("PRIVATE_AUDIO_BYTES")),
    ).toBeUndefined();
    expect(audioDurationSeconds(Buffer.alloc(0))).toBeUndefined();
  });
});
