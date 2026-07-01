import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import {
  isConnectionLevelError,
  P4ApiError,
  P4FileTooLargeError,
  P4RestClient,
} from "./p4-rest-client";

/**
 * fetch is the process boundary for this client — these tests mock it and
 * nothing else. Handlers receive the parsed URL and the request init and
 * return a Response (or throw, to simulate network failures).
 */
const fetchState: {
  handler:
    | undefined
    | ((url: URL, init: RequestInit) => Response | Promise<Response>);
  calls: Array<{ url: URL; init: RequestInit }>;
} = { handler: undefined, calls: [] };

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    fetchState.calls.push({ url, init });
    if (!fetchState.handler) {
      throw new Error("fetchState.handler not configured in test");
    }
    return fetchState.handler(url, init);
  }),
);

function jsonl(records: Array<Record<string, unknown>>): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function revisionRecord(
  depotFile: string,
  overrides?: Partial<
    Record<
      "headRev" | "headChange" | "headAction" | "headType" | "headTime",
      string
    >
  >,
): Record<string, unknown> {
  return {
    depotFile,
    headRev: overrides?.headRev ?? "1",
    headChange: overrides?.headChange ?? "100",
    headAction: overrides?.headAction ?? "edit",
    headType: overrides?.headType ?? "text",
    headTime: overrides?.headTime ?? "2025-08-27T21:06:41+00:00",
  };
}

function errorBody(message: string, statusCode = 404): string {
  return JSON.stringify({
    errors: [{ code: 838998116, format: message, message, statusCode }],
  });
}

function makeClient(overrides?: {
  ticket?: string;
  serverUrl?: string;
}): P4RestClient {
  return new P4RestClient({
    serverUrl: overrides?.serverUrl ?? "https://perforce.example.com:8080",
    username: "svc-knowledge",
    ticket: overrides?.ticket ?? "super-secret-ticket",
    log,
  });
}

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  // biome-ignore lint/suspicious/noExplicitAny: minimal pino stub for tests
} as any;

