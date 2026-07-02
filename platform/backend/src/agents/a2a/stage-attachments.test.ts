import crypto from "node:crypto";
import type { A2AAttachment } from "@/agents/a2a-executor";
import config from "@/config";
import { SkillSandboxModel, SkillSandboxReplayEventModel } from "@/models";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { SKILL_SANDBOX_HOME } from "@/skills-sandbox/runtime-image";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import { stageAttachmentsIntoSandbox } from "./stage-attachments";

// Exercises the real staging path against the test DB: per-execution sandbox
// creation + uploadFile persist an ordered upload replay event. `uploadFile`
// does no Dagger work, so enabling the runtime flags is enough (no container).
describe("stageAttachmentsIntoSandbox (integration)", () => {
  const originalSkills = config.skillsSandbox.enabled;
  const originalDagger = config.daggerRuntime.enabled;
  const isolationKeys: string[] = [];

  beforeEach(() => {
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
      conversationId: null,
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
      conversationId: null,
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

  test("stages into the conversation default sandbox when a conversationId is set", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    if (!conversation) throw new Error("conversation seed failed");

    const results = await stageAttachmentsIntoSandbox({
      attachments: [
        {
          contentType: "application/octet-stream",
          contentBase64: Buffer.from("conv-bytes").toString("base64"),
          name: "data.bin",
        },
      ],
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      // isolationKey is ignored on the conversation branch.
      isolationKey: crypto.randomUUID(),
      agentId: "agent-x",
    });

    expect(results).toEqual([{ path: "/home/sandbox/attachments/data.bin" }]);

    // The bytes land in the conversation's default sandbox — the same one
    // run_command resolves — not a per-execution sandbox.
    const sandbox = await SkillSandboxModel.findOrCreateDefault({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      defaultCwd: SKILL_SANDBOX_HOME,
    });
    const uploads = (
      await SkillSandboxReplayEventModel.listBySandbox(sandbox.id)
    ).filter((e) => e.kind === "upload");
    expect(uploads).toHaveLength(1);
  });

  test("returns an error marker per attachment when the sandbox cannot be created", async () => {
    // Unknown org/user ids make SkillSandboxModel.create fail its FK, so
    // getOrCreateDefault throws and every slot degrades to an error marker.
    const isolationKey = crypto.randomUUID();
    isolationKeys.push(isolationKey);

    const attachments: A2AAttachment[] = [
      {
        contentType: "application/octet-stream",
        contentBase64: Buffer.from("bytes").toString("base64"),
        name: "a.bin",
      },
      {
        contentType: "application/octet-stream",
        contentBase64: Buffer.from("more").toString("base64"),
        name: "b.bin",
      },
    ];

    const results = await stageAttachmentsIntoSandbox({
      attachments,
      organizationId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      conversationId: null,
      isolationKey,
      agentId: "agent-x",
    });

    expect(results).toEqual([{ error: true }, { error: true }]);
  });
});
