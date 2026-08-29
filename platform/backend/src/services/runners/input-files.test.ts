import { A2AContextModel, A2ATaskModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
  persistAgentExecutionInputs,
  taskWithAgentExecutionInputs,
} from "./input-files";

describe("Agent execution input files", () => {
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

    const inputs = await persistAgentExecutionInputs({
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
      "/var/run/archestra/attachments/notes.txt",
      "/var/run/archestra/attachments/notes (1).txt",
    ]);
    expect(inputs.map((input) => input.fileData.toString("utf8"))).toEqual([
      "first",
      "second",
    ]);
    expect(taskWithAgentExecutionInputs({ task: "Read both.", inputs })).toBe(
      "Read both.\n\nAttached files are available in the execution workspace:\n- /var/run/archestra/attachments/notes.txt\n- /var/run/archestra/attachments/notes (1).txt",
    );
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

    const [input] = await persistAgentExecutionInputs({
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
