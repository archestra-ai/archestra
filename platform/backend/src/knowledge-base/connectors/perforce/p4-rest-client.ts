import type pino from "pino";

/**
 * Minimal client for the P4 (Helix Core) REST API.
 *
 * The REST API is served by the built-in P4 web server (`p4 webserver`) under
 * `/api`, introduced as a Technology Preview in P4 Server 2025.2. Listing
 * endpoints return line-delimited JSON (`application/jsonl`); file content is
 * returned raw by `/v0/file/contents`.
 *
 * Authentication is HTTP Basic with the P4 username and a login ticket as the
 * password. The ticket must be valid for all hosts (`p4 login -a -p`) because
 * the REST API host differs from the client host.
 *
 * The API has no `p4 changes` equivalent, so {@link latestChange} derives the
 * newest submitted changelist for a filespec from the head revisions reported
 * by `/v0/file/revisions` (sorted by date, capped to one result).
 *
 * Security properties:
 * - the ticket is sent only in the Authorization header, never in URLs
 * - the ticket is redacted from every thrown error message
 * - responses are size-capped: listings to {@link MAX_LISTING_BYTES}, file
 *   content to {@link MAX_FILE_BYTES} (enforced server-side via the `size`
 *   query parameter and re-checked client-side)
 */
export class P4RestClient {
  private baseUrl: string;
  private username: string;
  private ticket: string;
  private log: pino.Logger;

  constructor(params: {
    serverUrl: string;
    username: string;
    ticket: string;
    log: pino.Logger;
  }) {
    this.baseUrl = parseBaseUrl(params.serverUrl);
    this.username = params.username;
    this.ticket = params.ticket;
    this.log = params.log;
  }

  /** `GET /api/v0/server/info` — connectivity and authentication probe. */
  async info(): Promise<Record<string, unknown>> {
    const response = await this.request("/api/v0/server/info");
    await this.assertOk(response, { connectionLevel: true });
    const body = (await this.readCapped(response, MAX_LISTING_BYTES)).trim();
    const parsed = parseJsonRecord(body);
    if (!parsed) {
      throw new P4ApiError(
        `Unexpected non-JSON response from server info: ${this.redact(truncate(body))}`,
        { connectionLevel: true },
      );
    }
    return parsed;
  }

  /**
   * Newest submitted changelist affecting the filespec, with its submit time —
   * derived from the most recent head revision under the filespec (the REST
   * API has no changelist-listing endpoint). Returns null when the path has
   * no matching files (e.g. an empty or non-existent depot path).
   */
  async latestChange(
    filespec: string,
  ): Promise<{ change: number; time?: string } | null> {
    const revisions = await this.listRevisions({
      filespecs: [filespec],
      max: 1,
      sort: "date",
      order: "desc",
    });
    const newest = revisions[0];
    if (!newest) return null;
    return { change: newest.change, time: newest.time };
  }

  /**
   * Depot files matching the filespecs at their given revision specifiers,
   * via `GET /api/v0/file/revisions`. Deleted/purged/archived head revisions
   * are filtered out (the REST API has no `p4 files -e` equivalent). Returns
   * an empty array when nothing matches.
   */
  async files(
    filespecs: string[],
    options?: { max?: number },
  ): Promise<P4DepotFile[]> {
    if (filespecs.length === 0) return [];
    const revisions = await this.listRevisions({
      filespecs,
      max: options?.max,
    });
    return revisions
      .filter((revision) => !DELETED_ACTIONS.has(revision.action))
      .map(({ depotFile, rev, change, action, type }) => ({
        depotFile,
        rev,
        change,
        action,
        type,
      }));
  }

  /**
   * File content at the given revision specifier via
   * `GET /api/v0/file/contents`. Throws {@link P4FileTooLargeError} when the
   * file exceeds the content cap.
   */
  async readFile(filespec: string): Promise<string> {
    const response = await this.request("/api/v0/file/contents", {
      fileSpec: filespec,
      // One byte past the cap distinguishes "exactly at the cap" from
      // "truncated by the server because it is larger".
      size: String(MAX_FILE_BYTES + 1),
    });
    if (response.status === 404) {
      await this.consumeBody(response);
      throw new P4ApiError(`File not found: ${filespec}`);
    }
    await this.assertOk(response);
    const content = await this.readCapped(response, MAX_FILE_BYTES + 1);
    if (byteLength(content) > MAX_FILE_BYTES) {
      throw new P4FileTooLargeError(filespec, MAX_FILE_BYTES);
    }
    return content;
  }

