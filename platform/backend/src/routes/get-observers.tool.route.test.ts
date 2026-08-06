import {
  ADMIN_ROLE_NAME,
  CLAUDE_CODE_CLIENT_ID,
  CODEX_CLIENT_ID,
} from "@archestra/shared";
import { ToolObservationModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("tool observation filters", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    const org = await makeOrganization();
    organizationId = org.id;
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: toolRoutes } = await import("./tool");
    await app.register(toolRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("GET /api/tools/observers returns observer users and their client families", async ({
    makeUser,
    makeTool,
  }) => {
    const otherUser = await makeUser();
    const bashTool = await makeTool({ name: "run_shell" });
    const readTool = await makeTool({ name: "read_file_local" });

    await ToolObservationModel.recordObservations({
      toolNames: [bashTool.name, readTool.name],
      userId: user.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });
    await ToolObservationModel.recordObservations({
      toolNames: [bashTool.name],
      userId: otherUser.id,
      externalAgentId: CODEX_CLIENT_ID,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tools/observers",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.users.map((u: { id: string }) => u.id).sort()).toEqual(
      [user.id, otherUser.id].sort(),
    );
    expect([...body.clients].sort()).toEqual(["claude", "codex"]);
  });

  test("with-assignments narrows to one user's tools from one client", async ({
    makeUser,
    makeTool,
  }) => {
    const otherUser = await makeUser();
    const claudeTool = await makeTool({ name: "claude_only_tool" });
    const codexTool = await makeTool({ name: "codex_only_tool" });
    const otherUsersTool = await makeTool({ name: "other_users_tool" });

    await ToolObservationModel.recordObservations({
      toolNames: [claudeTool.name],
      userId: user.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });
    await ToolObservationModel.recordObservations({
      toolNames: [codexTool.name],
      userId: user.id,
      externalAgentId: CODEX_CLIENT_ID,
    });
    await ToolObservationModel.recordObservations({
      toolNames: [otherUsersTool.name],
      userId: otherUser.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });

    // User filter alone: both of the caller's tools, not the other user's.
    const byUser = await app.inject({
      method: "GET",
      url: `/api/tools/with-assignments?observedByUserId=${user.id}`,
    });
    expect(byUser.statusCode).toBe(200);
    expect(
      byUser
        .json()
        .data.map((t: { name: string }) => t.name)
        .sort(),
    ).toEqual(["claude_only_tool", "codex_only_tool"]);

    // User + client: only the tool observed through that client family.
    const byUserAndClient = await app.inject({
      method: "GET",
      url: `/api/tools/with-assignments?observedByUserId=${user.id}&observedByClient=claude`,
    });
    expect(byUserAndClient.statusCode).toBe(200);
    expect(
      byUserAndClient.json().data.map((t: { name: string }) => t.name),
    ).toEqual(["claude_only_tool"]);

    // Client filter alone spans users.
    const byClient = await app.inject({
      method: "GET",
      url: "/api/tools/with-assignments?observedByClient=claude",
    });
    expect(byClient.statusCode).toBe(200);
    expect(
      byClient
        .json()
        .data.map((t: { name: string }) => t.name)
        .sort(),
    ).toEqual(["claude_only_tool", "other_users_tool"]);
  });

  test("recording the same observation twice keeps one row and unknown tool names are ignored", async ({
    makeTool,
  }) => {
    const tool = await makeTool({ name: "repeat_tool" });

    await ToolObservationModel.recordObservations({
      toolNames: [tool.name, "never_persisted_tool"],
      userId: user.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });
    await ToolObservationModel.recordObservations({
      toolNames: [tool.name],
      userId: user.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/tools/with-assignments?observedByUserId=${user.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((t: { name: string }) => t.name)).toEqual([
      "repeat_tool",
    ]);
  });
});
