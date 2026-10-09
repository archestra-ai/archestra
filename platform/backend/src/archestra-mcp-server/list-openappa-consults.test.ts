import { randomUUID } from "node:crypto";
import {
  BUILT_IN_AGENT_IDS,
  getArchestraToolFullName,
  type Permissions,
} from "@archestra/shared";
import config from "@/config";
import db, { schema } from "@/database";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

const toolName = getArchestraToolFullName("list_openappa_consults");
const originalEnabled = config.openappa.enabled;
const SESSION = "reported-session";
const HELPER_ERROR =
  "github repository annotator: GET /repos/acme/policy failed: 404";

describe("list_openappa_consults", () => {
  let organizationId: string;
  let agentContext: Pick<ArchestraContext, "agent" | "agentId">;
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
        builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
      });
      await seedAndAssignArchestraTools(agent.id);
      agentContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
      };
      callerWith = async (permission) => {
        const user = await makeUser();
        const role = await makeCustomRole(organizationId, { permission });
        await makeMember(user.id, organizationId, { role: role.role });
        return {
          ...agentContext,
          organizationId,
          userId: user.id,
        };
      };
    },
  );
  afterEach(() => {
    config.openappa.enabled = originalEnabled;
  });

  test("returns the helper's own error for the caller's session, without the request or answer", async () => {
    const context = await callerWith({ openappaDiagnostics: ["read"] });
    const callerId = `user:${context.userId}`;
    await seedConsult({
      organizationId,
      callerId,
      externalName: "github.repository-visibility",
      outcome: "non_success",
      httpStatus: 502,
      diagnostics: HELPER_ERROR,
      rawResponse: '{"error":{"message":"Battery helper failed"}}',
    });
    await seedConsult({ organizationId, callerId, sessionId: "another-chat" });
    await seedConsult({ organizationId, callerId: "user:someone-else" });

    const body = await list(context);

    expect(body.sessionId).toBe(SESSION);
    expect(body.ownSessionsOnly).toBe(true);
    expect(body.hasMore).toBe(false);
    expect(body.consults).toEqual([
      expect.objectContaining({
        role: "annotator",
        externalName: "github.repository-visibility",
        outcome: "non_success",
        httpStatus: 502,
        diagnostics: HELPER_ERROR,
        diagnosticsTruncated: false,
        rawResponse: '{"error":{"message":"Battery helper failed"}}',
        rawResponseTruncated: false,
      }),
    ]);
    expect(body.consults[0]).not.toHaveProperty("request");
    expect(body.consults[0]).not.toHaveProperty("answer");
  });

  test("narrows by outcome", async () => {
    const context = await callerWith({ openappaDiagnostics: ["read"] });
    const callerId = `user:${context.userId}`;
    await seedConsult({ organizationId, callerId, externalName: "worked" });
    await seedConsult({
      organizationId,
      callerId,
      externalName: "failed",
      outcome: "non_success",
    });

    const body = await list(context, { outcome: "non_success" });

    expect(body.consults.map((consult) => consult.externalName)).toEqual([
      "failed",
    ]);
  });

  test("another caller's session is readable only with openappaDiagnostics:admin", async () => {
    await seedConsult({
      organizationId,
      callerId: "user:someone-else",
      sessionId: "their-chat",
      diagnostics: HELPER_ERROR,
    });
    const reader = await callerWith({ openappaDiagnostics: ["read"] });
    const admin = await callerWith({
      openappaDiagnostics: ["read", "admin"],
    });

    const refused = await list(reader, { sessionId: "their-chat" });
    const granted = await list(admin, { sessionId: "their-chat" });

    expect(refused).toMatchObject({ consults: [], ownSessionsOnly: true });
    expect(granted.ownSessionsOnly).toBe(false);
    expect(granted.consults).toEqual([
      expect.objectContaining({ diagnostics: HELPER_ERROR }),
    ]);
  });

  test("an audience source's diagnostics are withheld from a caller who cannot read members", async () => {
    const withheld = await callerWith({ openappaDiagnostics: ["read"] });
    const allowed = await callerWith({
      openappaDiagnostics: ["read"],
      member: ["read"],
    });
    for (const context of [withheld, allowed])
      await seedConsult({
        organizationId,
        callerId: `user:${context.userId}`,
        role: "audience_source",
        diagnostics: "resolved alice@example.com",
        rawResponse: '{"members":["alice@example.com"]}',
      });

    expect((await list(withheld)).consults).toEqual([
      expect.objectContaining({
        role: "audience_source",
        diagnostics: null,
        rawResponse: null,
      }),
    ]);
    expect((await list(allowed)).consults).toEqual([
      expect.objectContaining({
        diagnostics: "resolved alice@example.com",
        rawResponse: '{"members":["alice@example.com"]}',
      }),
    ]);
  });

  test("long diagnostics and raw responses are cut and marked", async () => {
    const context = await callerWith({ openappaDiagnostics: ["read"] });
    await seedConsult({
      organizationId,
      callerId: `user:${context.userId}`,
      diagnostics: "d".repeat(2500),
      rawResponse: "r".repeat(2500),
    });

    const [consult] = (await list(context)).consults;

    expect(consult.diagnostics).toBe("d".repeat(2000));
    expect(consult.diagnosticsTruncated).toBe(true);
    expect(consult.rawResponse).toBe("r".repeat(2000));
    expect(consult.rawResponseTruncated).toBe(true);
  });

  test("nextCursor reads the older consults past the first page", async () => {
    const context = await callerWith({ openappaDiagnostics: ["read"] });
    const names = await seedNewestFirst(
      { organizationId, callerId: `user:${context.userId}` },
      55,
    );

    const first = await list(context);
    const second = await list(context, { cursor: first.nextCursor });

    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(
      [...first.consults, ...second.consults].map(
        (consult) => consult.externalName,
      ),
    ).toEqual(names);
  });

  test("large consults are paged under the result budget without a gap or repeat", async () => {
    const context = await callerWith({ openappaDiagnostics: ["read"] });
    const names = await seedNewestFirst(
      { organizationId, callerId: `user:${context.userId}` },
      30,
      {
        diagnostics: `"ж"\n`.repeat(1000),
        rawResponse: `"ж"\n`.repeat(1000),
      },
    );

    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const page = await list(context, cursor ? { cursor } : {});
      expect(
        Buffer.byteLength(JSON.stringify(JSON.stringify(page)), "utf8"),
      ).toBeLessThan(64 * 1024);
      seen.push(...page.consults.map((consult) => consult.externalName));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(names);
  });

  test("does not fall back to the session the call runs in", async () => {
    const context = await callerWith({ openappaDiagnostics: ["read"] });
    await seedConsult({
      organizationId,
      callerId: `user:${context.userId}`,
      sessionId: "current-chat",
      diagnostics: HELPER_ERROR,
    });

    const refusal = await failure(
      { ...context, conversationId: "current-chat" },
      {},
    );

    expect(refusal).toMatch(/sessionId/);
    expect(refusal).not.toContain(HELPER_ERROR);
  });

  test("does not exist while OpenAPPA is disabled", async () => {
    const context = await callerWith({ openappaDiagnostics: ["read"] });
    config.openappa.enabled = false;

    expect(await failure(context)).toMatch(/No tool named/);
  });

  test("refuses a caller without openappaDiagnostics:read", async () => {
    const context = await callerWith({ openappaPolicy: ["read"] });
    await seedConsult({
      organizationId,
      callerId: `user:${context.userId}`,
      diagnostics: HELPER_ERROR,
    });

    const refusal = await failure(context);

    expect(refusal).toMatch(/permission/i);
    expect(refusal).not.toContain(HELPER_ERROR);
  });
});

