import { A2AContextModel, A2ATaskModel } from "@/models";
import { describe, expect, test } from "@/test";
import { persistAgentRunInputs, taskWithAgentRunInputs } from "./input-files";
import { agentRuntimeAttachmentsManifestPath } from "./runtime-contract";

describe("Agent run input files", () => {
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
    const prompt = taskWithAgentRunInputs({
      taskId: task.id,
      task: "Read both.",
      inputs,
    });
    expect(prompt).toContain("Read both.");
    expect(prompt).toContain(agentRuntimeAttachmentsManifestPath(task.id));
    for (const input of inputs) {
      expect(prompt).not.toContain(input.runtimePath);
    }
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
          name: "screenshot.png",
          contentType: "image/png",
          contentBase64: Buffer.from("follow-up").toString("base64"),
        },
      ],
    });
    expect(inputs.map((input) => input.runtimePath)).not.toContain(
      followUpInput.runtimePath,
    );
    expect(followUpInput.fileData.toString("utf8")).toBe("follow-up");
    const followUpPrompt = taskWithAgentRunInputs({
      taskId: followUp.id,
      task: "Inspect the screenshot.",
      inputs: [followUpInput],
    });
    expect(followUpPrompt).toContain("Inspect the screenshot.");
    expect(followUpPrompt).toContain(
      agentRuntimeAttachmentsManifestPath(followUp.id),
    );
    expect(followUpPrompt).not.toContain(
      agentRuntimeAttachmentsManifestPath(task.id),
    );
    expect(followUpPrompt).not.toContain(followUpInput.runtimePath);
    expect(followUpPrompt).not.toContain(followUpInput.originalName);
  });

  test.each([
    undefined,
    null,
    "",
    "Keep\nthese instructions.",
  ])("preserves a task without attachments: %s", (task) => {
    expect(
      taskWithAgentRunInputs({ taskId: "empty-task", task, inputs: [] }),
    ).toBe(task);
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
