/**
 * Playing time of an uploaded audio file, read from its container headers.
 *
 * Transcripts returned as text, SRT or VTT, and every translation, carry no
 * usage, yet OpenAI bills them per second of input audio, so their cost comes
 * from the upload's duration. This reads WAV, FLAC, Ogg, MP3 and MP4/M4A;
 * its results match libsndfile on the formats both read. A format it cannot
 * read (WebM, which browser recorders often write without a duration) or a
 * malformed file yields `undefined`: the cost then stays unknown, never zero.
 */
export function audioDurationSeconds(data: Buffer): number | undefined {
  try {
    const seconds =
      ascii(data, 0, 4) === "RIFF"
        ? wavDuration(data)
        : ascii(data, 0, 4) === "OggS"
          ? oggDuration(data)
          : ascii(data, 4, 8) === "ftyp"
            ? mp4Duration(data)
            : flacOrMp3Duration(data);
    return seconds !== undefined && Number.isFinite(seconds) && seconds > 0
      ? seconds
      : undefined;
  } catch {
    return undefined;
  }
}

function ascii(data: Buffer, start: number, end: number): string {
  return end <= data.length ? data.toString("latin1", start, end) : "";
}

/**
 * Length of uncompressed WAV audio, counted in sample frames. The header's
 * byte rate is redundant and the uploader controls it, so it only has to
 * agree with the sample rate and frame size; a header that disagrees, or a
 * compressed encoding, yields `undefined`.
 */
