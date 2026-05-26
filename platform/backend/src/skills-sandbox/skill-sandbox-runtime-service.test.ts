import { afterEach, describe, expect, test, vi } from "@/test";
import {
  __internals,
  skillSandboxRuntimeService,
} from "./skill-sandbox-runtime-service";
import { SkillSandboxError } from "./types";

describe("skillSandboxRuntimeService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("is disabled when ARCHESTRA_SKILLS_SANDBOX_ENABLED is unset", () => {
    expect(skillSandboxRuntimeService.isEnabled).toBe(false);
    expect(skillSandboxRuntimeService.isReady).toBe(false);
  });

  test("runCommand rejects with SkillSandboxError while disabled", async () => {
    await expect(
      skillSandboxRuntimeService.runCommand({
        sandboxId: __internals.asSandboxId(crypto.randomUUID()),
        command: "echo hi",
      }),
    ).rejects.toBeInstanceOf(SkillSandboxError);
  });

  test("exportArtifact rejects with SkillSandboxError while disabled", async () => {
    await expect(
      skillSandboxRuntimeService.exportArtifact({
        sandboxId: __internals.asSandboxId(crypto.randomUUID()),
        path: "out/report.txt",
      }),
    ).rejects.toBeInstanceOf(SkillSandboxError);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
  ])("runCommand rejects invalid timeoutSeconds=%s before initializing", async (timeoutSeconds) => {
    vi.resetModules();
    vi.stubEnv("ARCHESTRA_SKILLS_SANDBOX_ENABLED", "true");
    vi.stubEnv(
      "ARCHESTRA_SKILLS_SANDBOX_DAGGER_RUNNER_HOST",
      "tcp://dagger-runtime.dagger.svc.cluster.local:1234",
    );
    const { skillSandboxRuntimeService: enabled } = await import(
      "./skill-sandbox-runtime-service"
    );

    await expect(
      enabled.runCommand({
        sandboxId: __internals.asSandboxId(crypto.randomUUID()),
        command: "echo hi",
        timeoutSeconds,
      }),
    ).rejects.toThrow("timeoutSeconds must");
  });

  test("runCommand rejects empty commands", async () => {
    vi.resetModules();
    vi.stubEnv("ARCHESTRA_SKILLS_SANDBOX_ENABLED", "true");
    vi.stubEnv(
      "ARCHESTRA_SKILLS_SANDBOX_DAGGER_RUNNER_HOST",
      "tcp://dagger-runtime.dagger.svc.cluster.local:1234",
    );
    const { skillSandboxRuntimeService: enabled } = await import(
      "./skill-sandbox-runtime-service"
    );

    await expect(
      enabled.runCommand({
        sandboxId: __internals.asSandboxId(crypto.randomUUID()),
        command: "   ",
      }),
    ).rejects.toThrow("command must be a non-empty string");
  });

  test("runCommand rejects after maxSandboxQueueLength requests for the same sandbox", async () => {
    vi.resetModules();
    vi.stubEnv("ARCHESTRA_SKILLS_SANDBOX_ENABLED", "true");
    vi.stubEnv(
      "ARCHESTRA_SKILLS_SANDBOX_DAGGER_RUNNER_HOST",
      "tcp://dagger-runtime.dagger.svc.cluster.local:1234",
    );
    const { skillSandboxRuntimeService: enabled } = await import(
      "./skill-sandbox-runtime-service"
    );
    const { SKILL_SANDBOX_LIMITS } = await import("./types");

    const sandboxId = __internals.asSandboxId(crypto.randomUUID());
    // fire maxSandboxQueueLength+1 concurrent calls; all will fail (no real
    // Dagger engine) but the first N reach the per-sandbox chain while the
    // (N+1)th is rejected immediately by the queue-length guard before any await.
    const calls = Array.from(
      { length: SKILL_SANDBOX_LIMITS.maxSandboxQueueLength + 1 },
      () => enabled.runCommand({ sandboxId, command: "echo hi" }),
    );
    const results = await Promise.allSettled(calls);
    // use message check rather than instanceof: vi.resetModules creates a fresh
    // class so instanceof against the top-level import would always be false.
    const queueErrors = results.filter(
      (r) =>
        r.status === "rejected" &&
        (r.reason as Error)?.message?.includes("too many requests"),
    );
    expect(queueErrors.length).toBeGreaterThanOrEqual(1);
  });
});

