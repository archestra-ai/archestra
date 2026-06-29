import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types";
import { PerforceConnector } from "./perforce-connector";

/**
 * fetch is the process boundary for the REST-API-backed connector — these
 * tests mock it and nothing else.
 */
const fetchState: {
  handler: undefined | ((url: URL) => Response | Promise<Response>);
  calls: Array<{ url: URL }>;
} = { handler: undefined, calls: [] };

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL) => {
    const url = input instanceof URL ? input : new URL(String(input));
    fetchState.calls.push({ url });
    if (!fetchState.handler) {
      throw new Error("fetchState.handler not configured in test");
    }
    return fetchState.handler(url);
  }),
);

function jsonl(records: Array<Record<string, unknown>>): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function errorBody(message: string, statusCode = 404): string {
  return JSON.stringify({ errors: [{ message, statusCode }] });
}

function revisionRecord(
  depotFile: string,
  overrides?: Partial<
    Record<"headRev" | "headChange" | "headAction" | "headType", string>
  >,
): Record<string, unknown> {
  return {
    depotFile,
    headRev: overrides?.headRev ?? "1",
    headChange: overrides?.headChange ?? "100",
    headAction: overrides?.headAction ?? "edit",
    headType: overrides?.headType ?? "text",
  };
}

/**
 * Configure a fake P4 REST API. Dispatches on the endpoint path; the
 * `latestChange` scenario answers the newest-revision probe and `files`
 * answers candidate listings. File content defaults to a marker string
 * embedding the requested filespec.
 */
function fakeP4(scenario: {
  latestChange?: number | null;
  changeTime?: string;
  files?: Array<Record<string, unknown>>;
  content?: (filespec: string) => string;
  contentResponse?: (filespec: string) => Response | undefined;
}): void {
  fetchState.handler = (url) => {
    if (url.pathname === "/api/v0/server/info") {
      return new Response(
        JSON.stringify({ serverVersion: "P4D/LINUX/2026.1" }),
        { status: 200 },
      );
    }
    if (url.pathname === "/api/v0/file/revisions") {
      // The newest-revision probe (the REST API has no `p4 changes`).
      if (url.searchParams.get("sort") === "date") {
        if (scenario.latestChange == null) {
          return new Response(errorBody("... - no such file(s)."), {
            status: 404,
          });
        }
        return new Response(
          jsonl([
            {
              ...revisionRecord("//probe/newest.md", {
                headChange: String(scenario.latestChange),
              }),
              headTime: scenario.changeTime ?? "2023-11-14T22:13:20.000Z",
            },
          ]),
          { status: 200 },
        );
      }
      if (!scenario.files || scenario.files.length === 0) {
        return new Response(errorBody("... - no such file(s)."), {
          status: 404,
        });
      }
      return new Response(jsonl(scenario.files), { status: 200 });
    }
    if (url.pathname === "/api/v0/file/contents") {
      const filespec = url.searchParams.get("fileSpec") ?? "";
      const custom = scenario.contentResponse?.(filespec);
      if (custom) return custom;
      return new Response(
        scenario.content?.(filespec) ?? `content of ${filespec}`,
        { status: 200 },
      );
    }
    throw new Error(`Unexpected P4 REST API request: ${url.pathname}`);
  };
}

async function collectBatches(
  generator: AsyncGenerator<ConnectorSyncBatch>,
): Promise<ConnectorSyncBatch[]> {
  const batches: ConnectorSyncBatch[] = [];
  for await (const batch of generator) {
    batches.push(batch);
  }
  return batches;
}

function requestsTo(pathname: string): URL[] {
  return fetchState.calls
    .filter((call) => call.url.pathname === pathname)
    .map((call) => call.url);
}

function listingFilespecs(): string[] {
  return requestsTo("/api/v0/file/revisions")
    .filter((url) => url.searchParams.get("sort") !== "date")
    .flatMap((url) => url.searchParams.getAll("fileSpec"));
}

