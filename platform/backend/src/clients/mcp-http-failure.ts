import { STATUS_CODES } from "node:http";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Wraps the fetch of an MCP HTTP transport so a failed response carries a
 * body a person can read.
 *
 * The MCP SDK puts the whole body of a failed response into its error text,
 * and that text reaches the model and the chat card. Many servers, and the
 * proxies in front of them, answer a rate limit or an outage with an HTML
 * page. A short plain-text or JSON body is kept as it is, because it usually
 * says what went wrong. An HTML page or a long body is replaced with one
 * sentence that names the status.
 */
export function withReadableHttpFailures(baseFetch?: FetchLike): FetchLike {
  return async (url, init) => {
    // The global fetch is read at call time, as the transport itself does.
    const response = await (baseFetch ?? fetch)(url, init);
    // Only an error status has a body worth rewriting. A response can be
    // rebuilt for statuses 200 to 599 only: a redirect the transport did not
    // follow has status 0, and a server can answer with a code above 599.
    if (response.status < 400 || response.status > 599) return response;
    // Reading the body consumes it, so the response is rebuilt either way.
    const body = await response.text().catch(() => "");
    return rebuildResponse(
      response,
      readableHttpFailureBody(response.status, body),
    );
  };
}

/**
 * What a failed tool call tells the model and the chat card. An HTTP failure
 * reads as its status and what to do about it, followed by the server's own
 * words when it sent any.
 */
export function describeToolCallFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof StreamableHTTPError)) return message;
  const status = error.code;
  if (status === undefined || status <= 0) return message;

  const summary = httpFailureSummary(status);
  const guidance =
    status === 429 ? " It is limiting requests. Try again in a minute." : "";
  const detail = message.replace(SDK_HTTP_ERROR_PREFIX, "").trim();
  return detail && detail !== summary
    ? `${summary}${guidance} Server response: ${detail}`
    : `${summary}${guidance}`;
}

// === Internal helpers ===

/** A body longer than this is not an error message a person would read. */
const READABLE_BODY_MAX_LENGTH = 2_000;

/** The text the SDK puts before the body of a failed POST. */
const SDK_HTTP_ERROR_PREFIX =
  /^Streamable HTTP error: (?:Error POSTing to endpoint: )?/;

const HTML_BODY = /^<(?:!doctype|html|head|body|\?xml)\b|<html[\s>]/i;

function httpFailureSummary(status: number): string {
  const reason = STATUS_CODES[status];
  return `The MCP server returned HTTP ${status}${reason ? ` (${reason})` : ""}.`;
}

function readableHttpFailureBody(status: number, body: string): string {
  const text = body.trim();
  if (!text || text.length > READABLE_BODY_MAX_LENGTH || HTML_BODY.test(text)) {
    return httpFailureSummary(status);
  }
  return body;
}

function rebuildResponse(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  // The original length and encoding describe the body that was replaced.
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
