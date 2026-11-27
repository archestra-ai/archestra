import { randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME, RouteId } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { eq } from "drizzle-orm";
import { hasPermission } from "@/auth";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import OpenAppaYellModel from "@/models/openappa-yell";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import routes from "./openappa-external-consults.routes";

type Row = {
  type: "consult" | "yell";
  consult?: { id: string };
  yell?: { id: string };
};
const ids = (body: { data: Row[] }) =>
  body.data.map((row) => `${row.type}:${(row.consult ?? row.yell)?.id}`);

describe("GET /api/openappa/guardrail-events", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let caller: User;
  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: caller, organizationId });
    });
    app.addHook("preHandler", async (request) => {
      const required =
        requiredEndpointPermissionsMap[RouteId.GetOpenappaGuardrailEvents];
      if (!required) throw new ApiError(403, "route not in permissions map");
      const { success } = await hasPermission(
        required,
        request.headers,
        undefined,
        { userId: caller.id, organizationId },
      );
      if (!success) throw new ApiError(403, "Forbidden");
    });
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
  });

  const list = async (query = "") =>
    (
      await app.inject({
        method: "GET",
        url: `/api/openappa/guardrail-events${query}`,
      })
    ).json();

  test("consults and yells come back in one timeline, newest first, and a cursor walks both without a gap or a repeat", async ({
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: ADMIN_ROLE_NAME });
    // Newest to oldest: yell, consult, consult, yell, consult.
    const y1 = await seedYell({ organizationId, secondsAgo: 10 });
    const c1 = await seedConsult({ organizationId, secondsAgo: 20 });
    const c2 = await seedConsult({ organizationId, secondsAgo: 30 });
    const y2 = await seedYell({ organizationId, secondsAgo: 40 });
    const c3 = await seedConsult({ organizationId, secondsAgo: 50 });
    const order = [
      `yell:${y1}`,
      `consult:${c1}`,
      `consult:${c2}`,
      `yell:${y2}`,
      `consult:${c3}`,
    ];

    const whole = await list();
    expect(ids(whole)).toEqual(order);
    expect(whole.pagination).toEqual({
      limit: 20,
      hasNext: false,
      nextCursor: null,
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const body = await list(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...ids(body));
      cursor = body.pagination.nextCursor;
      if (!body.pagination.hasNext) break;
    }
    expect(seen).toEqual(order);
    expect(cursor).toBeNull();
  });

  test("the type, a consult's outcome and a yell's state each narrow the timeline to the kind they describe", async ({
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: ADMIN_ROLE_NAME });
    const open = await seedYell({ organizationId, secondsAgo: 10 });
    const answered = await seedConsult({ organizationId, secondsAgo: 20 });
    const timedOut = await seedConsult({
      organizationId,
      secondsAgo: 30,
      outcome: "timeout",
      externalName: "labeler",
    });
    const resolved = await seedYell({
      organizationId,
      secondsAgo: 40,
      message: "The labeler blocked a harmless read",
      resolved: true,
    });

    expect(ids(await list("?type=yell"))).toEqual([
      `yell:${open}`,
      `yell:${resolved}`,
    ]);
    expect(ids(await list("?type=consult"))).toEqual([
      `consult:${answered}`,
      `consult:${timedOut}`,
    ]);
    // A yell has no outcome, and a consult is neither resolved nor open.
    expect(ids(await list("?outcome=timeout"))).toEqual([
      `consult:${timedOut}`,
    ]);
    expect(ids(await list("?yellStatus=unresolved"))).toEqual([`yell:${open}`]);
    expect(ids(await list("?yellStatus=resolved"))).toEqual([
      `yell:${resolved}`,
    ]);
    // One search reads a consult's service and a yell's report.
    expect(ids(await list("?search=labeler"))).toEqual([
      `consult:${timedOut}`,
      `yell:${resolved}`,
    ]);
    // The time range bounds both kinds.
    const from = new Date(Date.now() - 35_000).toISOString();
    const to = new Date(Date.now() - 15_000).toISOString();
    expect(
      ids(
        await list(
          `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        ),
      ),
    ).toEqual([`consult:${answered}`, `consult:${timedOut}`]);
  });

  test("without guardrailsLog:admin a reader sees only the records of their own sessions", async ({
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: EDITOR_ROLE_NAME });
    const mine = `user:${caller.id}`;
    const myYell = await seedYell({
      organizationId,
      secondsAgo: 10,
      callerId: mine,
    });
    const myConsult = await seedConsult({
      organizationId,
      secondsAgo: 20,
      callerId: mine,
    });
    await seedYell({ organizationId, secondsAgo: 30 });
    await seedConsult({ organizationId, secondsAgo: 40 });

    expect(ids(await list())).toEqual([
      `yell:${myYell}`,
      `consult:${myConsult}`,
    ]);
  });

  test("guardrailsLog alone opens both kinds, and log no longer opens consults", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const yell = await seedYell({ organizationId, secondsAgo: 10 });
    const consult = await seedConsult({ organizationId, secondsAgo: 20 });
    const as = async (permission: Record<string, string[]>) => {
      const role = await makeCustomRole(organizationId, {
        permission,
      });
      caller = await makeUser();
      await makeMember(caller.id, organizationId, { role: role.role });
    };
    const status = async () =>
      (
        await app.inject({
          method: "GET",
          url: "/api/openappa/guardrail-events",
        })
      ).statusCode;

    await as({ guardrailsLog: ["read", "admin"] });
    expect(ids(await list())).toEqual([`yell:${yell}`, `consult:${consult}`]);

    await as({ log: ["read", "admin"] });
    expect(await status()).toBe(403);

    await as({ guardrailsPolicy: ["read"] });
    expect(await status()).toBe(403);
  });
});

async function seedConsult(params: {
  organizationId: string;
  secondsAgo: number;
  externalName?: string;
  outcome?: "answered" | "timeout";
  callerId?: string;
}): Promise<string> {
  const id = randomUUID();
  const createdAt = new Date(Date.now() - params.secondsAgo * 1000);
  await db.insert(schema.openappaExternalConsultsTable).values({
    id,
    organizationId: params.organizationId,
    sessionId: "session",
    callerId: params.callerId ?? "user:someone-else",
    createdAt,
    startedAt: createdAt,
    durationMs: 12,
    role: "annotator",
    externalName: params.externalName ?? "scan",
    backend: "url",
    request: { version: 1 },
    outcome: params.outcome ?? "answered",
    answer: params.outcome === "timeout" ? null : { verdict: "ok" },
    rawResponse: null,
    httpStatus: 200,
    diagnostics: null,
    root: "root",
    trajectory: "trajectory",
    callId: randomUUID(),
  });
  return id;
}

async function seedYell(params: {
  organizationId: string;
  secondsAgo: number;
  message?: string;
  callerId?: string;
  resolved?: boolean;
}): Promise<string> {
  const callerId = params.callerId ?? "user:someone-else";
  const yell = await OpenAppaYellModel.record({
    organizationId: params.organizationId,
    callerId,
    sessionId: `${callerId}|run-${randomUUID()}`,
    toolCallId: `toolu_${randomUUID()}`,
    message: params.message ?? "Blocked and could not tell why",
    withTrajectory: false,
  });
  const createdAt = new Date(Date.now() - params.secondsAgo * 1000);
  await db
    .update(schema.openappaYellsTable)
    .set({
      createdAt,
      ...(params.resolved ? { resolvedAt: createdAt } : {}),
    })
    .where(eq(schema.openappaYellsTable.id, yell.id));
  return yell.id;
}
