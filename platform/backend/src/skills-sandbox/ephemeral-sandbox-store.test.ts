import { randomUUID } from "node:crypto";
import { readArtifact, runSandbox } from "@archestra/sandbox-rs";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  AgentModel,
  SkillModel,
  SkillSandboxModel,
  SkillVersionModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { asSandboxId } from "@/types";
import { ephemeralSandboxStore } from "./ephemeral-sandbox-store";
import { skillSandboxRuntimeService } from "./skill-sandbox-runtime-service";

// Only the native process boundary is mocked; recipe orchestration, permissions,
// skill version reads and database assertions use the real implementation.
vi.mock("@archestra/sandbox-rs", () => ({
  runSandbox: vi.fn(),
  readArtifact: vi.fn(),
  checkSession: vi.fn().mockResolvedValue(undefined),
  flushTelemetry: vi.fn().mockResolvedValue(undefined),
}));

const keys: string[] = [];
const completed = {
  stdout: "private output",
  stderr: "",
  exitCode: 0,
  durationMs: 1,
  timedOut: false,
  truncated: false,
};

function openSandbox(onRelease?: () => void) {
  const isolationKey = `slack-ephemeral:${randomUUID()}`;
  keys.push(isolationKey);
  ephemeralSandboxStore.openExecution(isolationKey, onRelease);
  const sandbox = ephemeralSandboxStore.create({
    isolationKey,
    organizationId: "org",
    userId: "user",
    defaultCwd: "/home/sandbox",
  });
  return {
    isolationKey,
    sandbox,
    sandboxId: asSandboxId(sandbox.id),
    caller: { organizationId: "org", userId: "user" },
  };
}

async function expectNoPersistedRecipe() {
  for (const table of [
    schema.skillSandboxesTable,
    schema.skillSandboxFilesTable,
    schema.skillSandboxCommandsTable,
    schema.skillSandboxReplayEventsTable,
    schema.skillSandboxSkillMountsTable,
    schema.filesTable,
  ]) {
    expect(await db.select().from(table)).toEqual([]);
  }
}

beforeEach(() => {
  config.skillsSandbox.enabled = true;
  config.daggerRuntime.enabled = true;
  config.daggerRuntime.runnerHost = undefined;
  vi.mocked(runSandbox).mockReset().mockResolvedValue(completed);
  vi.mocked(readArtifact)
    .mockReset()
    .mockResolvedValue({
      dataBase64: Buffer.from("private file").toString("base64"),
      sizeBytes: 12,
    });
});

afterEach(() => {
  for (const key of keys.splice(0)) ephemeralSandboxStore.release(key);
  vi.useRealTimers();
});

