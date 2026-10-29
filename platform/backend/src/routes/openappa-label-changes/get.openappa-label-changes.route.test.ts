import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { McpToolCallModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import routes from "./openappa-label-changes.routes";

describe("GET /api/openappa/label-changes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let caller: User;
  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: caller, organizationId });
    });
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
  });

  const list = (llmSessionId: string) =>
    app.inject({
      method: "GET",
      url: `/api/openappa/label-changes?llmSessionId=${llmSessionId}`,
    });

  test("returns a session's label history oldest first, naming the tool a result came from", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: ADMIN_ROLE_NAME });
    const agent = await makeAgent({ organizationId });
    await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "web",
      method: "tools/call",
      toolCall: { id: "t1", name: "web__fetch", arguments: {} },
      toolResult: null,
      sessionId: "chat-1",
      llmToolCallId: "toolu_1",
    });
    await db.insert(schema.openappaSessionsTable).values({
      organizationId,
      actor: "user:a|chat-1",
      sessionId: "user:a|chat-1",
      root: "root-1",
      startDecision: {},
    });
    await db.insert(schema.openappaLabelChangesTable).values([
      change({ event: "session_start", at: 0 }),
      change({
        event: "tool_result",
        at: 1000,
        callId: "call:toolu_1",
        trustAfter: "suspicious",
      }),
    ]);
    // Another session's history stays out.
    await db
      .insert(schema.openappaLabelChangesTable)
      .values(change({ event: "session_start", at: 0, root: "root-other" }));

    const response = await list("chat-1");

    expect(response.statusCode, response.body).toBe(200);
    expect(
      response
        .json()
        .data.map(
          (row: { event: string; tool: string | null; trustAfter: string }) => [
            row.event,
            row.tool,
            row.trustAfter,
          ],
        ),
    ).toEqual([
      ["session_start", null, "trusted"],
      ["tool_result", "web__fetch", "suspicious"],
    ]);
  });

  test("a member reads only the sessions they ran", async ({
    makeMember,
    makeUser,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: MEMBER_ROLE_NAME });
    await db.insert(schema.openappaSessionsTable).values({
      organizationId,
      actor: "user:a|chat-2",
      sessionId: "user:a|chat-2",
      root: "root-2",
      startDecision: {},
    });
    await db.insert(schema.openappaLabelChangesTable).values([
      change({
        event: "session_start",
        at: 0,
        root: "root-2",
        callerId: `user:${caller.id}`,
      }),
      change({
        event: "tool_call",
        at: 1,
        root: "root-2",
        callerId: "user:someone-else",
      }),
    ]);

    const response = await list("chat-2");

    expect(
      response.json().data.map((row: { event: string }) => row.event),
    ).toEqual(["session_start"]);
  });

  function change(params: {
    event: "session_start" | "tool_call" | "tool_result";
    at: number;
    root?: string;
    callId?: string;
    callerId?: string;
    trustAfter?: string;
  }) {
    return {
      organizationId,
      root: params.root ?? "root-1",
      sessionId: "user:a|chat-1",
      callerId: params.callerId ?? "user:a",
      createdAt: new Date(Date.UTC(2026, 0, 1) + params.at),
      event: params.event,
      callId: params.callId ?? null,
      trustBefore: "trusted",
      audienceBefore: "public",
      trustAfter: params.trustAfter ?? "trusted",
      audienceAfter: "public",
    };
  }
});
