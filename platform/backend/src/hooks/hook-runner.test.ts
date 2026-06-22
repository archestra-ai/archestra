import { vi } from "vitest";

vi.mock("@/skills-sandbox/skill-sandbox-runtime-service", () => ({
  skillSandboxRuntimeService: { runCommand: vi.fn(), uploadFile: vi.fn() },
}));

import { beforeEach, describe, expect, test } from "vitest";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import type { HookFile } from "@/types/hook";
import { asSandboxId } from "@/types/skill-sandbox";
import { runHookScript } from "./hook-runner";

const mockRun = vi.mocked(skillSandboxRuntimeService.runCommand);
const mockUpload = vi.mocked(skillSandboxRuntimeService.uploadFile);

// shape matches CommandResult
const ok = (o = {}) => ({
  commandId: "cmd-1",
  sandboxId: asSandboxId("s"),
  command: "",
  cwd: null,
  stdout: "",
  stderr: "",
  exitCode: 0,
  durationMs: 5,
  timedOut: false,
  truncated: false,
  stagingNotices: [],
  ...o,
});

// shape matches UploadRef
const uploadOk = (o = {}) => ({
  uploadId: "up-1",
  sandboxId: asSandboxId("s"),
  path: "/some/path",
  mimeType: "text/plain",
  sizeBytes: 10,
  ...o,
});

const hook = (o: Partial<HookFile> = {}): HookFile => ({
  id: "h",
  organizationId: "o",
  agentId: "a",
  event: "pre_tool_use",
  fileName: "guard.py",
  content: "import sys;sys.exit(0)",
  requirements: [],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...o,
});

