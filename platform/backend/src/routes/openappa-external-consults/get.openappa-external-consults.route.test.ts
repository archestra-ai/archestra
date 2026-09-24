import { randomUUID } from "node:crypto";
import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
  RouteId,
} from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { hasPermission } from "@/auth";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import routes from "./openappa-external-consults.routes";

describe("GET /api/openappa/external-consults", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let caller: User;
  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: caller, organizationId });
    });
    // The auth middleware's authorization step, minus session resolution:
    // the route's declared permissions against the caller's real role.
    app.addHook("preHandler", async (request) => {
      const required =
        requiredEndpointPermissionsMap[RouteId.GetOpenappaExternalConsults];
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

  const list = (query = "") =>
    app.inject({
      method: "GET",
      url: `/api/openappa/external-consults${query}`,
    });

  test("an admin sees only the active organization's consults, bytes as base64", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: ADMIN_ROLE_NAME });
    const own = await seedConsult({
      organizationId,
      rawResponse: Buffer.from('{"version":1}'),
      diagnostics: Buffer.from("quota exhausted"),
    });
    await seedConsult({ organizationId: (await makeOrganization()).id });

    const response = await list();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: own,
      organizationId,
      rawResponse: Buffer.from('{"version":1}').toString("base64"),
      diagnostics: Buffer.from("quota exhausted").toString("base64"),
    });
    expect(body.pagination).toEqual({
      limit: 20,
      hasNext: false,
      nextCursor: null,
    });
  });

  test("filters narrow the page and a cursor continues it", async ({
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: ADMIN_ROLE_NAME });
    const oldest = await seedConsult({ organizationId, secondsAgo: 30 });
    const middle = await seedConsult({ organizationId, secondsAgo: 20 });
    await seedConsult({
      organizationId,
      secondsAgo: 10,
      externalName: "other",
      outcome: "timeout",
    });

    const first = (await list("?externalName=scan&limit=1")).json();
    expect(first.data.map((row: { id: string }) => row.id)).toEqual([middle]);
    const second = (
      await list(
        `?externalName=scan&limit=1&cursor=${first.pagination.nextCursor}`,
      )
    ).json();
    expect(second.data.map((row: { id: string }) => row.id)).toEqual([oldest]);
    expect(second.pagination.hasNext).toBe(false);
    expect((await list("?outcome=timeout")).json().data).toHaveLength(1);
  });

  test("a log:read caller sees only their own consults, in json and jsonl", async ({
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: EDITOR_ROLE_NAME });
    const colleague = await makeUser();
    await makeMember(colleague.id, organizationId, { role: EDITOR_ROLE_NAME });
    const mine = await seedConsult({
      organizationId,
      callerId: `user:${caller.id}`,
    });
    await seedConsult({ organizationId, callerId: `user:${colleague.id}` });

    const json = await list();
    expect(json.statusCode).toBe(200);
    expect(json.json().data.map((row: { id: string }) => row.id)).toEqual([
      mine,
    ]);

    const jsonl = await list("?format=jsonl");
    expect(jsonl.statusCode).toBe(200);
    expect(
      jsonl.body
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).id),
    ).toEqual([mine]);
  });

  test("a caller without log:read is refused", async ({
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: MEMBER_ROLE_NAME });
    await seedConsult({ organizationId, callerId: `user:${caller.id}` });

    expect((await list()).statusCode).toBe(403);
    expect((await list("?format=jsonl")).statusCode).toBe(403);
  });

  test("jsonl streams one JSON object per line as ndjson", async ({
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: ADMIN_ROLE_NAME });
    const older = await seedConsult({ organizationId, secondsAgo: 20 });
    const newer = await seedConsult({ organizationId, secondsAgo: 10 });

    const response = await list("?format=jsonl");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/x-ndjson/);
    const lines = response.body.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1).map((line) => JSON.parse(line).id)).toEqual([
      newer,
      older,
    ]);
  });
});

async function seedConsult(params: {
  organizationId: string;
  secondsAgo?: number;
  externalName?: string;
  outcome?: "answered" | "timeout";
  rawResponse?: Buffer;
  diagnostics?: Buffer;
  callerId?: string;
}): Promise<string> {
  const id = randomUUID();
  const createdAt = new Date(Date.now() - (params.secondsAgo ?? 0) * 1000);
  await db.insert(schema.openappaExternalConsultsTable).values({
    id,
    organizationId: params.organizationId,
    sessionId: "session",
    callerId: params.callerId ?? "user:caller",
    createdAt,
    startedAt: createdAt,
    durationMs: 12,
    role: "annotator",
    externalName: params.externalName ?? "scan",
    backend: "url",
    request: { version: 1 },
    outcome: params.outcome ?? "answered",
    answer: params.outcome === "timeout" ? null : { verdict: "ok" },
    rawResponse: params.rawResponse ?? null,
    httpStatus: 200,
    diagnostics: params.diagnostics ?? null,
    root: "root",
    trajectory: "root",
  });
  return id;
}
