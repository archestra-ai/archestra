import {
  BUILT_IN_AGENT_IDS,
  getArchestraToolFullName,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import OpenAppaYellModel from "@/models/openappa-yell";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

const toolName = getArchestraToolFullName("list_openappa_yells");
const originalEnabled = config.openappa.enabled;

type ListedYell = {
  id: string;
  sessionId: string;
  toolCallId: string;
  message: string;
  resolved: boolean;
};

describe("list_openappa_yells", () => {
  let organizationId: string;
  let context: ArchestraContext;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      config.openappa.enabled = true;
      organizationId = (await makeOrganization()).id;
      const agent = await makeAgent({
        agentType: "agent",
        organizationId,
        builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
      });
      await seedAndAssignArchestraTools(agent.id);
      const user = await makeUser();
      const role = await makeCustomRole(organizationId, {
        permission: { openappaDiagnostics: ["read"] },
      });
      await makeMember(user.id, organizationId, { role: role.role });
      context = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId,
        userId: user.id,
      };
    },
  );
  afterEach(() => {
    config.openappa.enabled = originalEnabled;
  });

  test("lists every caller's yells newest first and filters by status and session", async () => {
    const oldest = await seedYell({
      sessionId: "chat-a",
      toolCallId: "call-1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      callerId: "user:someone-else",
    });
    const middle = await seedYell({
      sessionId: "chat-b",
      toolCallId: "call-2",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    const newest = await seedYell({
      sessionId: "chat-a",
      toolCallId: "call-3",
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });
    await OpenAppaYellModel.setResolved({
      id: middle,
      organizationId,
      userId: context.userId as string,
      resolved: true,
    });

    const all = await list({});
    expect(all.hasMore).toBe(false);
    expect(all.yells.map((yell) => yell.id)).toEqual([newest, middle, oldest]);
    expect(all.yells[0]).toMatchObject({
      sessionId: "chat-a",
      toolCallId: "call-3",
      resolved: false,
    });
    expect((await list({ status: "resolved" })).yells).toEqual([
      expect.objectContaining({ id: middle, resolved: true }),
    ]);
    expect(
      (await list({ status: "unresolved" })).yells.map((yell) => yell.id),
    ).toEqual([newest, oldest]);
    expect(
      (await list({ sessionId: "chat-a" })).yells.map((yell) => yell.id),
    ).toEqual([newest, oldest]);
    expect(
      (await list({ sessionId: "chat-b", status: "unresolved" })).yells,
    ).toEqual([]);
  });

  test("shortens long messages and pages at a fixed limit", async () => {
    for (let index = 0; index < 21; index++)
      await seedYell({
        sessionId: "chat",
        toolCallId: `call-${index}`,
        message: "m".repeat(1000),
      });

    const page = await list({});

    expect(page.hasMore).toBe(true);
    expect(page.yells).toHaveLength(20);
    expect(page.yells[0].message.length).toBeLessThan(1000);
    expect(page.yells[0].message.startsWith("m".repeat(300))).toBe(true);
    const rest = await list({ cursor: page.nextCursor });
    expect(rest).toMatchObject({ hasMore: false, nextCursor: null });
    expect(rest.yells).toHaveLength(1);
    expect(
      new Set([...page.yells, ...rest.yells].map((yell) => yell.id)).size,
    ).toBe(21);
  });

  test("refuses a caller without openappaDiagnostics:read", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { openappaPolicy: ["read"] },
    });
    await makeMember(user.id, organizationId, { role: role.role });
    await seedYell({ sessionId: "chat", toolCallId: "call" });

    const outcome = await executeArchestraTool(
      toolName,
      {},
      { ...context, userId: user.id },
    ).catch((error: unknown) => error);

    expect(outcome).toMatchObject({ isError: true });
  });

  async function seedYell(params: {
    sessionId: string;
    toolCallId: string;
    callerId?: string;
    message?: string;
    createdAt?: Date;
  }) {
    const row = await OpenAppaYellModel.record({
      organizationId,
      callerId: params.callerId ?? `user:${context.userId}`,
      sessionId: params.sessionId,
      toolCallId: params.toolCallId,
      message: params.message ?? `yell ${params.toolCallId}`,
      withTrajectory: false,
    });
    if (params.createdAt)
      await db
        .update(schema.openappaYellsTable)
        .set({ createdAt: params.createdAt })
        .where(eq(schema.openappaYellsTable.id, row.id));
    return row.id;
  }

  async function list(args: Record<string, unknown>) {
    const result = await executeArchestraTool(toolName, args, context);
    expect(result.isError).toBeFalsy();
    return result.structuredContent as {
      yells: ListedYell[];
      hasMore: boolean;
      nextCursor: string | null;
    };
  }
});
