import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types";
import { PerforceConnector } from "./perforce-connector";

const { execState } = vi.hoisted(() => ({
  execState: {
    handler: undefined as
      | undefined
      | ((args: string[]) =>
          | { stdout: string; stderr?: string }
          | {
              error: Partial<NodeJS.ErrnoException> & {
                stdout?: string;
                stderr?: string;
                killed?: boolean;
              };
            }),
    calls: [] as Array<{
      file: string;
      args: string[];
      env: NodeJS.ProcessEnv;
    }>,
  },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      file: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      execState.calls.push({ file, args, env: options.env });
      if (!execState.handler) {
        throw new Error("execState.handler not configured in test");
      }
      const result = execState.handler(args);
      if ("error" in result) {
        const error = Object.assign(
          new Error(result.error.message ?? "command failed"),
          result.error,
        );
        callback(error, result.error.stdout ?? "", result.error.stderr ?? "");
        return;
      }
      callback(null, result.stdout, result.stderr ?? "");
    },
  ),
}));

function taggedOutput(records: Array<Record<string, unknown>>): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function statFile(
  depotFile: string,
  overrides?: Partial<Record<"rev" | "change" | "type" | "action", string>>,
): Record<string, unknown> {
  return {
    code: "stat",
    depotFile,
    rev: overrides?.rev ?? "1",
    change: overrides?.change ?? "100",
    action: overrides?.action ?? "edit",
    type: overrides?.type ?? "text",
  };
}

/**
 * Configure a fake p4 server. Dispatches on the p4 subcommand; print content
 * defaults to a marker string embedding the filespec.
 */
