import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import logger from "@/logging";

/**
 * Bridge between a Fastify route and `git http-backend` (CGI). Reads the CGI
 * header block from the child's stdout, hands it to the raw HTTP response, and
 * pipes the rest of stdout straight through. The Fastify reply must already be
 * `.hijack()`ed by the caller — we own the raw socket from that point.
 *
 * `git http-backend` is the path of least resistance: it speaks both the v0
 * and v2 smart-HTTP protocols and handles pack negotiation. Do not hand-roll
 * the protocol.
 */

interface ServeGitHttpRequestParams {
  /** Parent directory that contains the bare/non-bare repo. */
  projectRoot: string;
  /** Path inside `projectRoot` the client requested, e.g. `/repo.git/info/refs`. */
  pathInfo: string;
  queryString: string;
  requestMethod: string;
  contentType?: string;
  contentLength?: string;
  /** Value of the client's `Git-Protocol` header (e.g. `version=2`); enables protocol v2. */
  gitProtocol?: string;
  /** Optional identifier surfaced to the CGI script (for audit). */
  remoteUser?: string;
  /** Optional override for the git binary (tests, alt installs). */
  gitBinaryPath?: string;
  req: IncomingMessage;
  res: ServerResponse;
}

export async function serveGitHttpRequest(
  params: ServeGitHttpRequestParams,
): Promise<void> {
  const binary = params.gitBinaryPath ?? "git";
  const child = spawn(binary, ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: params.projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: params.pathInfo,
      QUERY_STRING: params.queryString,
      REQUEST_METHOD: params.requestMethod,
      ...(params.contentType ? { CONTENT_TYPE: params.contentType } : {}),
      ...(params.contentLength ? { CONTENT_LENGTH: params.contentLength } : {}),
      ...(params.gitProtocol ? { GIT_PROTOCOL: params.gitProtocol } : {}),
      ...(params.remoteUser ? { REMOTE_USER: params.remoteUser } : {}),
    },
  });

  await runCgiBridge({ child, req: params.req, res: params.res });
}

interface RunCgiBridgeParams {
  child: ChildProcessWithoutNullStreams;
  req: IncomingMessage;
  res: ServerResponse;
}

async function runCgiBridge(params: RunCgiBridgeParams): Promise<void> {
  const { child, req, res } = params;

  req.pipe(child.stdin);
  child.stdin.on("error", (err) => {
    logger.warn({ err }, "git-http-backend: child stdin error");
  });

  const MAX_STDERR_BYTES = 64 * 1024;
  // tail-buffer: the operative fatal usually arrives at the END of stderr,
  // so drop the oldest bytes when we exceed the cap rather than the newest
  let stderrBuf = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > MAX_STDERR_BYTES) {
      stderrBuf = stderrBuf.slice(stderrBuf.length - MAX_STDERR_BYTES);
    }
  });

  const MAX_HEADER_BYTES = 64 * 1024;
  let headersBuf = Buffer.alloc(0);
  let headersFlushed = false;

  const flushBufferedBody = (rest: Buffer) => {
    if (rest.length > 0) res.write(rest);
  };

  const parseAndFlushHeaders = (): boolean => {
    const split = findHeaderTerminator(headersBuf);
    if (!split) return false;

    const headerBytes = headersBuf.slice(0, split.headerEnd);
    const remainder = headersBuf.slice(split.bodyStart);
    headersBuf = Buffer.alloc(0);

    const { status, headers } = parseCgiHeaders(headerBytes.toString("utf8"));
    res.writeHead(status, headers);
    flushBufferedBody(remainder);
    headersFlushed = true;
    return true;
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (headersFlushed) {
      res.write(chunk);
      return;
    }
    headersBuf = Buffer.concat([headersBuf, chunk]);
    if (parseAndFlushHeaders()) return;
    if (headersBuf.length > MAX_HEADER_BYTES) {
      child.kill("SIGTERM");
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("git http-backend: response headers too large");
      }
    }
  });

  return new Promise<void>((resolve) => {
    const finish = () => {
      if (!res.writableEnded) res.end();
      resolve();
    };

    child.once("error", (err) => {
      logger.error({ err }, "git-http-backend: spawn error");
      if (!headersFlushed && !res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("git http-backend failed to start");
      }
      finish();
    });

    child.once("close", (code) => {
      if (!headersFlushed) {
        // child exited without emitting CGI headers — surface as 502
        logger.error(
          { code, stderr: stderrBuf.trim() },
          "git-http-backend: child exited without headers",
        );
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("git http-backend produced no response");
        }
        finish();
        return;
      }
      if (code !== 0) {
        logger.warn(
          { code, stderr: stderrBuf.trim() },
          "git-http-backend: child exited non-zero after streaming headers",
        );
      }
      finish();
    });

    // req.once("aborted") is removed in Node 18+; use res.once("close") instead
    res.once("close", () => {
      if (!child.killed) child.kill("SIGTERM");
    });
  });
}

// ===== Internal helpers =====

interface HeaderSplit {
  headerEnd: number;
  bodyStart: number;
}

/** Locate the CGI header terminator (CRLFCRLF or LFLF). */
function findHeaderTerminator(buf: Buffer): HeaderSplit | null {
  const crlfIdx = indexOfSequence(buf, CRLF_CRLF);
  if (crlfIdx !== -1) {
    return { headerEnd: crlfIdx, bodyStart: crlfIdx + CRLF_CRLF.length };
  }
  const lfIdx = indexOfSequence(buf, LF_LF);
  if (lfIdx !== -1) {
    return { headerEnd: lfIdx, bodyStart: lfIdx + LF_LF.length };
  }
  return null;
}

function indexOfSequence(haystack: Buffer, needle: Buffer): number {
  return haystack.indexOf(needle);
}

const CRLF_CRLF = Buffer.from("\r\n\r\n", "ascii");
const LF_LF = Buffer.from("\n\n", "ascii");

interface ParsedCgiHeaders {
  status: number;
  headers: Record<string, string>;
}

function parseCgiHeaders(raw: string): ParsedCgiHeaders {
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  let status = 200;
  const headers: Record<string, string> = {};

  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key.toLowerCase() === "status") {
      const code = Number.parseInt(value.split(" ")[0], 10);
      if (Number.isFinite(code)) status = code;
      continue;
    }
    headers[key] = value;
  }

  return { status, headers };
}
