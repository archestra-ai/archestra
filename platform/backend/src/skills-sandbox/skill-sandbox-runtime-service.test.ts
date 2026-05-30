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

  test("is disabled when ARCHESTRA_AGENTS_SKILLS_ENABLED or ARCHESTRA_CODE_RUNTIME_ENABLED is unset", () => {
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
    vi.stubEnv("ARCHESTRA_AGENTS_SKILLS_ENABLED", "true");
    vi.stubEnv("ARCHESTRA_CODE_RUNTIME_ENABLED", "true");
    vi.stubEnv(
      "ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST",
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
    vi.stubEnv("ARCHESTRA_AGENTS_SKILLS_ENABLED", "true");
    vi.stubEnv("ARCHESTRA_CODE_RUNTIME_ENABLED", "true");
    vi.stubEnv(
      "ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST",
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
    vi.stubEnv("ARCHESTRA_AGENTS_SKILLS_ENABLED", "true");
    vi.stubEnv("ARCHESTRA_CODE_RUNTIME_ENABLED", "true");
    vi.stubEnv(
      "ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST",
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

  test("pythonpathForSandbox puts primary first, then alphabetical secondaries", () => {
    const sandbox = makeFakeSandbox({ primarySkillId: "skill-b-id" });
    const snapshots = [
      makeSnapshotRow("skill-a-id", "skill-a"),
      makeSnapshotRow("skill-b-id", "skill-b"),
      makeSnapshotRow("skill-c-id", "skill-c"),
    ];
    expect(__internals.pythonpathForSandbox(sandbox, snapshots)).toBe(
      "/skills/skill-b:/skills/skill-a:/skills/skill-c",
    );
  });

  test("pythonpathForSandbox falls back to alphabetical when primary is missing", () => {
    const sandbox = makeFakeSandbox({ primarySkillId: null });
    const snapshots = [
      makeSnapshotRow("skill-z-id", "skill-z"),
      makeSnapshotRow("skill-a-id", "skill-a"),
    ];
    expect(__internals.pythonpathForSandbox(sandbox, snapshots)).toBe(
      "/skills/skill-a:/skills/skill-z",
    );
  });

  test("autoInstallCommands emits one uv install per skill with requirements.txt, primary first", () => {
    const sandbox = makeFakeSandbox({ primarySkillId: "skill-b-id" });
    const snapshots = [
      makeSnapshotRow("skill-a-id", "skill-a", "SKILL.md"),
      makeSnapshotRow("skill-a-id", "skill-a", "requirements.txt"),
      makeSnapshotRow("skill-b-id", "skill-b", "SKILL.md"),
      makeSnapshotRow("skill-b-id", "skill-b", "requirements.txt"),
      makeSnapshotRow("skill-c-id", "skill-c", "SKILL.md"),
      // no requirements.txt — skipped
    ];
    const installs = __internals.autoInstallCommands(sandbox, snapshots);
    expect(installs.map((c) => c.command)).toEqual([
      "uv pip install --python /home/sandbox/.venv/bin/python --quiet -r '/skills/skill-b/requirements.txt'",
      "uv pip install --python /home/sandbox/.venv/bin/python --quiet -r '/skills/skill-a/requirements.txt'",
    ]);
    expect(installs.every((c) => c.cwd === "/home/sandbox")).toBe(true);
    expect(installs.every((c) => c.timeoutSeconds === 180)).toBe(true);
  });

  test("autoInstallCommands shell-quotes skill names containing spaces", () => {
    const sandbox = makeFakeSandbox({ primarySkillId: "skill-a-id" });
    const snapshots = [
      makeSnapshotRow("skill-a-id", "My Skill", "requirements.txt"),
    ];
    const installs = __internals.autoInstallCommands(sandbox, snapshots);
    expect(installs.map((c) => c.command)).toEqual([
      "uv pip install --python /home/sandbox/.venv/bin/python --quiet -r '/skills/My Skill/requirements.txt'",
    ]);
  });

  test("autoInstallCommands returns [] when no skill ships requirements.txt", () => {
    const sandbox = makeFakeSandbox({ primarySkillId: "skill-a-id" });
    const snapshots = [
      makeSnapshotRow("skill-a-id", "skill-a", "SKILL.md"),
      makeSnapshotRow("skill-a-id", "skill-a", "core/util.py"),
    ];
    expect(__internals.autoInstallCommands(sandbox, snapshots)).toEqual([]);
  });
});

function makeFakeSandbox(overrides: {
  primarySkillId: string | null;
}): import("@/types").SkillSandbox {
  return {
    id: "sandbox-1",
    organizationId: "org-1",
    userId: "user-1",
    conversationId: null,
    agentId: null,
    primarySkillId: overrides.primarySkillId,
    defaultCwd: "/skills/skill-b",
    createdAt: new Date(),
  };
}

function makeSnapshotRow(
  skillId: string,
  skillName: string,
  path: string = "SKILL.md",
): import("@/types").SkillSandboxFileSnapshot {
  return {
    id: `snap-${skillId}-${path}`,
    sandboxId: "sandbox-1",
    organizationId: "org-1",
    skillId,
    skillName,
    path,
    encoding: "utf8",
    content: "",
    createdAt: new Date(),
  };
}