describe("__internals", () => {
  test("shellQuote single-quotes input and escapes embedded quotes", () => {
    expect(__internals.shellQuote("simple")).toBe("'simple'");
    expect(__internals.shellQuote("a 'b' c")).toBe(`'a '\\''b'\\'' c'`);
  });

  test("resolveArtifactPath joins relative paths against defaultCwd", () => {
    expect(
      __internals.resolveArtifactPath({
        path: "out/report.txt",
        defaultCwd: "/skills/alpha",
      }),
    ).toBe("/skills/alpha/out/report.txt");

    expect(
      __internals.resolveArtifactPath({
        path: "/skills/alpha/out/report.txt",
        defaultCwd: "/skills/alpha",
      }),
    ).toBe("/skills/alpha/out/report.txt");

    expect(
      __internals.resolveArtifactPath({
        path: "/home/sandbox/output.json",
        defaultCwd: "/skills/alpha",
      }),
    ).toBe("/home/sandbox/output.json");

    expect(
      __internals.resolveArtifactPath({
        path: "out/report.txt",
        defaultCwd: "/skills/alpha/",
      }),
    ).toBe("/skills/alpha/out/report.txt");
  });

  test("resolveArtifactPath rejects path traversal", () => {
    expect(() =>
      __internals.resolveArtifactPath({
        path: "../../etc/passwd",
        defaultCwd: "/skills/alpha",
      }),
    ).toThrow("invalid artifact path");

    expect(() =>
      __internals.resolveArtifactPath({
        path: "/skills/alpha/../../../etc/passwd",
        defaultCwd: "/skills/alpha",
      }),
    ).toThrow("invalid artifact path");
  });

  test("resolveArtifactPath rejects paths with null bytes", () => {
    expect(() =>
      __internals.resolveArtifactPath({
        path: "out/file\x00.txt",
        defaultCwd: "/skills/alpha",
      }),
    ).toThrow("invalid artifact path");
  });

  test("resolveArtifactPath rejects absolute paths outside sandbox roots", () => {
    expect(() =>
      __internals.resolveArtifactPath({
        path: "/etc/passwd",
        defaultCwd: "/skills/alpha",
      }),
    ).toThrow("artifact path must be under");

    expect(() =>
      __internals.resolveArtifactPath({
        path: "/tmp/file.txt",
        defaultCwd: "/skills/alpha",
      }),
    ).toThrow("artifact path must be under");
  });

  test("validateSnapshotFilePath accepts normal relative paths", () => {
    expect(() =>
      __internals.validateSnapshotFilePath("SKILL.md"),
    ).not.toThrow();
    expect(() =>
      __internals.validateSnapshotFilePath("scripts/run.sh"),
    ).not.toThrow();
    expect(() =>
      __internals.validateSnapshotFilePath("assets/data.bin"),
    ).not.toThrow();
  });

  test("validateSnapshotFilePath rejects path traversal", () => {
    expect(() =>
      __internals.validateSnapshotFilePath("../../etc/passwd"),
    ).toThrow("invalid snapshot file path");
    expect(() =>
      __internals.validateSnapshotFilePath("scripts/../../../etc/passwd"),
    ).toThrow("invalid snapshot file path");
    expect(() => __internals.validateSnapshotFilePath("..")).toThrow(
      "invalid snapshot file path",
    );
  });

  test("validateSnapshotFilePath rejects absolute paths", () => {
    expect(() => __internals.validateSnapshotFilePath("/etc/passwd")).toThrow(
      "invalid snapshot file path",
    );
    expect(() =>
      __internals.validateSnapshotFilePath("/skills/alpha/file.txt"),
    ).toThrow("invalid snapshot file path");
  });

  test("truncateOutput passes through small outputs", () => {
    const result = __internals.truncateOutput("hello", 1024);
    expect(result.truncated).toBe(false);
    expect(result.value).toBe("hello");
  });

  test("truncateOutput truncates and marks oversize outputs", () => {
    const result = __internals.truncateOutput("0123456789", 5);
    expect(result.truncated).toBe(true);
    expect(result.value).toMatch(/^01234/);
    expect(result.value).toMatch(/output truncated/);
  });

  test("wrapWithTimeout cd's into cwd and wraps with GNU timeout", () => {
    const wrapped = __internals.wrapWithTimeout({
      command: "python --version",
      cwd: "/skills/alpha",
      timeoutSeconds: 30,
      outputBytesLimit: 1024,
      fileSizeLimitBytes: 16 * 1024 * 1024,
      cpuSeconds: 30,
      memoryBytes: 1024 * 1024 * 1024,
      maxProcesses: 256,
    });
    expect(wrapped).toContain("cd '/skills/alpha'");
    // --preserve-status must be absent: with it timeout exits 137 (SIGKILL),
    // not 124, so timedOut detection would always be false.
    expect(wrapped).not.toContain("--preserve-status");
    expect(wrapped).toContain("timeout --signal=KILL 30s");
    expect(wrapped).toContain("'python --version'");
    // limit+1 bytes are captured so truncateOutput can detect truncation
    expect(wrapped).toContain("head -c 1025");
    // exit code must be explicitly forwarded (no pipeline that swallows it)
    expect(wrapped).toContain("exit $_x");
    // ulimit -f must be present to cap per-file writes
    expect(wrapped).toContain("ulimit -f ");
  });
});