function wavDuration(data: Buffer): number | undefined {
  if (ascii(data, 8, 12) !== "WAVE") return;
  let format: { sampleRate: number; frameBytes: number } | undefined;
  for (let offset = 12; offset + 8 <= data.length; ) {
    const id = ascii(data, offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === "fmt " && size >= 16) format = wavFormat(data, offset + 8);
    if (id === "data") {
      if (!format) return;
      // Streaming writers leave the size at its maximum; the bytes present
      // are then the data.
      const bytes = Math.min(size, data.length - offset - 8);
      return Math.floor(bytes / format.frameBytes) / format.sampleRate;
    }
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

/** Sample rate and frame size of an uncompressed `fmt ` chunk whose fields agree. */
function wavFormat(
  data: Buffer,
  start: number,
): { sampleRate: number; frameBytes: number } | undefined {
  const encoding = data.readUInt16LE(start);
  const channels = data.readUInt16LE(start + 2);
  const sampleRate = data.readUInt32LE(start + 4);
  const byteRate = data.readUInt32LE(start + 8);
  const frameBytes = data.readUInt16LE(start + 12);
  const bitsPerSample = data.readUInt16LE(start + 14);
  if (!WAV_UNCOMPRESSED.has(encoding)) return;
  if (!channels || !sampleRate || !bitsPerSample) return;
  if (frameBytes !== channels * Math.ceil(bitsPerSample / 8)) return;
  if (byteRate !== sampleRate * frameBytes) return;
  return { sampleRate, frameBytes };
}

/** PCM, IEEE float, A-law, mu-law, and the extensible header that wraps them. */
const WAV_UNCOMPRESSED = new Set([0x0001, 0x0003, 0x0006, 0x0007, 0xfffe]);

function flacOrMp3Duration(data: Buffer): number | undefined {
  // An ID3v2 tag may precede either format.
  let start = 0;
  if (ascii(data, 0, 3) === "ID3" && data.length >= 10) {
    const size =
      ((data[6] & 0x7f) << 21) |
      ((data[7] & 0x7f) << 14) |
      ((data[8] & 0x7f) << 7) |
      (data[9] & 0x7f);
    start = 10 + size + (data[5] & 0x10 ? 10 : 0);
  }
  if (ascii(data, start, start + 4) === "fLaC")
    return flacDuration(data, start);
  return mp3Duration(data, start);
}

function flacDuration(data: Buffer, start: number): number | undefined {
  // STREAMINFO is always the first metadata block.
  const info = start + 8;
  if ((data[start + 4] & 0x7f) !== 0 || info + 18 > data.length) return;
  const sampleRate =
    (data[info + 10] << 12) | (data[info + 11] << 4) | (data[info + 12] >> 4);
  const totalSamples =
    (data[info + 13] & 0x0f) * 2 ** 32 + data.readUInt32BE(info + 14);
  return sampleRate && totalSamples ? totalSamples / sampleRate : undefined;
}

const MP3_BITRATES_KBPS = {
  // [MPEG-1, MPEG-2/2.5] by layer, indexed by the header's bitrate field.
  1: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  ],
  2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
  3: [
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
} as const;
const MP3_SAMPLE_RATES = [44100, 48000, 32000] as const;

interface Mp3Frame {
  length: number;
  samples: number;
  sampleRate: number;
  mpeg1: boolean;
  mono: boolean;
}

function mp3Frame(data: Buffer, offset: number): Mp3Frame | undefined {
  if (offset + 4 > data.length) return;
  const header = data.readUInt32BE(offset);
  if (header >>> 21 !== 0x7ff) return;
  const versionBits = (header >>> 19) & 3; // 0: 2.5, 2: 2, 3: 1
  const layer = 4 - ((header >>> 17) & 3); // 1, 2 or 3
  const bitrateIndex = (header >>> 12) & 0xf;
  const rateIndex = (header >>> 10) & 3;
  if (versionBits === 1 || layer === 4 || rateIndex === 3) return;
  if (bitrateIndex === 0 || bitrateIndex === 15) return;
  const mpeg1 = versionBits === 3;
  const sampleRate =
    MP3_SAMPLE_RATES[rateIndex] / (mpeg1 ? 1 : versionBits === 2 ? 2 : 4);
  const bitrate =
    MP3_BITRATES_KBPS[layer as 1 | 2 | 3][mpeg1 ? 0 : 1][bitrateIndex] * 1000;
  const padding = (header >>> 9) & 1;
  const samples = layer === 1 ? 384 : layer === 3 && !mpeg1 ? 576 : 1152;
  const length =
    layer === 1
      ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
      : Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  return {
    length,
    samples,
    sampleRate,
    mpeg1,
    mono: ((header >>> 6) & 3) === 3,
  };
}

function mp3Duration(data: Buffer, start: number): number | undefined {
  // The first frame is the first sync whose successor also parses, so stray
  // sync bits inside leftover tag bytes are not mistaken for audio.
  let offset = start;
  let first: Mp3Frame | undefined;
  for (const limit = Math.min(data.length, start + 64 * 1024); ; offset++) {
    if (offset >= limit) return;
    first = mp3Frame(data, offset);
    if (first && mp3Frame(data, offset + first.length)) break;
  }

  // A VBR header (Xing/Info or VBRI) in the first frame states the frame
  // count; its LAME extension also states the encoder delay and padding,
  // which decoders trim.
  const side = first.mpeg1 ? (first.mono ? 17 : 32) : first.mono ? 9 : 17;
  const xing = offset + 4 + side;
  const tag = ascii(data, xing, xing + 4);
  if ((tag === "Xing" || tag === "Info") && data[xing + 7] & 1) {
    const frames = data.readUInt32BE(xing + 8);
    const flags = data[xing + 7];
    const lame =
      xing +
      8 +
      4 +
      (flags & 2 ? 4 : 0) +
      (flags & 4 ? 100 : 0) +
      (flags & 8 ? 4 : 0);
    let trimmed = 0;
    if (/^(LAME|Lavc|Lavf|GOGO)/.test(ascii(data, lame, lame + 4))) {
      const delay = (data[lame + 21] << 4) | (data[lame + 22] >> 4);
      const padding = ((data[lame + 22] & 0x0f) << 8) | data[lame + 23];
      trimmed = delay + padding;
    }
    const samples = frames * first.samples - trimmed;
    return frames ? samples / first.sampleRate : undefined;
  }
  if (ascii(data, offset + 36, offset + 40) === "VBRI") {
    const frames = data.readUInt32BE(offset + 36 + 14);
    return frames ? (frames * first.samples) / first.sampleRate : undefined;
  }

  // Constant bitrate, or VBR without a header: walk every frame.
  let samples = 0;
  let frame: Mp3Frame | undefined = first;
  while (frame) {
    samples += frame.samples;
    offset += frame.length;
    frame = mp3Frame(data, offset);
  }
  return samples / first.sampleRate;
}

function oggDuration(data: Buffer): number | undefined {
  // The first page's packet identifies the codec and its clock.
  const segments = data[26];
  const packet = 27 + segments;
  const serial = data.readUInt32LE(14);
  let rate: number;
  let preSkip = 0;
  if (ascii(data, packet, packet + 7) === "\x01vorbis") {
    rate = data.readUInt32LE(packet + 12);
  } else if (ascii(data, packet, packet + 8) === "OpusHead") {
    rate = 48000; // Opus granule positions always count 48 kHz samples.
    preSkip = data.readUInt16LE(packet + 10);
  } else if (ascii(data, packet, packet + 5) === "\x7fFLAC") {
    const info = packet + 13 + 8;
    rate =
      (data[info + 10] << 12) | (data[info + 11] << 4) | (data[info + 12] >> 4);
  } else {
    return undefined;
  }
  if (!rate) return;
  // The last page of the stream holds the final granule position.
  for (
    let offset = data.lastIndexOf("OggS", data.length - 27, "latin1");
    offset > 0;
    offset = data.lastIndexOf("OggS", offset - 1, "latin1")
  ) {
    if (offset + 27 > data.length || data.readUInt32LE(offset + 14) !== serial)
      continue;
    const granule = Number(data.readBigInt64LE(offset + 6));
    if (granule > 0) return (granule - preSkip) / rate;
  }
  return undefined;
}

function mp4Duration(data: Buffer): number | undefined {
  const moov = mp4Box(data, 0, data.length, "moov");
  const mvhd = moov && mp4Box(data, moov.body, moov.end, "mvhd");
  if (!mvhd) return;
  const version = data[mvhd.body];
  const [timescale, duration] =
    version === 1
      ? [
          data.readUInt32BE(mvhd.body + 20),
          Number(data.readBigUInt64BE(mvhd.body + 24)),
        ]
      : [data.readUInt32BE(mvhd.body + 12), data.readUInt32BE(mvhd.body + 16)];
  return timescale ? duration / timescale : undefined;
}

function mp4Box(
  data: Buffer,
  start: number,
  end: number,
  type: string,
): { body: number; end: number } | undefined {
  for (let offset = start; offset + 8 <= end; ) {
    let size = data.readUInt32BE(offset);
    let header = 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header) return;
    if (ascii(data, offset + 4, offset + 8) === type)
      return { body: offset + header, end: Math.min(offset + size, end) };
    offset += size;
  }
  return undefined;
}