function fakeP4(scenario: {
  latestChange?: number | null;
  changeTime?: string;
  files?: Array<Record<string, unknown>>;
  print?: (filespec: string) => string;
  printError?: (
    filespec: string,
  ) =>
    | { error: Partial<NodeJS.ErrnoException> & { stdout?: string } }
    | undefined;
}): void {
  execState.handler = (args) => {
    if (args.includes("info")) {
      return {
        stdout: taggedOutput([{ code: "stat", serverVersion: "P4D/LINUX" }]),
      };
    }
    if (args.includes("changes")) {
      if (scenario.latestChange == null) {
        return {
          stdout: taggedOutput([
            {
              code: "error",
              data: "... - no such file(s).\n",
              severity: 2,
              generic: 17,
            },
          ]),
        };
      }
      return {
        stdout: taggedOutput([
          {
            code: "stat",
            change: String(scenario.latestChange),
            time: scenario.changeTime ?? "1700000000",
            status: "submitted",
          },
        ]),
      };
    }
    if (args.includes("files")) {
      return { stdout: taggedOutput(scenario.files ?? []) };
    }
    if (args.includes("print")) {
      const filespec = args[args.length - 1];
      const error = scenario.printError?.(filespec);
      if (error) return error;
      return { stdout: scenario.print?.(filespec) ?? `content of ${filespec}` };
    }
    throw new Error(`Unexpected p4 invocation: ${args.join(" ")}`);
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

function p4CallsFor(command: string): Array<string[]> {
  return execState.calls
    .filter((call) => call.args.includes(command))
    .map((call) => call.args);
}

describe("PerforceConnector", () => {
  let connector: PerforceConnector;

  const validConfig = {
    type: "perforce",
    p4Port: "perforce.example.com:1666",
    depotPaths: ["//depot/docs"],
  };

  const credentials = { email: "svc-knowledge", apiToken: "ticket-123" };

  beforeEach(() => {
    connector = new PerforceConnector();
    execState.handler = undefined;
    execState.calls.length = 0;
    vi.clearAllMocks();
  });

  describe("validateConfig", () => {
    test("accepts a valid configuration", async () => {
      const result = await connector.validateConfig(validConfig);
      expect(result).toEqual({ valid: true });
    });

    test("rejects a missing p4Port", async () => {
      const result = await connector.validateConfig({
        type: "perforce",
        depotPaths: ["//depot/docs"],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("p4Port");
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
    test("succeeds when info and an authenticated files probe pass", async () => {
      fakeP4({ files: [statFile("//depot/docs/guide.md")] });

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(p4CallsFor("info")).toHaveLength(1);
      const filesCall = p4CallsFor("files")[0];
      expect(filesCall).toContain("-m");
      expect(filesCall).toContain("//depot/docs/...");
    });

    test("fails with the server message when authentication is rejected", async () => {
      execState.handler = (args) => {
        if (args.includes("info")) {
          return {
            stdout: taggedOutput([{ code: "stat", serverVersion: "P4D" }]),
          };
        }
        return {
          stdout: taggedOutput([
            {
              code: "error",
              data: "Perforce password (P4PASSWD) invalid or unset.",
              severity: 3,
              generic: 1,
            },
          ]),
        };
      };

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("P4PASSWD");
    });

    test("fails with installation guidance when the p4 binary is missing", async () => {
      execState.handler = () => ({
        error: { code: "ENOENT", message: "spawn p4 ENOENT" },
      });

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Perforce CLI binary not found");
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
          statFile("//depot/docs/guide.md", { rev: "3", change: "100" }),
          statFile("//depot/docs/config.yaml"),
          statFile("//depot/docs/blob.md", { type: "binary" }),
        ],
      });

      const batches = await collectBatches(
        connector.sync({ config: validConfig, credentials, checkpoint: null }),
      );

      // Extension filtering happens server-side via filespec suffixes; each
      // filespec is listed in its own p4 invocation to bound output size.
      const filesSpecs = p4CallsFor("files").flat();
      expect(filesSpecs).toContain("//depot/docs/....md@120");
      expect(filesSpecs).toContain("//depot/docs/....yaml@120");
      expect(filesSpecs).toContain("//depot/docs/....yml@120");
      expect(p4CallsFor("files")).toHaveLength(3);

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
          statFile("//depot/docs/guide.md"),
          statFile("//depot/docs/generated/api.md"),
          statFile("//depot/docs/generated-notes/keep.md"),
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

    test("passes the configured charset to every p4 invocation", async () => {
      fakeP4({
        latestChange: 120,
        files: [statFile("//depot/docs/guide.md")],
      });

      await collectBatches(
        connector.sync({
          config: { ...validConfig, charset: "utf8" },
          credentials,
          checkpoint: null,
        }),
      );

      expect(execState.calls.length).toBeGreaterThan(0);
      for (const call of execState.calls) {
        expect(call.env.P4CHARSET).toBe("utf8");
      }
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
      expect(p4CallsFor("files")).toHaveLength(0);
    });

    test("incremental sweep restricts the listing to the changelist window", async () => {
      fakeP4({
        latestChange: 120,
        files: [statFile("//depot/docs/changed.md", { change: "115" })],
      });

      const batches = await collectBatches(
        connector.sync({
          config: validConfig,
          credentials,
          checkpoint: { type: "perforce", lastChangelist: 100 },
        }),
      );

      expect(p4CallsFor("files").flat()).toContain(
        "//depot/docs/....md@101,@120",
      );

      expect(batches).toHaveLength(1);
      expect(batches[0].documents.map((doc) => doc.id)).toEqual([
        "//depot/docs/changed.md",
      ]);
      expect(batches[0].checkpoint).toMatchObject({ lastChangelist: 120 });
    });

    test("splits large sweeps into batches with a resumable in-flight cursor", async () => {
      const manyFiles = Array.from({ length: 60 }, (_, i) =>
        statFile(`//depot/docs/file-${String(i).padStart(3, "0")}.md`),
      );
      fakeP4({ latestChange: 120, files: manyFiles });

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
        targetChangelist: 120,
        targetChangeTime: "2023-11-14T22:13:20.000Z",
        filesOffset: 50,
      });
      expect(batches[1].documents).toHaveLength(10);
      expect(batches[1].hasMore).toBe(false);
      expect(batches[1].checkpoint).toEqual({
        type: "perforce",
        lastSyncedAt: "2023-11-14T22:13:20.000Z",
        lastChangelist: 120,
      });
    });

    test("resumes an interrupted sweep from the persisted offset without re-resolving the target", async () => {
      const manyFiles = Array.from({ length: 60 }, (_, i) =>
        statFile(`//depot/docs/file-${String(i).padStart(3, "0")}.md`),
      );
      fakeP4({ latestChange: 999, files: manyFiles });

      const batches = await collectBatches(
        connector.sync({
          config: validConfig,
          credentials,
          checkpoint: {
            type: "perforce",
            targetChangelist: 120,
            targetChangeTime: "2023-11-14T22:13:20.000Z",
            filesOffset: 50,
          },
        }),
      );

      // The pinned target comes from the checkpoint, not a new `p4 changes`.
      expect(p4CallsFor("changes")).toHaveLength(0);
      expect(p4CallsFor("files").flat()).toContain("//depot/docs/....md@120");

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(10);
      expect(batches[0].documents[0].id).toBe("//depot/docs/file-050.md");
      // The carried targetChangeTime becomes the committed lastSyncedAt.
      expect(batches[0].checkpoint).toEqual({
        type: "perforce",
        lastSyncedAt: "2023-11-14T22:13:20.000Z",
        lastChangelist: 120,
      });
      expect(batches[0].hasMore).toBe(false);
    });

    test("ignores an orphaned filesOffset that has no in-flight sweep", async () => {
      fakeP4({
        latestChange: 120,
        files: [statFile("//depot/docs/a.md"), statFile("//depot/docs/b.md")],
      });

      const batches = await collectBatches(
        connector.sync({
          config: validConfig,
          credentials,
          // Malformed: filesOffset without targetChangelist must not skip
          // files of the freshly resolved sweep.
          checkpoint: { type: "perforce", filesOffset: 1 },
        }),
      );

      expect(batches).toHaveLength(1);
      expect(batches[0].documents.map((doc) => doc.id)).toEqual([
        "//depot/docs/a.md",
        "//depot/docs/b.md",
      ]);
    });

    test("records per-file print failures and keeps syncing", async () => {
      fakeP4({
        latestChange: 120,
        files: [
          statFile("//depot/docs/good.md"),
          statFile("//depot/docs/locked.md"),
        ],
        printError: (filespec) =>
          filespec.startsWith("//depot/docs/locked.md")
            ? {
                error: {
                  code: 1 as unknown as string,
                  message: "p4 failed",
                  stdout: taggedOutput([
                    {
                      code: "error",
                      data: "//depot/docs/locked.md - no permission for operation on file(s).",
                      severity: 3,
                    },
                  ]),
                },
              }
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
        resource: "file_content",
      });
      // The sweep still commits: the failure is recorded on the run instead.
      expect(batches[0].checkpoint).toMatchObject({ lastChangelist: 120 });
    });

    test("skips oversized files with a reason instead of failing", async () => {
      fakeP4({
        latestChange: 120,
        files: [statFile("//depot/docs/huge.md")],
        printError: () => ({
          error: {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            message: "stdout maxBuffer length exceeded",
          },
        }),
      });

      const batches = await collectBatches(
        connector.sync({ config: validConfig, credentials, checkpoint: null }),
      );

      expect(batches[0].documents).toEqual([]);
      expect(batches[0].skipped?.[0]).toMatchObject({
        itemId: "//depot/docs/huge.md",
      });
      expect(batches[0].skipped?.[0].reason).toContain("indexing limit");
    });

    test("aborts the run when the connection breaks mid-sweep", async () => {
      fakeP4({
        latestChange: 120,
        files: [statFile("//depot/docs/guide.md")],
        printError: () => ({
          error: {
            message: "failed",
            stdout: "",
            stderr: "Connect to server failed; check $P4PORT.",
          },
        }),
      });

      await expect(
        collectBatches(
          connector.sync({
            config: validConfig,
            credentials,
            checkpoint: null,
          }),
        ),
      ).rejects.toThrow(/Connect to server failed/);
    });

    test("honors custom fileTypes and queries multiple depot paths", async () => {
      fakeP4({ latestChange: 120, files: [] });

      await collectBatches(
        connector.sync({
          config: {
            ...validConfig,
            depotPaths: ["//depot/docs", "//stream/main/specs"],
            fileTypes: ["MD", ".txt"],
          },
          credentials,
          checkpoint: null,
        }),
      );

      expect(p4CallsFor("changes")).toHaveLength(2);
      const filesSpecs = p4CallsFor("files").flat();
      expect(filesSpecs).toContain("//depot/docs/....md@120");
      expect(filesSpecs).toContain("//depot/docs/....txt@120");
      expect(filesSpecs).toContain("//stream/main/specs/....md@120");
      expect(filesSpecs).toContain("//stream/main/specs/....txt@120");
      expect(filesSpecs).not.toContain("//depot/docs/....yaml@120");
    });

    test("commits the cursor and reports skips when every candidate is non-text", async () => {
      fakeP4({
        latestChange: 120,
        files: [
          statFile("//depot/docs/model.md", { type: "binary" }),
          statFile("//depot/docs/asset.yaml", { type: "ubinary" }),
        ],
      });

      const batches = await collectBatches(
        connector.sync({ config: validConfig, credentials, checkpoint: null }),
      );

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toEqual([]);
      expect(batches[0].skipped).toHaveLength(2);
      expect(batches[0].hasMore).toBe(false);
      // The sweep still commits so the next run doesn't rescan these files.
      expect(batches[0].checkpoint).toMatchObject({ lastChangelist: 120 });
    });

    test("records a per-file print timeout as a failure instead of aborting", async () => {
      fakeP4({
        latestChange: 120,
        files: [
          statFile("//depot/docs/good.md"),
          statFile("//depot/docs/slow.md"),
        ],
        printError: (filespec) =>
          filespec.startsWith("//depot/docs/slow.md")
            ? { error: { killed: true, message: "killed" } }
            : undefined,
      });

      const batches = await collectBatches(
        connector.sync({ config: validConfig, credentials, checkpoint: null }),
      );

      expect(batches).toHaveLength(1);
      expect(batches[0].documents.map((doc) => doc.id)).toEqual([
        "//depot/docs/good.md",
      ]);
      expect(batches[0].failures?.[0]).toMatchObject({
        itemId: "//depot/docs/slow.md",
      });
      expect(batches[0].failures?.[0].error).toContain("timed out");
    });

    test("throws when no username is configured", async () => {
      await expect(
        collectBatches(
          connector.sync({
            config: validConfig,
            credentials: { apiToken: "ticket-123" },
            checkpoint: null,
          }),
        ),
      ).rejects.toThrow(/username/);
    });
  });
});
