import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "vitest";
import {
  describeToolCallFailure,
  withReadableHttpFailures,
} from "./mcp-http-failure";

const HTML_PAGE = `<!doctype html>
<html lang="en">
  <head><title>Too Many Requests</title></head>
  <body>${"<p>We are on a journey.</p>".repeat(400)}</body>
</html>`;

function fetchReturning(response: () => Response) {
  return withReadableHttpFailures(async () => response());
}

describe("withReadableHttpFailures", () => {
  test("replaces an HTML error page with one sentence that names the status", async () => {
    const response = await fetchReturning(
      () =>
        new Response(HTML_PAGE, {
          status: 429,
          headers: { "content-type": "text/html", "retry-after": "30" },
        }),
    )("https://mcp.example/mcp");

    expect(response.status).toBe(429);
    expect(await response.text()).toBe(
      "The MCP server returned HTTP 429 (Too Many Requests).",
    );
    // The caller still reads the headers it acts on.
    expect(response.headers.get("retry-after")).toBe("30");
  });

  test("keeps a short error body, which says what went wrong", async () => {
    const body = '{"error":"invalid_token","error_description":"expired"}';
    const response = await fetchReturning(
      () => new Response(body, { status: 401 }),
    )("https://mcp.example/mcp");

    expect(await response.text()).toBe(body);
  });

  test("keeps the session-expired text the client retries on", async () => {
    const response = await fetchReturning(
      () => new Response("Session not found", { status: 404 }),
    )("https://mcp.example/mcp");

    expect(await response.text()).toBe("Session not found");
  });

  test("replaces a body too long to be an error message", async () => {
    const response = await fetchReturning(
      () => new Response("x".repeat(5_000), { status: 502 }),
    )("https://mcp.example/mcp");

    expect(await response.text()).toBe(
      "The MCP server returned HTTP 502 (Bad Gateway).",
    );
  });

  test("leaves a status no response can be rebuilt for as the server sent it", async () => {
    // Node reports such a status but refuses to build a Response with it.
    const original = Object.defineProperty(
      new Response(HTML_PAGE, { status: 599 }),
      "status",
      { value: 999 },
    );
    const response = await fetchReturning(() => original)(
      "https://mcp.example/mcp",
    );

    expect(response).toBe(original);
  });

  test("leaves a successful response untouched, stream included", async () => {
    const original = new Response(HTML_PAGE, { status: 200 });
    const response = await fetchReturning(() => original)(
      "https://mcp.example/mcp",
    );

    expect(response).toBe(original);
  });
});

describe("describeToolCallFailure", () => {
  test("tells a rate-limited caller what happened and what to do", () => {
    const error = new StreamableHTTPError(
      429,
      "Error POSTing to endpoint: The MCP server returned HTTP 429 (Too Many Requests).",
    );

    expect(describeToolCallFailure(error)).toBe(
      "The MCP server returned HTTP 429 (Too Many Requests). It is limiting requests. Try again in a minute.",
    );
  });

  test("adds the server's own words when it sent any", () => {
    const error = new StreamableHTTPError(
      400,
      'Error POSTing to endpoint: {"error":"unknown tool"}',
    );

    expect(describeToolCallFailure(error)).toBe(
      'The MCP server returned HTTP 400 (Bad Request). Server response: {"error":"unknown tool"}',
    );
  });

  test("leaves a failure with no HTTP status as it is", () => {
    expect(describeToolCallFailure(new Error("socket hang up"))).toBe(
      "socket hang up",
    );
    expect(
      describeToolCallFailure(
        new StreamableHTTPError(-1, "Unexpected content type: text/html"),
      ),
    ).toBe("Streamable HTTP error: Unexpected content type: text/html");
  });
});