describe("PerforceConnector", () => {
  let connector: PerforceConnector;

  const validConfig = {
    type: "perforce",
    serverUrl: "https://perforce.example.com:8080",
    depotPaths: ["//depot/docs"],
  };

  const credentials = { email: "svc-knowledge", apiToken: "ticket-123" };

  beforeEach(() => {
    connector = new PerforceConnector();
    fetchState.handler = undefined;
    fetchState.calls.length = 0;
    vi.clearAllMocks();
  });

  describe("validateConfig", () => {
    test("accepts a valid configuration", async () => {
      const result = await connector.validateConfig(validConfig);
      expect(result).toEqual({ valid: true });
    });

    test("rejects a missing serverUrl", async () => {
      const result = await connector.validateConfig({
        type: "perforce",
        depotPaths: ["//depot/docs"],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("serverUrl");
    });

    test("rejects depot paths with revision metacharacters", async () => {
      const result = await connector.validateConfig({
        ...validConfig,
        depotPaths: ["//depot/docs@123"],
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("testConnection", () => {
    test("succeeds when the server probe and an authenticated listing pass", async () => {
      fakeP4({ files: [revisionRecord("//depot/docs/guide.md")] });

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(requestsTo("/api/v0/server/info")).toHaveLength(1);
      const listing = requestsTo("/api/v0/file/revisions")[0];
      expect(listing.searchParams.get("max")).toBe("1");
      expect(listing.searchParams.get("fileSpec")).toBe("//depot/docs/...");
    });

    test("fails with the server message when authentication is rejected", async () => {
      fetchState.handler = (url) => {
        if (url.pathname === "/api/v0/server/info") {
          return new Response(
            errorBody("Perforce password (P4PASSWD) invalid or unset.", 401),
            { status: 401 },
          );
        }
        throw new Error("unexpected request");
      };

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("authentication failed");
    });

    test("fails with a reachability error when the REST API is unreachable", async () => {
      fetchState.handler = () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: new Error("connect ECONNREFUSED 10.0.0.5:8080"),
        });
      };

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not reach the P4 REST API");
    });

    test("fails when no username is provided", async () => {
      const result = await connector.testConnection({
        config: validConfig,
        credentials: { email: "", apiToken: "ticket-123" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("username");
    });
  });

  describe("sync", () => {
    test("full sweep lists files pinned to the latest change and commits the cursor", async () => {
      fakeP4({
        latestChange: 120,
        files: [
          revisionRecord("//depot/docs/guide.md", {
            headRev: "3",
            headChange: "100",
          }),
          revisionRecord("//depot/docs/config.yaml"),
          revisionRecord("//depot/docs/blob.md", { headType: "binary" }),
        ],
      });

      const batches = await collectBatches(
        connector.sync({ config: validConfig, credentials, checkpoint: null }),
      );

      // Extension filtering happens server-side via filespec suffixes; each
      // filespec is listed in its own request to bound response size.
      const specs = listingFilespecs();
      expect(specs).toContain("//depot/docs/....md@120");
      expect(specs).toContain("//depot/docs/....yaml@120");
      expect(specs).toContain("//depot/docs/....yml@120");
      expect(specs).toHaveLength(3);

      expect(batches).toHaveLength(1);
      const batch = batches[0];
      expect(batch.hasMore).toBe(false);
      expect(batch.documents.map((doc) => doc.id)).toEqual([
        "//depot/docs/config.yaml",
        "//depot/docs/guide.md",
      ]);
      expect(batch.documents[1]).toMatchObject({
        title: "guide.md (//depot/docs)",
        content: "content of //depot/docs/guide.md@120",
        metadata: {
          depotPath: "//depot/docs/guide.md",
          rev: 3,
          changelist: 120,
          perforceFileType: "text",
          kind: "depot_file",
        },
      });
      expect(batch.skipped).toEqual([
        {
          itemId: "//depot/docs/blob.md",
          name: "//depot/docs/blob.md",
          reason: 'unsupported Perforce filetype "binary"',
        },
      ]);
      expect(batch.checkpoint).toEqual({
        type: "perforce",
        lastSyncedAt: "2023-11-14T22:13:20.000Z",
        lastChangelist: 120,
      });
    });

    test("excludePaths carve subtrees out of the sweep on segment boundaries", async () => {
      fakeP4({
        latestChange: 120,
        files: [
          revisionRecord("//depot/docs/guide.md"),
          revisionRecord("//depot/docs/generated/api.md"),
          revisionRecord("//depot/docs/generated-notes/keep.md"),
        ],
      });

      const batches = await collectBatches(
        connector.sync({
          config: {
            ...validConfig,
            excludePaths: ["//depot/docs/generated"],
          },
          credentials,
          checkpoint: null,
        }),
      );

      expect(batches[0].documents.map((doc) => doc.id)).toEqual([
        "//depot/docs/generated-notes/keep.md",
        "//depot/docs/guide.md",
      ]);
      // Excluded by configuration, not a skip worth surfacing on the run.
      expect(batches[0].skipped).toEqual([]);
    });

    test("yields one empty final batch when there are no new changes", async () => {
      fakeP4({ latestChange: 120 });

      const batches = await collectBatches(
        connector.sync({
          config: validConfig,
          credentials,
          checkpoint: { type: "perforce", lastChangelist: 120 },
        }),
      );

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toEqual([]);
      expect(batches[0].hasMore).toBe(false);
      expect(batches[0].checkpoint).toMatchObject({ lastChangelist: 120 });
      expect(listingFilespecs()).toHaveLength(0);
    });

    test("incremental sweep restricts the listing to the changelist window", async () => {
      fakeP4({
        latestChange: 120,
        files: [
          revisionRecord("//depot/docs/changed.md", { headChange: "115" }),
        ],
      });

      const batches = await collectBatches(
        connector.sync({
          config: validConfig,
          credentials,
          checkpoint: { type: "perforce", lastChangelist: 100 },
        }),
      );

      expect(listingFilespecs()).toContain("//depot/docs/....md@101,@120");

      expect(batches).toHaveLength(1);
      expect(batches[0].documents.map((doc) => doc.id)).toEqual([
        "//depot/docs/changed.md",
      ]);
      expect(batches[0].checkpoint).toMatchObject({ lastChangelist: 120 });
    });

    test("splits large sweeps into batches with a resumable in-flight cursor", async () => {
      const manyFiles = Array.from({ length: 60 }, (_, i) =>
        revisionRecord(`//depot/docs/file-${String(i).padStart(3, "0")}.md`),
      );
      fakeP4({ latestChange: 200, files: manyFiles });

      const batches = await collectBatches(
        connector.sync({ config: validConfig, credentials, checkpoint: null }),
      );

      expect(batches).toHaveLength(2);
      expect(batches[0].documents).toHaveLength(50);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[0].checkpoint).toEqual({
        type: "perforce",
        lastSyncedAt: undefined,
        lastChangelist: undefined,
        targetChangelist: 200,
        targetChangeTime: "2023-11-14T22:13:20.000Z",
        filesOffset: 50,
      });

      expect(batches[1].documents).toHaveLength(10);
      expect(batches[1].hasMore).toBe(false);
      expect(batches[1].checkpoint).toEqual({
        type: "perforce",
        lastSyncedAt: "2023-11-14T22:13:20.000Z",
        lastChangelist: 200,
      });
    });

    test("resumes an interrupted sweep from the persisted offset without re-resolving the target", async () => {
      const manyFiles = Array.from({ length: 60 }, (_, i) =>
        revisionRecord(`//depot/docs/file-${String(i).padStart(3, "0")}.md`),
      );
      fakeP4({ latestChange: 999, files: manyFiles });

      const batches = await collectBatches(
        connector.sync({
          config: validConfig,
          credentials,
          checkpoint: {
            type: "perforce",
            targetChangelist: 200,
            targetChangeTime: "2024-01-01T00:00:00.000Z",
            filesOffset: 50,
          },
        }),
      );

      // No newest-revision probe: the in-flight target pins the sweep.
      const probes = requestsTo("/api/v0/file/revisions").filter(
        (url) => url.searchParams.get("sort") === "date",
      );
      expect(probes).toHaveLength(0);
      expect(listingFilespecs()).toContain("//depot/docs/....md@200");

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(10);
      expect(batches[0].documents[0].id).toBe("//depot/docs/file-050.md");
      expect(batches[0].checkpoint).toEqual({
        type: "perforce",
        lastSyncedAt: "2024-01-01T00:00:00.000Z",
        lastChangelist: 200,
      });
    });

    test("ignores an orphaned filesOffset that has no in-flight sweep", async () => {
      fakeP4({
        latestChange: 120,
        files: [revisionRecord("//depot/docs/guide.md")],
      });

      const batches = await collectBatches(
        connector.sync({
          config: validConfig,
          credentials,
          // filesOffset without targetChangelist: must not skip anything.
          checkpoint: { type: "perforce", filesOffset: 40 },
        }),
      );

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(1);
    });

    test("records per-file download failures and keeps syncing", async () => {
      fakeP4({
        latestChange: 120,
        files: [
          revisionRecord("//depot/docs/good.md"),
          revisionRecord("//depot/docs/locked.md"),
        ],
        contentResponse: (filespec) =>
          filespec.startsWith("//depot/docs/locked.md")
            ? new Response(
                errorBody("//depot/docs/locked.md - access denied", 500),
                { status: 500 },
              )
            : undefined,
      });

      const batches = await collectBatches(
        connector.sync({ config: validConfig, credentials, checkpoint: null }),
      );

      expect(batches).toHaveLength(1);
      expect(batches[0].documents.map((doc) => doc.id)).toEqual([
        "//depot/docs/good.md",
      ]);
      expect(batches[0].failures).toHaveLength(1);
      expect(batches[0].failures?.[0]).toMatchObject({
        itemId: "//depot/docs/locked.md",
      });
      // The sweep still commits: the failure is recorded on the run.
      expect(batches[0].checkpoint).toMatchObject({ lastChangelist: 120 });
    });

    test("skips oversized files with a reason instead of failing", async () => {
      fakeP4({
        latestChange: 120,
        files: [revisionRecord("//depot/docs/huge.md")],
        content: () => "x".repeat(2 * 1024 * 1024 + 1),
      });

      const batches = await collectBatches(
        connector.sync({ config: validConfig, credentials, checkpoint: null }),
      );

      expect(batches[0].documents).toEqual([]);
      expect(batches[0].skipped).toHaveLength(1);
      expect(batches[0].skipped?.[0].reason).toContain("indexing limit");
    });

    test("aborts the run when authentication breaks mid-sweep", async () => {
      fakeP4({
        latestChange: 120,
        files: [revisionRecord("//depot/docs/guide.md")],
        contentResponse: () =>
          new Response(errorBody("ticket expired", 401), { status: 401 }),
      });

      await expect(
        collectBatches(
          connector.sync({
            config: validConfig,
            credentials,
            checkpoint: null,
          }),
        ),
      ).rejects.toThrow(/authentication failed/);
    });

    test("honors custom fileTypes and queries multiple depot paths", async () => {
      fakeP4({
        latestChange: 120,
        files: [revisionRecord("//depot/docs/notes.txt")],
      });

      await collectBatches(
        connector.sync({
          config: {
            ...validConfig,
            depotPaths: ["//depot/docs", "//stream/main/specs"],
            fileTypes: ["txt", ".RST"],
          },
          credentials,
          checkpoint: null,
        }),
      );

      const specs = listingFilespecs();
      expect(specs).toEqual([
        "//depot/docs/....txt@120",
        "//depot/docs/....rst@120",
        "//stream/main/specs/....txt@120",
        "//stream/main/specs/....rst@120",
      ]);
    });

    test("commits the cursor and reports skips when every candidate is non-text", async () => {
      fakeP4({
        latestChange: 120,
        files: [
          revisionRecord("//depot/docs/image.md", { headType: "binary" }),
        ],
      });

      const batches = await collectBatches(
        connector.sync({ config: validConfig, credentials, checkpoint: null }),
      );

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toEqual([]);
      expect(batches[0].skipped).toHaveLength(1);
      expect(batches[0].checkpoint).toMatchObject({ lastChangelist: 120 });
    });

    test("records a per-file download timeout as a failure instead of aborting", async () => {
      fakeP4({
        latestChange: 120,
        files: [
          revisionRecord("//depot/docs/good.md"),
          revisionRecord("//depot/docs/slow.md"),
        ],
      });
      const baseHandler = fetchState.handler;
      fetchState.handler = (url) => {
        if (
          url.pathname === "/api/v0/file/contents" &&
          url.searchParams.get("fileSpec")?.startsWith("//depot/docs/slow.md")
        ) {
          const error = new Error("The operation was aborted due to timeout");
          error.name = "TimeoutError";
          throw error;
        }
        if (!baseHandler) throw new Error("missing base handler");
        return baseHandler(url);
      };

      const batches = await collectBatches(
        connector.sync({ config: validConfig, credentials, checkpoint: null }),
      );

      expect(batches[0].documents.map((doc) => doc.id)).toEqual([
        "//depot/docs/good.md",
      ]);
      expect(batches[0].failures).toHaveLength(1);
      expect(batches[0].failures?.[0]).toMatchObject({
        itemId: "//depot/docs/slow.md",
      });
      expect(batches[0].checkpoint).toMatchObject({ lastChangelist: 120 });
    });

    test("throws when no username is configured", async () => {
      fakeP4({ latestChange: 120 });

      await expect(
        collectBatches(
          connector.sync({
            config: validConfig,
            credentials: { email: "  ", apiToken: "ticket-123" },
            checkpoint: null,
          }),
        ),
      ).rejects.toThrow(/username/);
    });
  });
});
