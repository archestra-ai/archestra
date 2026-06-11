import type pino from "pino";
import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import {
  isConnectionLevelError,
  P4CliClient,
  P4CommandError,
  P4FileTooLargeError,
} from "./p4-cli-client";

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
      options: { env: NodeJS.ProcessEnv; maxBuffer: number; timeout: number };
    }>,
  },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      file: string,
      args: string[],
      options: {
        env: NodeJS.ProcessEnv;
        maxBuffer: number;
        timeout: number;
      },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      execState.calls.push({ file, args, options });
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

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as pino.Logger;

function makeClient(overrides?: {
  password?: string;
  charset?: string;
}): P4CliClient {
  return new P4CliClient({
    p4Port: "perforce.example.com:1666",
    username: "svc-knowledge",
    password: overrides?.password ?? "super-secret-ticket",
    charset: overrides?.charset,
    log,
  });
}

describe("P4CliClient", () => {
  beforeEach(() => {
    execState.handler = undefined;
    execState.calls.length = 0;
    vi.clearAllMocks();
  });

  test("passes connection params as argv and the secret only via P4PASSWD env", async () => {
    execState.handler = () => ({
      stdout: taggedOutput([{ code: "stat", serverVersion: "P4D/LINUX" }]),
    });

    await makeClient().info();

    const call = execState.calls[0];
    expect(call.args).toEqual([
      "-p",
      "perforce.example.com:1666",
      "-u",
      "svc-knowledge",
      "-ztag",
      "-Mj",
      "info",
    ]);
    expect(call.args).not.toContain("super-secret-ticket");
    expect(call.options.env.P4PASSWD).toBe("super-secret-ticket");
  });

  test("child env is allowlisted and does not inherit arbitrary variables", async () => {
    vi.stubEnv("SOME_UNRELATED_SECRET", "leak-me");
    execState.handler = () => ({
      stdout: taggedOutput([{ code: "stat", serverVersion: "P4D/LINUX" }]),
    });

    await makeClient().info();

    const env = execState.calls[0].options.env;
    expect(env.SOME_UNRELATED_SECRET).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    vi.unstubAllEnvs();
  });

  test("connector charset overrides the process-level P4CHARSET", async () => {
    vi.stubEnv("P4CHARSET", "auto");
    execState.handler = () => ({
      stdout: taggedOutput([{ code: "stat", serverVersion: "P4D/LINUX" }]),
    });

    await makeClient({ charset: "utf8" }).info();

    expect(execState.calls[0].options.env.P4CHARSET).toBe("utf8");
    vi.unstubAllEnvs();
  });

  test("rejects connection params containing control characters", () => {
    expect(
      () =>
        new P4CliClient({
          p4Port: "host:1666\nrm -rf /",
          username: "user",
          password: "x",
          log,
        }),
    ).toThrow(/control characters/);
  });

  test("latestChange parses the changelist number and submit time", async () => {
    execState.handler = () => ({
      stdout: taggedOutput([
        {
          code: "stat",
          change: "120",
          time: "1700000000",
          user: "alice",
          status: "submitted",
        },
      ]),
    });

    const result = await makeClient().latestChange("//depot/docs/...");
    expect(result).toEqual({
      change: 120,
      time: "2023-11-14T22:13:20.000Z",
    });
  });

  test("latestChange returns null when the path has no submitted changes", async () => {
    execState.handler = () => ({
      stdout: taggedOutput([
        {
          code: "error",
          data: "//depot/empty/... - no such file(s).\n",
          severity: 2,
          generic: 17,
        },
      ]),
    });

    const result = await makeClient().latestChange("//depot/empty/...");
    expect(result).toBeNull();
  });

  test("files maps stat records and passes -e plus the optional -m cap", async () => {
    execState.handler = () => ({
      stdout: taggedOutput([
        {
          code: "stat",
          depotFile: "//depot/docs/guide.md",
          rev: "3",
          change: "100",
          action: "edit",
          type: "text",
        },
      ]),
    });

    const result = await makeClient().files(["//depot/docs/....md@120"], {
      max: 1,
    });

    expect(execState.calls[0].args.slice(6)).toEqual([
      "files",
      "-e",
      "-m",
      "1",
      "//depot/docs/....md@120",
    ]);
    expect(result).toEqual([
      {
        depotFile: "//depot/docs/guide.md",
        rev: 3,
        change: 100,
        action: "edit",
        type: "text",
      },
    ]);
  });

  test("files throws on severity-3 error records and redacts the secret", async () => {
    execState.handler = () => ({
      stdout: taggedOutput([
        {
          code: "error",
          data: "Perforce password (P4PASSWD) invalid or unset. token=super-secret-ticket",
          severity: 3,
          generic: 1,
        },
      ]),
    });

    const error = await makeClient()
      .files(["//depot/docs/....md"])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(P4CommandError);
    expect((error as Error).message).toContain("P4PASSWD");
    expect((error as Error).message).not.toContain("super-secret-ticket");
    expect((error as Error).message).toContain("***");
    expect(isConnectionLevelError(error)).toBe(true);
  });

  test("treats a non-zero exit whose stdout is only benign warnings as an empty result", async () => {
    execState.handler = () => ({
      error: {
        code: 1 as unknown as string,
        message: "p4 exited with code 1",
        stdout: taggedOutput([
          {
            code: "error",
            data: "//depot/empty/....md - no such file(s).\n",
            severity: 2,
            generic: 17,
          },
        ]),
      },
    });

    await expect(makeClient().files(["//depot/empty/....md"])).resolves.toEqual(
      [],
    );
    await expect(
      makeClient().latestChange("//depot/empty/..."),
    ).resolves.toBeNull();
  });

  test("never recovers a maxBuffer overflow as a result, even with parseable stdout", async () => {
    // A truncated listing can end on a complete JSON line; treating it as a
    // full result would silently advance the sync cursor past unseen files.
    execState.handler = () => ({
      error: {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        message: "stdout maxBuffer length exceeded",
        stdout: taggedOutput([
          {
            code: "stat",
            depotFile: "//depot/docs/a.md",
            rev: "1",
            change: "100",
            action: "edit",
            type: "text",
          },
        ]),
      },
    });

    await expect(makeClient().files(["//depot/docs/....md"])).rejects.toThrow(
      /p4 command failed/,
    );
  });

  test("still fails on a non-zero exit carrying a severity-3 record", async () => {
    execState.handler = () => ({
      error: {
        code: 1 as unknown as string,
        message: "p4 exited with code 1",
        stdout: taggedOutput([
          {
            code: "error",
            data: "Perforce password (P4PASSWD) invalid or unset.",
            severity: 3,
            generic: 1,
          },
        ]),
      },
    });

    await expect(makeClient().files(["//depot/docs/....md"])).rejects.toThrow(
      /P4PASSWD/,
    );
  });

  test("throws a clear error when the p4 binary is missing", async () => {
    execState.handler = () => ({
      error: { code: "ENOENT", message: "spawn p4 ENOENT" },
    });

    await expect(makeClient().info()).rejects.toThrow(
      /Perforce CLI binary not found.*ARCHESTRA_KNOWLEDGE_BASE_P4_BINARY_PATH/,
    );
  });

  test("throws on non-JSON tagged output instead of guessing", async () => {
    execState.handler = () => ({ stdout: "Perforce server info:\n" });

    await expect(makeClient().info()).rejects.toThrow(/non-JSON output/);
  });

  test("print returns raw stdout without tagged flags", async () => {
    execState.handler = () => ({ stdout: "# Guide\n\nHello.\n" });

    const content = await makeClient().print("//depot/docs/guide.md@120");

    expect(content).toBe("# Guide\n\nHello.\n");
    expect(execState.calls[0].args.slice(4)).toEqual([
      "print",
      "-q",
      "//depot/docs/guide.md@120",
    ]);
    expect(execState.calls[0].args).not.toContain("-Mj");
  });

  test("print maps the maxBuffer overflow to P4FileTooLargeError", async () => {
    execState.handler = () => ({
      error: {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        message: "stdout maxBuffer length exceeded",
      },
    });

    await expect(
      makeClient().print("//depot/docs/huge.md@120"),
    ).rejects.toThrow(P4FileTooLargeError);
  });

  test("maps killed processes to a timeout error", async () => {
    execState.handler = () => ({
      error: { killed: true, message: "killed" },
    });

    await expect(makeClient().info()).rejects.toThrow(/timed out/);
  });
});
