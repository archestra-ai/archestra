import { getMediaType } from "@archestra/shared";
import type { Agent as UndiciAgent } from "undici";
import config from "@/config";
import {
  createPinnedOutboundDispatcher,
  type OutboundUrlRejection,
  validateOutboundUrl,
} from "@/utils/outbound-url";
import { A2AError, A2AErrorKind } from "./a2a-base";
import type { A2AProtocolPart } from "./a2a-protocol";

/**
 * Turn the file parts of an inbound message into bytes the run can use.
 *
 * A file part arrives either inline (`raw`) or by reference (`url`). The run
 * only ever reads `raw` + `mediaType`, so a `url` part is downloaded here and
 * every file part leaves with both set; `url` is kept on the part so the
 * stored message still says where the file came from.
 *
 * It runs at the protocol edge, after the caller is authenticated and before a
 * task exists: a file that is too large, empty, or unreachable refuses the
 * request with a JSON-RPC error naming the part, rather than starting a run
 * that silently lacks the file the instruction is about.
 */
export async function resolveInboundFileParts(
  parts: A2AProtocolPart[] | undefined,
): Promise<A2AProtocolPart[] | undefined> {
  if (!parts?.some(isFilePart)) return parts;

  const fileCount = parts.filter(isFilePart).length;
  if (fileCount > MAX_FILE_PARTS) {
    throw new A2AError(
      A2AErrorKind.InvalidFilePart,
      `a message may carry at most ${MAX_FILE_PARTS} files`,
    );
  }

  const perFileLimit = config.chat.attachmentStorageBytesLimit;
  let remainingBytes = config.api.bodyLimit;
  const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const resolved: A2AProtocolPart[] = [];
  for (const [index, part] of parts.entries()) {
    if (!isFilePart(part)) {
      resolved.push(part);
      continue;
    }
    const filename = part.filename || filenameFromUrl(part.url);
    const label = filename ? `"${filename}"` : `at index ${index}`;
    let raw = part.raw;
    let fetchedMediaType: string | undefined;
    if (raw === undefined) {
      const fetched = await fetchFilePart({
        url: part.url as string,
        maxBytes: Math.min(perFileLimit, remainingBytes),
        label,
        signal: deadline,
      });
      raw = fetched.bytes;
      fetchedMediaType = fetched.mediaType;
    }
    if (raw.byteLength === 0) {
      throw new A2AError(
        A2AErrorKind.InvalidFilePart,
        `file part ${label} is empty`,
      );
    }
    if (raw.byteLength > perFileLimit) {
      throw new A2AError(
        A2AErrorKind.InvalidFilePart,
        tooLargeDetail(label, perFileLimit),
      );
    }
    remainingBytes -= raw.byteLength;
    resolved.push({
      ...part,
      raw,
      filename,
      mediaType:
        part.mediaType ||
        fetchedMediaType ||
        getMediaType({ name: filename ?? "", type: "" }),
    });
  }
  return resolved;
}

/**
 * The same parts as they are stored and returned in task history: without the
 * bytes. A message row is read on every turn of its context, so megabytes of
 * file content have no place in it, and `raw` (a `Uint8Array`) does not survive
 * JSON at all. A part that came by `url` keeps the reference; an inline one
 * becomes a text part naming the file, so history stays a valid `Part` list.
 */
export function toStoredParts(parts: A2AProtocolPart[]): A2AProtocolPart[] {
  return parts.map((part) => {
    if (part.raw === undefined) return part;
    const { raw, ...rest } = part;
    if (rest.url !== undefined) return rest;
    if (rest.text !== undefined && rest.text.trim() !== "") return rest;
    const { filename, mediaType, text: _blank, ...kept } = rest;
    return {
      ...kept,
      text: `[file: ${filename ?? "unnamed"} (${mediaType ?? "application/octet-stream"}, ${raw.byteLength} bytes)]`,
    };
  });
}

// === Internal helpers ===

/** Same ceiling as the attachments an Agent Runtime task accepts. */
const MAX_FILE_PARTS = 20;
/** One budget for every download in the message, so 20 slow hosts cannot stack. */
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const URL_REJECTION_DETAIL: Record<OutboundUrlRejection, string> = {
  not_a_url: "is not an absolute URL",
  scheme_not_https: "must use https",
  userinfo_not_allowed: "must not embed credentials",
  private_or_loopback_host: "points at a private or loopback address",
};

function isFilePart(part: A2AProtocolPart): boolean {
  return part.raw !== undefined || part.url !== undefined;
}

function tooLargeDetail(label: string, limit: number): string {
  return `file part ${label} is larger than the ${Math.floor(limit / 1024 / 1024)} MB limit`;
}

/**
 * Download a `url` part. The URL comes from the caller and is dialed by the
 * server, so every hop — the URL itself and each redirect — passes the outbound
 * URL rules and is pinned to the address that was checked. No credentials are
 * sent, and nothing from the response but its bytes and media type is used.
 */
async function fetchFilePart(params: {
  url: string;
  maxBytes: number;
  label: string;
  signal: AbortSignal;
}): Promise<{ bytes: Uint8Array; mediaType: string | undefined }> {
  const { label, signal } = params;
  const fail = (detail: string) =>
    new A2AError(
      A2AErrorKind.InvalidFilePart,
      `file part ${label} could not be fetched: ${detail}`,
    );

  let url = params.url;
  for (let redirects = 0; ; redirects++) {
    const validated = validateOutboundUrl(url);
    if (!validated.ok) {
      throw fail(`the URL ${URL_REJECTION_DETAIL[validated.reason]}`);
    }
    const pinned = await createPinnedOutboundDispatcher({
      hostname: validated.url.hostname,
    });
    if (!pinned.ok) {
      throw fail(
        pinned.reason === "unresolved_host"
          ? "the host did not resolve"
          : "the host resolves to a private or loopback address",
      );
    }
    const dispatcher: UndiciAgent = pinned.dispatcher;
    try {
      let response: Response;
      try {
        response = await fetch(validated.url, {
          redirect: "manual",
          signal,
          dispatcher,
        } as RequestInit);
      } catch {
        throw fail(
          signal.aborted ? "the request timed out" : "the request failed",
        );
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects >= MAX_REDIRECTS) {
          throw fail("too many redirects");
        }
        url = new URL(location, validated.url).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw fail(`the server answered HTTP ${response.status}`);
      }
      const bytes = await readBounded({
        response,
        maxBytes: params.maxBytes,
        onTooLarge: () =>
          new A2AError(
            A2AErrorKind.InvalidFilePart,
            tooLargeDetail(label, params.maxBytes),
          ),
        onFailure: () =>
          fail(signal.aborted ? "the request timed out" : "the request failed"),
      });
      const mediaType = response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase();
      return {
        bytes,
        // A generic type says nothing; let the filename decide instead.
        mediaType:
          mediaType && mediaType !== "application/octet-stream"
            ? mediaType
            : undefined,
      };
    } finally {
      await dispatcher.destroy().catch(() => undefined);
    }
  }
}

/** Read a body up to `maxBytes`, stopping the download as soon as it overruns. */
async function readBounded(params: {
  response: Response;
  maxBytes: number;
  onTooLarge: () => Error;
  onFailure: () => Error;
}): Promise<Uint8Array> {
  const { response, maxBytes } = params;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw params.onTooLarge();
  }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw params.onTooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof A2AError) throw error;
    throw params.onFailure();
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

function filenameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}