describe("temporary sandbox lifecycle", () => {
  test("upload, replay and capture keep exact bytes for this execution without database rows or host spool paths", async () => {
    const released = vi.fn();
    const ctx = openSandbox(released);
    const data = Buffer.alloc(300 * 1024, 0xa5);
    const params = {
      sandboxId: ctx.sandboxId,
      path: "input.bin",
      data,
      dedupeId: randomUUID(),
    };
    const upload = await skillSandboxRuntimeService.uploadFile(params);
    expect(await skillSandboxRuntimeService.uploadFile(params)).toEqual(upload);
    data.fill(0); // retained replay owns a copy, not the caller's mutable buffer
    const result = await skillSandboxRuntimeService.runCommand({
      ...ctx,
      command: "cp input.bin output.bin",
    });
    expect(result.stdout).toBe(completed.stdout);
    const captured = await skillSandboxRuntimeService.exportArtifact({
      ...ctx,
      path: "output.bin",
      overwrite: true,
    });
    expect(captured.artifactId).toBeUndefined();
    expect(captured.overwritten).toBe(false);
    expect(captured.data.toString()).toBe("private file");
    const replay = vi.mocked(readArtifact).mock.calls[0]?.[0];
    expect(replay?.spoolRoot).toBeUndefined();
    expect(replay?.replayEntries.map((entry) => entry.kind)).toEqual([
      "file",
      "command",
    ]);
    const file = replay?.replayEntries[0]?.file;
    expect(file?.hostPath).toBeUndefined();
    expect(Buffer.from(file?.content ?? "", "base64")).toEqual(
      Buffer.alloc(300 * 1024, 0xa5),
    );
    expect(JSON.stringify(replay?.replayEntries)).not.toContain(
      completed.stdout,
    );
    await expectNoPersistedRecipe();
    ephemeralSandboxStore.release(ctx.isolationKey);
    ephemeralSandboxStore.release(ctx.isolationKey);
    expect(released).toHaveBeenCalledTimes(1);
    expect(ephemeralSandboxStore.findById(ctx.sandbox.id)).toBeUndefined();
    await expect(skillSandboxRuntimeService.uploadFile(params)).rejects.toThrow(
      "does not exist",
    );
    expect(() =>
      ephemeralSandboxStore.create({
        ...ctx.sandbox,
        isolationKey: ctx.isolationKey,
      }),
    ).toThrow("has ended");
    await expectNoPersistedRecipe();
  });

  test("an uncertain native failure remains replayable only within the live execution", async () => {
    const ctx = openSandbox();
    vi.mocked(runSandbox).mockRejectedValueOnce(
      new Error("native operation failed"),
    );
    await expect(
      skillSandboxRuntimeService.runCommand({
        ...ctx,
        command: "partially-completed-work",
      }),
    ).rejects.toThrow("not available");
    await skillSandboxRuntimeService.runCommand({
      ...ctx,
      command: "inspect-result",
    });
    expect(vi.mocked(runSandbox).mock.calls[1]?.[0].replayEntries).toEqual([
      {
        kind: "command",
        command: {
          command: "partially-completed-work",
          cwd: "/home/sandbox",
          timeoutSeconds: config.skillsSandbox.wallClockSeconds,
        },
      },
    ]);
    await expectNoPersistedRecipe();
  });

  test("closing during native execution rejects its result and all queued work without recreating a recipe", async () => {
    const ctx = openSandbox();
    const entered = deferred<void>();
    const native = deferred<typeof completed>();
    vi.mocked(runSandbox).mockImplementationOnce(() => {
      entered.resolve();
      return native.promise;
    });
    const running = skillSandboxRuntimeService.runCommand({
      ...ctx,
      command: "generate-private-file",
    });
    await entered.promise;
    const queued = skillSandboxRuntimeService.uploadFile({
      sandboxId: ctx.sandboxId,
      path: "late.txt",
      data: Buffer.from("late bytes"),
    });
    const settled = Promise.allSettled([running, queued]);
    ephemeralSandboxStore.release(ctx.isolationKey);
    native.resolve(completed);
    for (const result of await settled) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason.message).toContain("has ended");
    }
    expect(ephemeralSandboxStore.findById(ctx.sandbox.id)).toBeUndefined();
    await expectNoPersistedRecipe();
  });

  test("closing during artifact capture discards the completed capture", async () => {
    const ctx = openSandbox();
    const entered = deferred<void>();
    const native = deferred<{
      dataBase64: string;
      sizeBytes: number;
    }>();
    vi.mocked(readArtifact).mockImplementationOnce(() => {
      entered.resolve();
      return native.promise;
    });
    const capture = skillSandboxRuntimeService.exportArtifact({
      ...ctx,
      path: "private.txt",
    });
    const rejected = expect(capture).rejects.toThrow("has ended");
    await entered.promise;
    ephemeralSandboxStore.release(ctx.isolationKey);
    native.resolve({
      dataBase64: Buffer.from("private").toString("base64"),
      sizeBytes: 7,
    });
    await rejected;
    await expectNoPersistedRecipe();
  });

  test("idle executions proactively expire and reject writes through previously captured leases", () => {
    vi.useFakeTimers();
    const released = vi.fn(() =>
      ephemeralSandboxStore.release(ctx.isolationKey),
    );
    const ctx = openSandbox(released);
    const state = ephemeralSandboxStore.findById(ctx.sandbox.id);
    expect(state).toBeDefined();
    state?.appendUpload({
      path: "/home/sandbox/private",
      data: Buffer.from("private"),
      mimeType: "text/plain",
    });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(released).toHaveBeenCalledTimes(1);
    expect(ephemeralSandboxStore.findById(ctx.sandbox.id)).toBeUndefined();
    expect(() =>
      state?.appendCommand({ command: "late", timeoutSeconds: 1 }),
    ).toThrow("has ended");
    expect(() =>
      ephemeralSandboxStore.assertExecutionActive(ctx.isolationKey),
    ).toThrow("has ended");
  });

  test("entry limits apply across sandboxes and release restores global capacity", () => {
    const fill = (ctx: ReturnType<typeof openSandbox>) => {
      const state = ephemeralSandboxStore.findById(ctx.sandbox.id);
      if (!state) throw new Error("Missing temporary sandbox");
      for (let i = 0; i < 256; i++)
        state.appendCommand({ command: "true", timeoutSeconds: 1 });
    };
    const ctx = openSandbox();
    fill(ctx);
    const other = ephemeralSandboxStore.create({
      ...ctx.sandbox,
      isolationKey: ctx.isolationKey,
    });
    expect(() =>
      ephemeralSandboxStore.findById(other.id)?.appendUpload({
        path: "/home/sandbox/extra",
        data: Buffer.from("x"),
        mimeType: "text/plain",
      }),
    ).toThrow("storage is full");
    for (let i = 0; i < 7; i++) fill(openSandbox());
    const next = openSandbox();
    expect(() =>
      ephemeralSandboxStore
        .findById(next.sandbox.id)
        ?.appendCommand({ command: "true", timeoutSeconds: 1 }),
    ).toThrow("storage is full");
    ephemeralSandboxStore.release(ctx.isolationKey);
    expect(() => fill(next)).not.toThrow();
  });

  test("byte limits reject an upload atomically before retaining a partial recipe", () => {
    const ctx = openSandbox();
    const state = ephemeralSandboxStore.findById(ctx.sandbox.id);
    const data = Buffer.alloc(32 * 1024 * 1024, 1);
    state?.appendUpload({
      path: "/home/sandbox/first",
      data,
      mimeType: "application/octet-stream",
    });
    expect(() =>
      state?.appendUpload({
        path: "/home/sandbox/second",
        data,
        mimeType: "application/octet-stream",
      }),
    ).toThrow("storage is full");
    expect(state?.replayEntries).toHaveLength(1);
  });

  test("mounted versions remain pinned and the existing skill revocation gate still blocks execution", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: ADMIN_ROLE_NAME });
    const agent = await makeAgent({ organizationId: organization.id });
    const ctx = openSandbox();
    const sandbox = ephemeralSandboxStore.create({
      isolationKey: ctx.isolationKey,
      organizationId: organization.id,
      userId: user.id,
      defaultCwd: "/home/sandbox",
    });
    const sandboxId = asSandboxId(sandbox.id);
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: organization.id,
        name: "volatile-skill",
        description: "Test",
        content: "Version one",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [
        {
          path: "requirements.txt",
          content: "pillow",
          encoding: "utf8",
          kind: "script",
        },
      ],
    });
    if (!skill) throw new Error("skill seed failed");
    const version = await SkillVersionModel.findBySkillAndVersion(
      skill.id,
      skill.latestVersion,
    );
    if (!version) throw new Error("version seed failed");
    const params = {
      sandboxId,
      skill: {
        skillId: skill.id,
        skillName: skill.name,
        skillVersionId: version.id,
      },
    };
    expect(await skillSandboxRuntimeService.mountSkill(params)).not.toBeNull();
    const updated = await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { content: "Version two" },
    });
    if (!updated) throw new Error("skill update failed");
    const newerVersion = await SkillVersionModel.findBySkillAndVersion(
      skill.id,
      updated.latestVersion,
    );
    if (!newerVersion) throw new Error("new version seed failed");
    expect(
      await skillSandboxRuntimeService.mountSkill({
        ...params,
        skill: { ...params.skill, skillVersionId: newerVersion.id },
      }),
    ).toBeNull();
    expect(
      await skillSandboxRuntimeService.findMountBySkill({
        sandboxId,
        skillId: skill.id,
      }),
    ).toMatchObject({ skillVersionId: version.id });
    const caller = {
      userId: user.id,
      organizationId: organization.id,
      agentId: agent.id,
    };
    await skillSandboxRuntimeService.runCommand({
      sandboxId,
      caller,
      command: "true",
    });
    const replay = vi.mocked(runSandbox).mock.calls[0]?.[0].replayEntries;
    expect(replay?.map((entry) => entry.kind)).toEqual([
      "skill_mount",
      "command",
    ]);
    expect(replay?.[0]?.skillMount?.files[0]?.content).toBe("Version one");
    await AgentModel.setActivationSkillPolicyState({
      id: agent.id,
      mode: "manual",
      revision: 1,
    });
    await expect(
      skillSandboxRuntimeService.runCommand({
        sandboxId,
        caller,
        command: "private work",
      }),
    ).rejects.toThrow("no longer enabled");
    expect(runSandbox).toHaveBeenCalledTimes(1);
    expect(await SkillSandboxModel.findById(sandboxId)).toBeNull();
    await expectNoPersistedRecipe();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
