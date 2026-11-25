import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { type Dispatcher, request } from "undici";
import {
  createPinnedOutboundDispatcher,
  validateOutboundUrl,
} from "@/utils/outbound-url";
import type { FileInputDigest } from "./file-input";
import { multipartFileContentType, type UploadTarget } from "./upload-target";

/**
 * Send one file's bytes to an upload target, as a client of that target.
 *
 * The body is streamed, never buffered: it is counted (and hashed, when the
 * file declares a digest) on the way through, and the request is torn down
 * before it completes if the bytes turn out longer or shorter than declared or
 * do not match the digest. A target never sees a complete body that the file's
 * metadata does not describe.
 *
 * Redirects are never followed and any status outside 2xx is a failed
 * transfer. A 401/403 is a failure like any other: it never starts an
 * authorization flow.
 */
export async function transferFile(params: {
  target: UploadTarget;
  /** Absolute destination: the target's `url`, or its `path` resolved. */
  url: URL;
  file: TransferredFile;
  body: AsyncIterable<Uint8Array>;
  /**
   * The upstream credential header(s), attached only for an `include` target.
   * Must be absent for `omit`.
   */
  credentialHeaders?: Record<string, string>;
  /**
   * Whether the destination must pass the outbound SSRF guard. False only for
   * a `path` target, which resolves under the install's own MCP address.
   */
  guardDestination: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const { target, url, file, body, credentialHeaders, guardDestination } =
    params;
  if (target.credentials === "omit" && credentialHeaders) {
    throw new Error("An omit upload target must not carry credentials");
  }

  let dispatcher: Dispatcher | undefined;
  if (guardDestination) {
    const validation = validateOutboundUrl(url.href);
    if (!validation.ok) {
      throw new FileTransferError(
        `The upload target's address is not allowed (${validation.reason}).`,
      );
    }
    const pinned = await createPinnedOutboundDispatcher({
      hostname: validation.url.hostname,
    });
    if (!pinned.ok) {
      throw new FileTransferError(
        `The upload target's address is not allowed (${pinned.reason}).`,
      );
    }
    dispatcher = pinned.dispatcher;
  }

  const timeoutSignal = AbortSignal.timeout(transferTimeoutMs(file.size));
  const signal = params.signal
    ? AbortSignal.any([params.signal, timeoutSignal])
    : timeoutSignal;

  const encoded = encodeBody({ target, file, body });
  const headers: Record<string, string> = {
    ...(target.headers ?? {}),
    ...(credentialHeaders ?? {}),
    ...encoded.headers,
    "content-length": String(encoded.length),
  };

  try {
    const response = await request(url, {
      method: target.method ?? "PUT",
      headers,
      body: Readable.from(encoded.body),
      signal,
      ...(dispatcher && { dispatcher }),
    });
    // The body is ignored either way; drain it so the socket is released.
    await response.body.dump();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new FileTransferError(
        `The upload target answered HTTP ${response.statusCode}.`,
      );
    }
  } catch (error) {
    if (error instanceof FileTransferError) throw error;
    if (timeoutSignal.aborted) {
      throw new FileTransferError("The upload did not finish in time.");
    }
    if (params.signal?.aborted) throw error;
    throw new FileTransferError(
      `The upload failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await dispatcher?.close();
  }
}

export type TransferredFile = {
  size: number;
  name?: string;
  mimeType: string;
  digest?: FileInputDigest;
};

export class FileTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileTransferError";
  }
}

/**
 * The `filename` a multipart file part carries: the base name of the file's
 * name, split on both separators, or `file` when that leaves nothing usable.
 *
 * @internal exported for tests
 */
export function multipartFilename(name: string | undefined): string {
  const base = (name ?? "").split(/[/\\]/).pop() ?? "";
  return base === "" || base === "." || base === ".." ? "file" : base;
}

/**
 * Yield the file's bytes, failing the stream as soon as they exceed the
 * declared size and, at the end, when they fall short or miss the digest.
 *
 * The last chunk is held back until those checks pass. The target was told
 * the exact length, so without its final bytes it never holds a complete
 * file: a check that fails leaves the target with a short body to discard,
 * never a whole file that merely did not match.
 *
 * @internal exported for tests
 */
export async function* checkedBytes(
  body: AsyncIterable<Uint8Array>,
  file: Pick<TransferredFile, "size" | "digest">,
): AsyncGenerator<Uint8Array> {
  const hash = file.digest ? createHash("sha256") : undefined;
  let received = 0;
  let held: Uint8Array | undefined;
  for await (const chunk of body) {
    received += chunk.length;
    if (received > file.size) {
      throw new FileTransferError(
        `The file is longer than its declared ${file.size} bytes.`,
      );
    }
    hash?.update(chunk);
    if (held) yield held;
    held = chunk;
  }
  if (received !== file.size) {
    throw new FileTransferError(
      `The file is ${received} bytes, not its declared ${file.size}.`,
    );
  }
  if (hash && file.digest && hash.digest("base64url") !== file.digest.value) {
    throw new FileTransferError("The file does not match its sha-256 digest.");
  }
  if (held) yield held;
}

// === Internal helpers ===

/** Minimum time a transfer gets, before its size adds more. */
const MIN_TRANSFER_TIMEOUT_MS = 120_000;
/** Time added per MiB, i.e. a floor of ~0.5 MiB/s. */
const TRANSFER_TIMEOUT_MS_PER_MIB = 2_000;

function transferTimeoutMs(size: number): number {
  return (
    MIN_TRANSFER_TIMEOUT_MS +
    Math.ceil(size / (1024 * 1024)) * TRANSFER_TIMEOUT_MS_PER_MIB
  );
}

function encodeBody(params: {
  target: UploadTarget;
  file: TransferredFile;
  body: AsyncIterable<Uint8Array>;
}): {
  body: AsyncIterable<Uint8Array>;
  length: number;
  headers: Record<string, string>;
} {
  const { target, file } = params;
  const bytes = checkedBytes(params.body, file);
  if (!target.form) {
    // Content-Type is exactly what the target lists, or absent.
    return { body: bytes, length: file.size, headers: {} };
  }

  // RFC 7578 multipart/form-data: each field in order, then the file last.
  const boundary = `archestra-${randomBytes(24).toString("hex")}`;
  const preamble = Buffer.from(
    [
      ...target.form.fields.map(
        (field) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(field.name)}"\r\n\r\n${field.value}\r\n`,
      ),
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(target.form.fileField)}"; filename="${escapeQuoted(multipartFilename(file.name))}"\r\nContent-Type: ${multipartFileContentType(file.mimeType)}\r\n\r\n`,
    ].join(""),
    "utf8",
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  async function* multipart(): AsyncGenerator<Uint8Array> {
    yield preamble;
    yield* bytes;
    yield epilogue;
  }

  return {
    body: multipart(),
    length: preamble.length + file.size + epilogue.length,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** WHATWG multipart quoting: `"`, CR and LF are percent-encoded. */
function escapeQuoted(value: string): string {
  return value
    .replaceAll('"', "%22")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}
