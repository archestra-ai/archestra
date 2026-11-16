import {
  BUILT_IN_AGENT_IDS,
  getArchestraToolFullName,
  type Permissions,
} from "@archestra/shared";
import config from "@/config";
import db, { schema } from "@/database";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

const toolName = getArchestraToolFullName("list_openappa_operations");
const originalEnabled = config.openappa.enabled;
const DAY_MS = 24 * 60 * 60 * 1000;

describe("list_openappa_operations", () => {
  let organizationId: string;
  let callerWith: (permission: Permissions) => Promise<ArchestraContext>;

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
        builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.APPA_TUNER },
      });
      await seedAndAssignArchestraTools(agent.id);
      callerWith = async (permission) => {
        const user = await makeUser();
        const role = await makeCustomRole(organizationId, { permission });
        await makeMember(user.id, organizationId, { role: role.role });
        return {
          agent: { id: agent.id, name: agent.name },
          agentId: agent.id,
          organizationId,
          userId: user.id,
        };
      };
    },
  );
  afterEach(() => {
    config.openappa.enabled = originalEnabled;
  });

  test("lists the caller's decided operations newest first, without arguments or sealed receipts", async ({
    makeOrganization,
  }) => {
    const context = await callerWith({ log: ["read"] });
    const callerId = `user:${context.userId}`;
    const now = Date.now();
    await seedOperation({
      organizationId,
      callerId,
      operationId: "older",
      createdAt: new Date(now - 2000),
      input: {
        semantic: { event: "tool_call", tool: "github__create_issue" },
        arguments: { title: "secret title" },
      },
      decision: { decision: "deny_call", offers: [] },
    });
    await seedOperation({
      organizationId,
      callerId,
      operationId: "newer",
      createdAt: new Date(now - 1000),
      input: { context: { tool: "slack__post" }, event: "tool_call" },
      decision: { decision: "allow_call" },
    });
    await seedOperation({
      organizationId,
      callerId,
      operationId: "sealed",
      input: { __appa_encrypted: "AQID" },
      decision: { __appa_encrypted: "BAUG" },
    });
    await seedOperation({
      organizationId,
      callerId,
      operationId: "pending",
      status: "pending",
      decision: null,
    });
    await seedOperation({
      organizationId,
      callerId: "user:someone-else",
      operationId: "theirs",
    });
    await seedOperation({
      organizationId: (await makeOrganization()).id,
      callerId,
      operationId: "other-org",
    });

    const body = await list(context);

    expect(body.ownSessionsOnly).toBe(true);
    expect(body.hasMore).toBe(false);
    expect(body.operations).toEqual([
      {
        sessionId: "session",
        operationId: "newer",
        event: "tool_call",
        tool: "slack__post",
        decision: "allow_call",
        createdAt: new Date(now - 1000).toISOString(),
      },
      {
        sessionId: "session",
        operationId: "older",
        event: "tool_call",
        tool: "github__create_issue",
        decision: "deny_call",
        createdAt: new Date(now - 2000).toISOString(),
      },
    ]);
  });

  test("another caller's operations are listed only with log:admin", async () => {
    await seedOperation({
      organizationId,
      callerId: "user:someone-else",
      operationId: "theirs",
    });
    const reader = await callerWith({ log: ["read"] });
    const admin = await callerWith({ log: ["read", "admin"] });

    expect(await list(reader)).toMatchObject({
      operations: [],
      ownSessionsOnly: true,
    });
    const granted = await list(admin);
    expect(granted.ownSessionsOnly).toBe(false);
    expect(granted.operations.map((row) => row.operationId)).toEqual([
      "theirs",
    ]);
  });

  test("narrows by tool, decision and since, defaulting to the last 14 days", async () => {
    const context = await callerWith({ log: ["read", "admin"] });
    const now = Date.now();
    await seedOperation({
      organizationId,
      operationId: "denied-github",
      input: { semantic: { event: "tool_call", tool: "github__push" } },
      decision: { decision: "deny_call" },
    });
    await seedOperation({
      organizationId,
      operationId: "allowed-github",
      input: { tool: "github__push", event: "tool_call" },
      decision: { decision: "allow_call" },
    });
    await seedOperation({
      organizationId,
      operationId: "denied-slack",
      input: { semantic: { event: "tool_call", tool: "slack__post" } },
      decision: { decision: "deny_call" },
    });
    await seedOperation({
      organizationId,
      operationId: "stale",
      createdAt: new Date(now - 20 * DAY_MS),
    });

    const ids = async (args: Record<string, unknown>) =>
      (await list(context, args)).operations
        .map((row) => row.operationId)
        .sort();

    expect(await ids({ tool: "github__push" })).toEqual([
      "allowed-github",
      "denied-github",
    ]);
    expect(await ids({ decision: "deny_call" })).toEqual([
      "denied-github",
      "denied-slack",
    ]);
    expect(await ids({ tool: "github__push", decision: "deny_call" })).toEqual([
      "denied-github",
    ]);
    expect(await ids({})).not.toContain("stale");
    expect(
      await ids({ since: new Date(now - 30 * DAY_MS).toISOString() }),
    ).toContain("stale");
  });

  test("pages through rows sharing a timestamp without repeating or skipping one", async () => {
    const context = await callerWith({ log: ["read", "admin"] });
    const createdAt = new Date();
    for (const operationId of ["a", "b", "c"])
      await seedOperation({ organizationId, operationId, createdAt });

    const first = await list(context, { limit: 2 });
    expect(first.hasMore).toBe(true);
    const second = await list(context, { limit: 2, cursor: first.nextCursor });

    expect(second.hasMore).toBe(false);
    expect(
      [...first.operations, ...second.operations].map((row) => row.operationId),
    ).toEqual(["c", "b", "a"]);
  });
});

type OperationRow = {
  sessionId: string;
  operationId: string;
  event: string | null;
  tool: string | null;
  decision: string | null;
  createdAt: string;
};

async function list(
  context: ArchestraContext,
  args: Record<string, unknown> = {},
): Promise<{
  ownSessionsOnly: boolean;
  operations: OperationRow[];
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const outcome = await executeArchestraTool(toolName, args, context);
  expect(outcome.isError ?? false).toBe(false);
  const [first] = outcome.content;
  if (first?.type !== "text") throw new Error("expected a text result");
  return JSON.parse(first.text);
}

async function seedOperation(params: {
  organizationId: string;
  operationId: string;
  callerId?: string;
  createdAt?: Date;
  status?: "pending" | "complete";
  input?: Record<string, unknown>;
  decision?: Record<string, unknown> | null;
}): Promise<void> {
  await db.insert(schema.openappaOperationsTable).values({
    organizationId: params.organizationId,
    callerId: params.callerId ?? "user:someone",
    sessionId: "session",
    operationId: params.operationId,
    root: "root",
    status: params.status ?? "complete",
    input: params.input ?? {
      semantic: { event: "tool_call", tool: "github__push" },
    },
    decision:
      params.decision === undefined
        ? { decision: "allow_call" }
        : params.decision,
    createdAt: params.createdAt ?? new Date(),
  });
}
