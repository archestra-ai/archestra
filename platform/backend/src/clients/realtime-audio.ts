/** Decode a PCM16 WAV upload, mix channels, and resample to Realtime's 24 kHz mono. */
export function wavToRealtimePcm(data: string): Buffer {
  const wav = Buffer.from(data, "base64");
  if (
    wav.length < 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("Realtime audio input must be a PCM16 WAV file.");
  let channels = 0,
    rate = 0,
    pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const kind = wav.toString("ascii", offset, offset + 4);
    const declaredLength = wav.readUInt32LE(offset + 4);
    // Audio generation can return a streaming WAV with an unknown data size.
    const length =
      kind === "data" && declaredLength === 0xffffffff
        ? wav.length - offset - 8
        : declaredLength;
    if (offset + 8 + length > wav.length)
      throw new Error("The WAV audio is truncated.");
    if (kind === "fmt ") {
      if (
        length < 16 ||
        wav.readUInt16LE(offset + 8) !== 1 ||
        wav.readUInt16LE(offset + 22) !== 16
      )
        throw new Error("Realtime audio input must use PCM16 WAV encoding.");
      channels = wav.readUInt16LE(offset + 10);
      rate = wav.readUInt32LE(offset + 12);
    }
    if (kind === "data") pcm = wav.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + (length % 2);
  }
  if (
    !pcm ||
    !channels ||
    channels > 8 ||
    rate < 8000 ||
    rate > 96000 ||
    pcm.length % (channels * 2)
  )
    throw new Error("The WAV audio has an unsupported format.");
  const samples = pcm.length / (channels * 2);
  if (samples / rate > 60)
    throw new Error("Upload at most 60 seconds of audio per Chat turn.");
  const output = Buffer.alloc(Math.floor((samples * 24000) / rate) * 2);
  for (let i = 0; i < output.length / 2; i++) {
    const source = Math.min(Math.floor((i * rate) / 24000), samples - 1);
    let sample = 0;
    for (let channel = 0; channel < channels; channel++)
      sample += pcm.readInt16LE((source * channels + channel) * 2);
    output.writeInt16LE(Math.round(sample / channels), i * 2);
  }
  return output;
}

/** Wrap raw 24 kHz PCM16 mono output so browsers can play the generated speech. */
export function realtimePcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
