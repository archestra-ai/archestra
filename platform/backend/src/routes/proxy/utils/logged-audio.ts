import { LOGGED_MEDIA_MAX_BYTES } from "./logged-media";

/**
 * Collects one clip's bytes as they stream, up to the limit a log row keeps:
 * the speech a model returned, the clip a user uploaded for transcription, a
 * spoken reply.
 */
export class LoggedAudioClip {
  private chunks: Buffer[] = [];
  private size = 0;
  private overLimit = false;

  add(bytes: Uint8Array): void {
    if (this.overLimit || bytes.byteLength === 0) return;
    this.size += bytes.byteLength;
    if (this.size > LOGGED_MEDIA_MAX_BYTES) {
      this.overLimit = true;
      this.chunks = [];
      return;
    }
    this.chunks.push(Buffer.from(bytes));
  }

  addBase64(data: string): void {
    this.add(Buffer.from(data, "base64"));
  }

  /** The clip as base64, or undefined when there is none or it was too long. */
  base64(): string | undefined {
    if (this.overLimit || this.size === 0) return undefined;
    return Buffer.concat(this.chunks).toString("base64");
  }

  /** "too_large" when the clip passed the limit and was not kept. */
  omitted(): "too_large" | undefined {
    return this.overLimit ? "too_large" : undefined;
  }
}

/** The media type of an uploaded clip, from its file name. */
export function audioTypeFromFilename(filename: string): string {
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  return (
    {
      mp3: "audio/mpeg",
      mpga: "audio/mpeg",
      mpeg: "audio/mpeg",
      wav: "audio/wav",
      m4a: "audio/mp4",
      mp4: "audio/mp4",
      ogg: "audio/ogg",
      oga: "audio/ogg",
      opus: "audio/ogg",
      webm: "audio/webm",
      flac: "audio/flac",
    }[extension] ?? "audio/mpeg"
  );
}

/** The media type of OpenAI's speech `response_format`. */
export function speechAudioType(format: unknown): string {
  return (
    {
      mp3: "audio/mpeg",
      opus: "audio/ogg",
      aac: "audio/aac",
      flac: "audio/flac",
      wav: "audio/wav",
      pcm: "audio/pcm",
    }[typeof format === "string" ? format : "mp3"] ?? "audio/mpeg"
  );
}
