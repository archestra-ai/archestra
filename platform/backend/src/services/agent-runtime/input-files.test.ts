import { CHATOPS_ATTACHMENT_LIMITS } from "@/agents/chatops/constants";
import { A2AContextModel, A2ATaskModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
  buildEphemeralAgentRunInputs,
  persistAgentRunInputs,
  taskWithAgentRunInputs,
} from "./input-files";

describe("Agent run input files", () => {
  test("rejects excessive ephemeral originals before copying them into runtime inputs", () => {
    const oversized = Buffer.alloc(
      CHATOPS_ATTACHMENT_LIMITS.MAX_THREAD_FILE_SIZE + 1,
    );
    const attachment = (data: Buffer) => ({
      name: "preview.txt",
      contentType: "text/plain",
      contentBase64: "",
      originalFile: { filename: "input.bin", data },
    });
    for (const attachments of [
      Array.from(
        { length: CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE + 1 },
        () => attachment(oversized.subarray(0, 1)),
      ),
      [attachment(oversized)],
      [
        attachment(oversized.subarray(0, 20 * 1024 * 1024)),
        attachment(oversized.subarray(0, 5 * 1024 * 1024 + 1)),
      ],
    ]) {
      expect(() =>
        buildEphemeralAgentRunInputs({
          taskId: crypto.randomUUID(),
          attachments,
        }),
      ).toThrow(/Too many files|attachment limit/);
    }
  });

  test("stores binary inputs at collision-safe runtime paths", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: user.id,
      agentType: "agent",
    });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    const task = await A2ATaskModel.createForRun({
      contextId: context.id,
      agentId: agent.id,
    });

    const inputs = await persistAgentRunInputs({
      taskId: task.id,
      organizationId: organization.id,
      uploadedByUserId: user.id,
      attachments: [
        {
          name: "notes.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from("first").toString("base64"),
        },
        {
          name: "notes.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from("second").toString("base64"),
        },
      ],
    });

    expect(inputs.map((input) => input.runtimePath)).toEqual([
      `/var/run/archestra/attachments/${task.id}/notes.txt`,
      `/var/run/archestra/attachments/${task.id}/notes (1).txt`,
    ]);
    expect(inputs.map((input) => input.fileData.toString("utf8"))).toEqual([
      "first",
      "second",
    ]);
    expect(taskWithAgentRunInputs({ task: "Read both.", inputs })).toBe(
      `Read both.\n\nAttached files are available in the run workspace:\n- /var/run/archestra/attachments/${task.id}/notes.txt\n- /var/run/archestra/attachments/${task.id}/notes (1).txt`,
    );
    const followUp = await A2ATaskModel.createForRun({
      contextId: context.id,
      agentId: agent.id,
    });
    const [followUpInput] = await persistAgentRunInputs({
      taskId: followUp.id,
      organizationId: organization.id,
      uploadedByUserId: user.id,
      attachments: [
        {
          name: "notes.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from("follow-up").toString("base64"),
        },
      ],
    });
    expect(inputs.map((input) => input.runtimePath)).not.toContain(
      followUpInput.runtimePath,
    );
    expect(followUpInput.fileData.toString("utf8")).toBe("follow-up");
  });

  test("stores inputs from a system-originated task without a user owner", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const author = await makeUser();
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: author.id,
      agentType: "agent",
    });
    const context = await A2AContextModel.create({
      actorKind: "system",
      actorId: "system",
    });
    const task = await A2ATaskModel.createForRun({
      contextId: context.id,
      agentId: agent.id,
    });

    const [input] = await persistAgentRunInputs({
      taskId: task.id,
      organizationId: organization.id,
      uploadedByUserId: null,
      attachments: [
        {
          name: "message.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from("system input").toString("base64"),
        },
      ],
    });

    expect(input.uploadedByUserId).toBeNull();
    expect(input.fileData.toString("utf8")).toBe("system input");
  });
});
