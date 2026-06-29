import crypto from "node:crypto";
import type { A2AAttachment } from "@/agents/a2a-executor";
import config from "@/config";
import { SkillSandboxReplayEventModel } from "@/models";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { SKILL_SANDBOX_HOME } from "@/skills-sandbox/runtime-image";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "@/test";
import { stageAttachmentsIntoSandbox } from "./stage-attachments";

// Exercises the real staging path against the test DB: per-execution sandbox
// creation + uploadFile persist an ordered upload replay event. `uploadFile`
// does no Dagger work, so enabling the runtime flags is enough (no container).
describe("stageAttachmentsIntoSandbox (integration)", () => {
  const originalSkills = config.skillsSandbox.enabled;
  const originalDagger = config.daggerRuntime.enabled;
  const isolationKeys: string[] = [];

  beforeAll(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
    (config.daggerRuntime as { enabled: boolean }).enabled = true;
  });
  afterAll(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = originalSkills;
    (config.daggerRuntime as { enabled: boolean }).enabled = originalDagger;
  });
  afterEach(async () => {
    for (const key of isolationKeys.splice(0)) {
      await executionSandboxRegistry.release(key);
    }
  });

  async function uploadLog(params: {
    organizationId: string;
    userId: string;
    isolationKey: string;
  }) {
    const sandbox = await executionSandboxRegistry.getOrCreateDefault({
      ...params,
      defaultCwd: SKILL_SANDBOX_HOME,
    });
    const log = await SkillSandboxReplayEventModel.listBySandbox(sandbox.id);
    return log.filter((e) => e.kind === "upload");
  }

  test("stages a non-readable file with a shell-unsafe name as an upload event", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const isolationKey = crypto.randomUUID();
    isolationKeys.push(isolationKey);

    const attachments: A2AAttachment[] = [
      {
        contentType: "application/octet-stream",
        contentBase64: Buffer.from("sqlite-bytes").toString("base64"),
        name: "weird name$.sqlite",
      },
    ];

    const results = await stageAttachmentsIntoSandbox({
      attachments,
      organizationId: org.id,
      userId: user.id,
      isolationKey,
      agentId: "agent-x",
    });

    // The shell-unsafe name is sanitized and lands under the attachments dir.
    expect(results).toEqual([
      { path: "/home/sandbox/attachments/weird_name_.sqlite" },
    ]);

    const uploads = await uploadLog({
      organizationId: org.id,
      userId: user.id,
      isolationKey,
    });
    expect(uploads).toHaveLength(1);
    const [upload] = uploads;
    if (upload?.kind !== "upload") throw new Error("expected an upload event");
    expect(upload.upload.path).toBe(
      "/home/sandbox/attachments/weird_name_.sqlite",
    );
    expect(upload.upload.data?.toString("utf8")).toBe("sqlite-bytes");
    expect(upload.upload.sourceAttachmentId).not.toBeNull();
  });

  test("stages identical content once within a turn", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const isolationKey = crypto.randomUUID();
    isolationKeys.push(isolationKey);

    const contentBase64 = Buffer.from("same-bytes").toString("base64");
    const attachments: A2AAttachment[] = [
      { contentType: "application/octet-stream", contentBase64, name: "a.bin" },
      { contentType: "application/octet-stream", contentBase64, name: "b.bin" },
    ];

    const results = await stageAttachmentsIntoSandbox({
      attachments,
      organizationId: org.id,
      userId: user.id,
      isolationKey,
      agentId: "agent-x",
    });

    expect(results.every((r) => "path" in r)).toBe(true);
    const uploads = await uploadLog({
      organizationId: org.id,
      userId: user.id,
      isolationKey,
    });
    expect(uploads).toHaveLength(1);
  });
});