type ConsultSummary = {
  role: string;
  externalName: string;
  outcome: string;
  httpStatus: number | null;
  diagnostics: string | null;
  diagnosticsTruncated: boolean;
  rawResponse: string | null;
  rawResponseTruncated: boolean;
};

async function list(
  context: ArchestraContext,
  args: Record<string, unknown> = {},
): Promise<{
  sessionId: string;
  ownSessionsOnly: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  consults: ConsultSummary[];
}> {
  const outcome = await executeArchestraTool(
    toolName,
    { sessionId: SESSION, ...args },
    context,
  );
  expect(outcome.isError ?? false).toBe(false);
  const [first] = outcome.content;
  if (first?.type !== "text") throw new Error("expected a text result");
  return JSON.parse(first.text);
}

/** The refusal text, whether admission returned it or the call threw it. */
async function failure(
  context: ArchestraContext,
  args: Record<string, unknown> = { sessionId: SESSION },
): Promise<string> {
  let outcome: unknown;
  try {
    outcome = await executeArchestraTool(toolName, args, context);
  } catch (error) {
    return error instanceof Error ? error.message : JSON.stringify(error);
  }
  expect(outcome).toMatchObject({ isError: true });
  return JSON.stringify(outcome);
}

/** `count` consults a second apart, returning their names newest first. */
async function seedNewestFirst(
  owner: { organizationId: string; callerId: string },
  count: number,
  texts: { diagnostics?: string; rawResponse?: string } = {},
): Promise<string[]> {
  const newest = Date.now();
  const names = Array.from({ length: count }, (_, index) => `consult-${index}`);
  for (const [index, externalName] of names.entries())
    await seedConsult({
      ...owner,
      externalName,
      createdAt: new Date(newest - index * 1000),
      ...texts,
    });
  return names;
}

async function seedConsult(params: {
  organizationId: string;
  createdAt?: Date;
  callerId: string;
  sessionId?: string;
  externalName?: string;
  role?: "annotator" | "audience_source";
  outcome?: "answered" | "non_success";
  httpStatus?: number;
  diagnostics?: string;
  rawResponse?: string;
}): Promise<void> {
  const now = params.createdAt ?? new Date();
  await db.insert(schema.openappaExternalConsultsTable).values({
    id: randomUUID(),
    organizationId: params.organizationId,
    sessionId: params.sessionId ?? SESSION,
    callerId: params.callerId,
    createdAt: now,
    startedAt: now,
    durationMs: 12,
    role: params.role ?? "annotator",
    externalName: params.externalName ?? "scan",
    backend: "url",
    request: { version: 1, artifact: { secret: "request body" } },
    outcome: params.outcome ?? "answered",
    answer: params.outcome === "non_success" ? null : { verdict: "ok" },
    rawResponse: params.rawResponse ? Buffer.from(params.rawResponse) : null,
    httpStatus: params.httpStatus ?? 200,
    diagnostics: params.diagnostics ? Buffer.from(params.diagnostics) : null,
    root: "root",
    trajectory: "root",
  });
}