describe("runHookScript", () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockUpload.mockReset();
    mockUpload.mockResolvedValue(uploadOk());
  });

  test("python with deps → uv run --with, uploadFile for script + payload, payload on stdin", async () => {
    mockRun.mockResolvedValue(ok());
    await runHookScript({
      sandboxId: "s",
      caller: { userId: "u", organizationId: "o" },
      hookFile: hook({ requirements: ["requests"] }),
      payload: { hook_event_name: "PreToolUse" },
    });

    // uploadFile called twice — script then payload
    expect(mockUpload).toHaveBeenCalledTimes(2);

    const [scriptUpload, payloadUpload] = mockUpload.mock.calls;
    // first upload: script file
    expect(scriptUpload[0].path).toMatch(
      /\/home\/sandbox\/hooks\/h\/guard\.py$/,
    );
    expect(scriptUpload[0].data).toEqual(
      Buffer.from("import sys;sys.exit(0)", "utf8"),
    );
    // script upload carries a content-addressed dedupeId (uuid format)
    expect(scriptUpload[0].dedupeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // second upload: payload file (unique per-fire uuid)
    expect(payloadUpload[0].path).toMatch(/\/payload-.+\.json$/);
    expect(payloadUpload[0].data).toEqual(
      Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse" }), "utf8"),
    );
    // payload upload has NO dedupeId — it changes every fire
    expect(payloadUpload[0].dedupeId).toBeUndefined();

    // runCommand called once with a small exec command (no base64)
    expect(mockRun).toHaveBeenCalledOnce();
    const cmd = mockRun.mock.calls[0][0].command;
    expect(cmd).toContain("uv run --with 'requests' python3");
    expect(cmd).toContain("'/home/sandbox/hooks/h/guard.py'");
    expect(cmd).toMatch(/< '\/home\/sandbox\/hooks\/h\/payload-.+\.json'/);
    // no base64 or mkdir in the exec command
    expect(cmd).not.toContain("base64");
    expect(cmd).not.toContain("mkdir");
  });

  test("shell-escapes a requirement containing a single quote", async () => {
    mockRun.mockResolvedValue(ok());
    await runHookScript({
      sandboxId: "s",
      caller: { userId: "u", organizationId: "o" },
      hookFile: hook({ requirements: ["a'b"] }),
      payload: {},
    });
    // single quote closed, escaped, reopened — passed to uv as one literal arg.
    expect(mockRun.mock.calls[0][0].command).toContain("--with 'a'\\''b'");
  });

  test("bash → sh, no uv; uploadFile called twice", async () => {
    mockRun.mockResolvedValue(ok());
    await runHookScript({
      sandboxId: "s",
      caller: { userId: "u", organizationId: "o" },
      hookFile: hook({ fileName: "audit.sh", content: "exit 0" }),
      payload: {},
    });

    expect(mockUpload).toHaveBeenCalledTimes(2);

    const cmd = mockRun.mock.calls[0][0].command;
    expect(cmd).toContain("sh '/home/sandbox/hooks/h/audit.sh'");
    expect(cmd).toMatch(/< '\/home\/sandbox\/hooks\/h\/payload-.+\.json'/);
    expect(cmd).not.toContain("uv");
  });

  test("exit-code mapping: 2→blocked, 0→proceeded, timeout→timeout", async () => {
    mockRun.mockResolvedValueOnce(ok({ exitCode: 2 }));
    expect(
      (
        await runHookScript({
          sandboxId: "s",
          caller: { userId: "u", organizationId: "o" },
          hookFile: hook(),
          payload: {},
        })
      ).outcome,
    ).toBe("blocked");

    mockRun.mockResolvedValueOnce(ok({ exitCode: 0 }));
    expect(
      (
        await runHookScript({
          sandboxId: "s",
          caller: { userId: "u", organizationId: "o" },
          hookFile: hook(),
          payload: {},
        })
      ).outcome,
    ).toBe("proceeded");

    mockRun.mockResolvedValueOnce(ok({ timedOut: true, exitCode: 124 }));
    expect(
      (
        await runHookScript({
          sandboxId: "s",
          caller: { userId: "u", organizationId: "o" },
          hookFile: hook(),
          payload: {},
        })
      ).outcome,
    ).toBe("timeout");
  });

  test("runtime throw from runCommand → error outcome, never throws (fail open)", async () => {
    mockRun.mockRejectedValueOnce(new Error("engine down"));
    expect(
      (
        await runHookScript({
          sandboxId: "s",
          caller: { userId: "u", organizationId: "o" },
          hookFile: hook(),
          payload: {},
        })
      ).outcome,
    ).toBe("error");
  });

  test("runtime throw from uploadFile → error outcome, never throws (fail open)", async () => {
    mockUpload.mockRejectedValueOnce(new Error("upload failed"));
    expect(
      (
        await runHookScript({
          sandboxId: "s",
          caller: { userId: "u", organizationId: "o" },
          hookFile: hook(),
          payload: {},
        })
      ).outcome,
    ).toBe("error");
  });

  test("passes timeoutSeconds: 30 to runCommand", async () => {
    mockRun.mockResolvedValue(ok());
    await runHookScript({
      sandboxId: "s",
      caller: { userId: "u", organizationId: "o" },
      hookFile: hook(),
      payload: {},
    });
    expect(mockRun.mock.calls[0][0].timeoutSeconds).toBe(30);
  });

  test("python without deps → plain python3, no uv", async () => {
    mockRun.mockResolvedValue(ok());
    await runHookScript({
      sandboxId: "s",
      caller: { userId: "u", organizationId: "o" },
      hookFile: hook({ requirements: [] }),
      payload: {},
    });
    const cmd = mockRun.mock.calls[0][0].command;
    expect(cmd).toContain("python3 '/home/sandbox/hooks/h/guard.py'");
    expect(cmd).not.toContain("uv");
  });

  test("script dedupeId is a stable uuid v5-style string, deterministic per (path, content)", async () => {
    mockRun.mockResolvedValue(ok());

    // first fire
    await runHookScript({
      sandboxId: "s",
      caller: { userId: "u", organizationId: "o" },
      hookFile: hook({ id: "h1", fileName: "check.py", content: "exit(0)" }),
      payload: {},
    });
    const firstDedupeId = mockUpload.mock.calls[0][0].dedupeId as string;
    expect(firstDedupeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    mockUpload.mockReset();
    mockUpload.mockResolvedValue(uploadOk());
    mockRun.mockResolvedValue(ok());

    // second fire, same hook — dedupeId must be identical
    await runHookScript({
      sandboxId: "s",
      caller: { userId: "u", organizationId: "o" },
      hookFile: hook({ id: "h1", fileName: "check.py", content: "exit(0)" }),
      payload: { x: 2 },
    });
    expect(mockUpload.mock.calls[0][0].dedupeId).toBe(firstDedupeId);

    mockUpload.mockReset();
    mockUpload.mockResolvedValue(uploadOk());
    mockRun.mockResolvedValue(ok());

    // different content → different dedupeId
    await runHookScript({
      sandboxId: "s",
      caller: { userId: "u", organizationId: "o" },
      hookFile: hook({ id: "h1", fileName: "check.py", content: "exit(1)" }),
      payload: {},
    });
    expect(mockUpload.mock.calls[0][0].dedupeId).not.toBe(firstDedupeId);
  });

  test("script path is namespaced by hook id to avoid collisions", async () => {
    mockRun.mockResolvedValue(ok());
    await runHookScript({
      sandboxId: "s",
      caller: { userId: "u", organizationId: "o" },
      hookFile: hook({ id: "hook-42", fileName: "check.py" }),
      payload: {},
    });
    const scriptUpload = mockUpload.mock.calls[0][0];
    expect(scriptUpload.path).toBe("/home/sandbox/hooks/hook-42/check.py");
  });

  test("payload path contains hook id dir and unique uuid segment", async () => {
    mockRun.mockResolvedValue(ok());
    await runHookScript({
      sandboxId: "s",
      caller: { userId: "u", organizationId: "o" },
      hookFile: hook({ id: "hook-42" }),
      payload: { x: 1 },
    });
    const payloadUpload = mockUpload.mock.calls[1][0];
    expect(payloadUpload.path).toMatch(
      /^\/home\/sandbox\/hooks\/hook-42\/payload-.+\.json$/,
    );
  });
});