  // ===== Private methods =====

  /** Shared `/v0/file/revisions` query with JSONL parsing and 404→empty handling. */
  private async listRevisions(params: {
    filespecs: string[];
    max?: number;
    sort?: string;
    order?: string;
  }): Promise<P4FileRevision[]> {
    const query: Array<[string, string]> = params.filespecs.map((spec) => [
      "fileSpec",
      spec,
    ]);
    query.push(["fields", REVISION_FIELDS]);
    if (params.max !== undefined) query.push(["max", String(params.max)]);
    if (params.sort) query.push(["sort", params.sort]);
    if (params.order) query.push(["order", params.order]);

    const response = await this.request("/api/v0/file/revisions", query);
    // The API reports "no such file(s)" filespecs as 404 with a JSON error
    // body — an empty result, not a failure (matching `p4 files` warnings).
    if (response.status === 404) {
      const body = await this.readCapped(response, MAX_LISTING_BYTES);
      this.log.debug(
        { message: this.redact(truncate(extractErrorMessage(body) ?? body)) },
        "p4 file/revisions returned no matching files",
      );
      return [];
    }
    await this.assertOk(response, { connectionLevel: false });
    const body = await this.readCapped(response, MAX_LISTING_BYTES);

    const revisions: P4FileRevision[] = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const record = parseJsonRecord(trimmed);
      if (!record) {
        throw new P4ApiError(
          `Unexpected non-JSON line in file/revisions response: ${this.redact(truncate(trimmed))}`,
        );
      }
      // Inline error records can appear in a 200 JSONL stream.
      const inlineError = extractRecordError(record);
      if (inlineError !== null) {
        if (NO_MATCHING_FILES_PATTERN.test(inlineError)) continue;
        throw new P4ApiError(
          `p4 file/revisions reported an error: ${this.redact(truncate(inlineError))}`,
        );
      }
      revisions.push(parseRevisionRecord(record));
    }
    return revisions;
  }

  private async request(
    path: string,
    query?: Record<string, string> | Array<[string, string]>,
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    const entries = Array.isArray(query) ? query : Object.entries(query ?? {});
    for (const [key, value] of entries) {
      url.searchParams.append(key, value);
    }
    try {
      return await fetch(url, {
        headers: {
          authorization: `Basic ${Buffer.from(`${this.username}:${this.ticket}`).toString("base64")}`,
          accept: "*/*",
        },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        // Deliberately NOT connection-level: a single oversized/slow file
        // download timing out is a per-file failure, not a broken server.
        // Timeouts on listing/info requests still abort the sync because the
        // connector does not catch errors from those calls.
        throw new P4ApiError(
          `P4 REST API request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        );
      }
      throw new P4ApiError(
        `Could not reach the P4 REST API at ${this.baseUrl}: ${this.redact(errorMessage(error))}`,
        { connectionLevel: true },
      );
    }
  }

  /**
   * Map non-2xx responses to errors. Auth failures are always
   * connection-level; other statuses default to per-item severity unless the
   * caller says otherwise.
   */
  private async assertOk(
    response: Response,
    options?: { connectionLevel?: boolean },
  ): Promise<void> {
    if (response.ok) return;
    const body = await this.readCapped(response, MAX_LISTING_BYTES);
    const detail =
      extractErrorMessage(body) ?? truncate(body) ?? response.statusText;
    if (response.status === 401 || response.status === 403) {
      throw new P4ApiError(
        `P4 REST API authentication failed (${response.status}): ${this.redact(detail)}. ` +
          "Check the username and ticket; the ticket must be valid for all hosts (p4 login -a -p).",
        { connectionLevel: true },
      );
    }
    throw new P4ApiError(
      `P4 REST API request failed (${response.status}): ${this.redact(detail)}`,
      { connectionLevel: options?.connectionLevel ?? false },
    );
  }

  /** Read a response body, failing loudly if it exceeds the byte cap. */
  private async readCapped(
    response: Response,
    maxBytes: number,
  ): Promise<string> {
    const text = await response.text();
    if (byteLength(text) > maxBytes) {
      throw new P4ApiError(
        `P4 REST API response exceeded the ${Math.round(maxBytes / (1024 * 1024))}MB limit`,
      );
    }
    return text;
  }

  /** Drain a body we do not care about so the connection can be reused. */
  private async consumeBody(response: Response): Promise<void> {
    try {
      await response.arrayBuffer();
    } catch {
      // The body is irrelevant; ignore read failures.
    }
  }

  private redact(text: string): string {
    if (!this.ticket) return text;
    return text.split(this.ticket).join("***");
  }
}

/** A depot file as reported by `/v0/file/revisions`. */
export interface P4DepotFile {
  depotFile: string;
  rev: number;
  change: number;
  action: string;
  type: string;
}

export class P4ApiError extends Error {
  readonly connectionLevel: boolean;

  constructor(message: string, options?: { connectionLevel?: boolean }) {
    super(message);
    this.connectionLevel = options?.connectionLevel ?? false;
  }
}

export class P4FileTooLargeError extends Error {
  constructor(filespec: string, maxBytes: number) {
    super(
      `File exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB indexing limit: ${filespec}`,
    );
  }
}

/**
 * Errors that indicate the server connection or authentication is broken —
 * these abort a sync instead of being recorded as per-file failures.
 */
export function isConnectionLevelError(error: unknown): boolean {
  return error instanceof P4ApiError && error.connectionLevel;
}

// ===== Internal helpers =====

const REQUEST_TIMEOUT_MS = 30_000;
/** Cap for listing/metadata responses (file listings of large depots). */
const MAX_LISTING_BYTES = 64 * 1024 * 1024;
/** Per-file content cap; larger files are skipped. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Head-revision actions that mean the file no longer exists at head. */
const DELETED_ACTIONS = new Set(["delete", "move/delete", "purge", "archive"]);
const NO_MATCHING_FILES_PATTERN =
  /no such file\(s\)|no file\(s\) matching|not in client view/i;
const REVISION_FIELDS =
  "depotFile,headRev,headChange,headAction,headType,headTime";

interface P4FileRevision extends P4DepotFile {
  time?: string;
}

function parseBaseUrl(serverUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new P4ApiError(`Invalid P4 REST API server URL: ${serverUrl}`, {
      connectionLevel: true,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new P4ApiError(
      `P4 REST API server URL must use http(s), got: ${serverUrl}`,
      { connectionLevel: true },
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function parseRevisionRecord(record: Record<string, unknown>): P4FileRevision {
  const depotFile = String(record.depotFile ?? "");
  // headRev/headChange are strings in the REST API responses.
  const rev = Number.parseInt(String(record.headRev), 10);
  const change = Number.parseInt(String(record.headChange), 10);
  if (!depotFile || Number.isNaN(rev) || Number.isNaN(change)) {
    throw new P4ApiError(
      `file/revisions returned a malformed record for ${depotFile || "<unknown file>"}`,
    );
  }
  const time =
    typeof record.headTime === "string" ? record.headTime : undefined;
  return {
    depotFile,
    rev,
    change,
    action: String(record.headAction ?? ""),
    type: String(record.headType ?? ""),
    time,
  };
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** Message of an inline `{errors: [...]}` record, or null if not an error record. */
function extractRecordError(record: Record<string, unknown>): string | null {
  if (!Array.isArray(record.errors)) return null;
  const messages = record.errors
    .map((entry) =>
      entry && typeof entry === "object"
        ? String((entry as Record<string, unknown>).message ?? "")
        : "",
    )
    .filter(Boolean);
  return messages.join("; ") || "unknown error";
}

/** Pull the message out of a JSON error body when present. */
function extractErrorMessage(body: string): string | null {
  const record = parseJsonRecord(body.trim());
  if (!record) return null;
  return extractRecordError(record);
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Node's fetch wraps network failures in a TypeError whose cause carries
    // the useful detail (e.g. ECONNREFUSED).
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncate(text: string, maxLength = 500): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
