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
        path: "/abs/path",
        defaultCwd: "/skills/alpha",
      }),
    ).toBe("/abs/path");

    expect(
      __internals.resolveArtifactPath({
        path: "out/report.txt",
        defaultCwd: "/skills/alpha/",
      }),
    ).toBe("/skills/alpha/out/report.txt");
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
    });
    expect(wrapped).toContain("cd '/skills/alpha'");
    expect(wrapped).toContain("timeout --preserve-status --signal=KILL 30s");
    expect(wrapped).toContain("'python --version'");
    expect(wrapped).toContain("head -c 1024");
  });
});