describe("P4RestClient", () => {
  beforeEach(() => {
    fetchState.handler = undefined;
    fetchState.calls.length = 0;
    vi.clearAllMocks();
  });

  test("sends basic auth with the ticket as password and never puts it in the URL", async () => {
    fetchState.handler = () =>
      new Response(JSON.stringify({ serverVersion: "P4D/LINUX/2026.1" }), {
        status: 200,
      });

    await makeClient().info();

    const call = fetchState.calls[0];
    expect(call.url.toString()).toBe(
      "https://perforce.example.com:8080/api/v0/server/info",
    );
    expect(call.url.toString()).not.toContain("super-secret-ticket");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("svc-knowledge:super-secret-ticket").toString("base64")}`,
    );
  });

  test("rejects non-http(s) and malformed server URLs at construction", () => {
    expect(() => makeClient({ serverUrl: "ftp://host" })).toThrow(/http/);
    expect(() => makeClient({ serverUrl: "not a url" })).toThrow(/Invalid/);
  });

  test("normalizes a trailing slash off the server URL", async () => {
    fetchState.handler = () => new Response("{}", { status: 200 });

    await makeClient({
      serverUrl: "https://perforce.example.com:8080/",
    }).info();

    expect(fetchState.calls[0].url.pathname).toBe("/api/v0/server/info");
  });

  test("latestChange queries one newest revision and parses change and time", async () => {
    fetchState.handler = () =>
      new Response(
        jsonl([
          revisionRecord("//depot/docs/guide.md", {
            headChange: "120",
            headTime: "2023-11-14T22:13:20+00:00",
          }),
        ]),
        { status: 200 },
      );

    const result = await makeClient().latestChange("//depot/docs/...");

    expect(result).toEqual({
      change: 120,
      time: "2023-11-14T22:13:20+00:00",
    });
    const params = fetchState.calls[0].url.searchParams;
    expect(params.get("fileSpec")).toBe("//depot/docs/...");
    expect(params.get("max")).toBe("1");
    expect(params.get("sort")).toBe("date");
    expect(params.get("order")).toBe("desc");
  });

  test("latestChange returns null when the path has no matching files (404)", async () => {
    fetchState.handler = () =>
      new Response(errorBody("//depot/empty/... - no such file(s)."), {
        status: 404,
      });

    const result = await makeClient().latestChange("//depot/empty/...");

    expect(result).toBeNull();
  });

  test("files maps revision records and passes repeated fileSpec plus the optional max", async () => {
    fetchState.handler = () =>
      new Response(
        jsonl([
          revisionRecord("//depot/docs/guide.md", {
            headRev: "3",
            headChange: "115",
            headType: "text+x",
          }),
          revisionRecord("//depot/docs/old.md", { headAction: "delete" }),
          revisionRecord("//depot/docs/moved.md", {
            headAction: "move/delete",
          }),
        ]),
        { status: 200 },
      );

    const files = await makeClient().files(
      ["//depot/docs/....md@120", "//depot/specs/....md@120"],
      { max: 5 },
    );

    // Deleted/moved head revisions are filtered out (no `-e` equivalent).
    expect(files).toEqual([
      {
        depotFile: "//depot/docs/guide.md",
        rev: 3,
        change: 115,
        action: "edit",
        type: "text+x",
      },
    ]);
    const params = fetchState.calls[0].url.searchParams;
    expect(params.getAll("fileSpec")).toEqual([
      "//depot/docs/....md@120",
      "//depot/specs/....md@120",
    ]);
    expect(params.get("max")).toBe("5");
  });

  test("files returns an empty array on a 404 no-such-files response", async () => {
    fetchState.handler = () =>
      new Response(errorBody("//depot/none/....md - no such file(s)."), {
        status: 404,
      });

    await expect(makeClient().files(["//depot/none/....md"])).resolves.toEqual(
      [],
    );
  });

  test("skips inline no-such-files error records and throws on real inline errors", async () => {
    fetchState.handler = () =>
      new Response(
        `${JSON.stringify({
          errors: [
            {
              message: "//depot/none/....md - no such file(s).",
              statusCode: 404,
            },
          ],
        })}\n${jsonl([revisionRecord("//depot/docs/guide.md")])}`,
        { status: 200 },
      );

    const files = await makeClient().files(["//depot/docs/....md"]);
    expect(files.map((file) => file.depotFile)).toEqual([
      "//depot/docs/guide.md",
    ]);

    fetchState.handler = () =>
      new Response(
        jsonl([{ errors: [{ message: "access denied for this path" }] }]),
        { status: 200 },
      );

    await expect(makeClient().files(["//depot/docs/....md"])).rejects.toThrow(
      /access denied/,
    );
  });

  test("throws on authentication failures with the ticket redacted", async () => {
    fetchState.handler = () =>
      new Response(
        errorBody("Ticket super-secret-ticket invalid or unset.", 401),
        { status: 401 },
      );

    const error = await makeClient()
      .files(["//depot/docs/....md"])
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(P4ApiError);
    expect((error as Error).message).toContain("authentication failed");
    expect((error as Error).message).not.toContain("super-secret-ticket");
    expect((error as Error).message).toContain("***");
    expect(isConnectionLevelError(error)).toBe(true);
  });

  test("throws on non-JSON listing output instead of guessing", async () => {
    fetchState.handler = () =>
      new Response("<html>proxy error</html>", { status: 200 });

    await expect(makeClient().files(["//depot/docs/....md"])).rejects.toThrow(
      /non-JSON/,
    );
  });

  test("throws on malformed revision records", async () => {
    fetchState.handler = () =>
      new Response(
        jsonl([{ depotFile: "//depot/docs/guide.md", headRev: "NaN-ish" }]),
        { status: 200 },
      );

    await expect(makeClient().files(["//depot/docs/....md"])).rejects.toThrow(
      /malformed record/,
    );
  });

  test("readFile returns raw content and caps the download via the size parameter", async () => {
    fetchState.handler = () =>
      new Response("# Guide\n\nHello.", { status: 200 });

    const content = await makeClient().readFile("//depot/docs/guide.md@120");

    expect(content).toBe("# Guide\n\nHello.");
    const params = fetchState.calls[0].url.searchParams;
    expect(params.get("fileSpec")).toBe("//depot/docs/guide.md@120");
    expect(params.get("size")).toBe(String(2 * 1024 * 1024 + 1));
  });

  test("readFile maps an over-cap body to P4FileTooLargeError", async () => {
    fetchState.handler = () =>
      new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 });

    await expect(
      makeClient().readFile("//depot/docs/huge.md@120"),
    ).rejects.toBeInstanceOf(P4FileTooLargeError);
  });

  test("readFile maps 404 to a non-connection-level error", async () => {
    fetchState.handler = () =>
      new Response(errorBody("//depot/docs/gone.md - no such file(s)."), {
        status: 404,
      });

    const error = await makeClient()
      .readFile("//depot/docs/gone.md@120")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(P4ApiError);
    expect(isConnectionLevelError(error)).toBe(false);
  });

  test("maps fetch timeouts to a non-connection-level timeout error", async () => {
    fetchState.handler = () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    };

    const error = await makeClient()
      .readFile("//depot/docs/slow.md@120")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(P4ApiError);
    expect((error as Error).message).toContain("timed out");
    expect(isConnectionLevelError(error)).toBe(false);
  });

  test("maps network failures to a connection-level error", async () => {
    fetchState.handler = () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: new Error("connect ECONNREFUSED 10.0.0.5:8080"),
      });
    };

    const error = await makeClient()
      .info()
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(P4ApiError);
    expect((error as Error).message).toContain("Could not reach");
    expect((error as Error).message).toContain("ECONNREFUSED");
    expect(isConnectionLevelError(error)).toBe(true);
  });

  test("info parses the server record and fails on non-JSON", async () => {
    fetchState.handler = () =>
      new Response(JSON.stringify({ serverVersion: "P4D/LINUX/2026.1" }), {
        status: 200,
      });

    await expect(makeClient().info()).resolves.toMatchObject({
      serverVersion: "P4D/LINUX/2026.1",
    });

    fetchState.handler = () => new Response("nope", { status: 200 });
    await expect(makeClient().info()).rejects.toThrow(/non-JSON/);
  });
});
