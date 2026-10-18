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
import { McpToolCallModel } from "@/models";
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

  test("search matches part of the external's name or the session ID", async ({
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: ADMIN_ROLE_NAME });
    const byName = await seedConsult({
      organizationId,
      externalName: "PII-Annotator",
      sessionId: "sess-one",
    });
    const bySession = await seedConsult({
      organizationId,
      externalName: "egress-policy",
      sessionId: "sess-annotate-7",
    });
    await seedConsult({
      organizationId,
      externalName: "secrets-scanner",
      sessionId: "sess-two",
    });

    const ids = async (query: string) =>
      (await list(query))
        .json()
        .data.map((row: { id: string }) => row.id)
        .sort();

    expect(await ids("?search=annotat")).toEqual([byName, bySession].sort());
    expect(await ids("?search=sess-one")).toEqual([byName]);
    // The search combines with the other filters rather than replacing them.
    expect(await ids("?search=annotat&externalName=egress-policy")).toEqual([
      bySession,
    ]);
  });

  test("a openappaDiagnostics:read caller sees only their own consults, in json and jsonl", async ({
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

  test("Platform Admin cannot read another caller's consults", async ({
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: "platform_admin" });
    const mine = await seedConsult({
      organizationId,
      callerId: `user:${caller.id}`,
    });
    await seedConsult({ organizationId, callerId: "user:another-caller" });
    expect(
      (await list()).json().data.map((row: { id: string }) => row.id),
    ).toEqual([mine]);
  });

  test("a custom diagnostics admin sees organization-wide consults without log permission", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { openappaDiagnostics: ["read", "admin"] },
    });
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: role.role });
    const other = await seedConsult({
      organizationId,
      callerId: "user:another-caller",
    });
    expect(
      (await list()).json().data.map((row: { id: string }) => row.id),
    ).toEqual([other]);
    expect((await list("?format=jsonl")).body).toContain(other);
  });

  test("legacy log access alone no longer grants consult access", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { log: ["read"] },
    });
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: role.role });
    expect((await list()).statusCode).toBe(403);
  });

  test("an audience source's consult is withheld from a caller who cannot read members", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const logReader = await makeCustomRole(organizationId, {
      permission: { openappaDiagnostics: ["read"] },
    });
    const bytes = {
      rawResponse: Buffer.from('{"version":1}'),
      diagnostics: Buffer.from("helper stderr"),
    };
    const exported = async () => {
      for (const role of ["audience_source", "annotator"] as const)
        await seedConsult({
          organizationId,
          callerId: `user:${caller.id}`,
          role,
          ...bytes,
        });
      const json = (await list()).json().data;
      const jsonl = (await list("?format=jsonl")).body
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(jsonl).toEqual(json);
      return json.map(
        ({
          role,
          outcome,
          request,
          answer,
          rawResponse,
          diagnostics,
        }: Record<string, unknown>) => ({
          role,
          outcome,
          request,
          answer,
          rawResponse,
          diagnostics,
        }),
      );
    };
    const visible = {
      outcome: "answered",
      request: { version: 1 },
      answer: { verdict: "ok" },
      rawResponse: bytes.rawResponse.toString("base64"),
      diagnostics: bytes.diagnostics.toString("base64"),
    };

    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: logReader.role });
    expect(await exported()).toEqual(
      expect.arrayContaining([
        {
          role: "audience_source",
          outcome: "answered",
          request: null,
          answer: null,
          rawResponse: null,
          diagnostics: null,
        },
        { role: "annotator", ...visible },
      ]),
    );

    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: EDITOR_ROLE_NAME });
    expect(await exported()).toEqual(
      expect.arrayContaining([{ role: "audience_source", ...visible }]),
    );
  });

  test("a caller without openappaDiagnostics:read is refused", async ({
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

describe("GET /api/openappa/external-consults/:id", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let caller: User;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: ADMIN_ROLE_NAME });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: caller, organizationId });
    });
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
  });

  const get = (id: string) =>
    app.inject({ method: "GET", url: `/api/openappa/external-consults/${id}` });

  test("leads a sub-agent's consult to the session its root opened and the tool call it was raised for", async ({
    makeAgent,
    makeInteraction,
  }) => {
    const agent = await makeAgent({ organizationId });
    await makeInteraction(agent.id, { sessionId: "chat-1" });
    const call = await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "github",
      method: "tools/call",
      toolCall: null,
      toolResult: null,
      sessionId: "chat-1",
      llmToolCallId: "toolu_abc",
    });
    await db.insert(schema.openappaSessionsTable).values([
      openappaSession({
        organizationId,
        sessionId: "user:a|chat-1",
        root: "root-1",
      }),
      openappaSession({
        organizationId,
        sessionId: "user:a|chat-1/sub",
        root: "root-1",
        parentId: "user:a|chat-1",
      }),
    ]);
    const id = await seedConsult({
      organizationId,
      sessionId: "user:a|chat-1/sub",
      root: "root-1",
      callId: "call:toolu_abc",
    });

    const response = await get(id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      consult: { id },
      llmSessionId: "chat-1",
      mcpToolCallId: call.id,
    });
  });

  test("says when a consult's session or tool call was never logged", async () => {
    const id = await seedConsult({
      organizationId,
      sessionId: "user:a|elsewhere",
      callId: "toolu_none",
    });

    const response = await get(id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      consult: { id },
      llmSessionId: null,
      mcpToolCallId: null,
    });
  });

  test("another organization's consult is not found", async ({
    makeOrganization,
  }) => {
    const id = await seedConsult({
      organizationId: (await makeOrganization()).id,
    });

    expect((await get(id)).statusCode).toBe(404);
  });
});

function openappaSession(params: {
  organizationId: string;
  sessionId: string;
  root: string;
  parentId?: string;
}) {
  return {
    organizationId: params.organizationId,
    actor: params.sessionId,
    sessionId: params.sessionId,
    root: params.root,
    parentId: params.parentId ?? null,
    startDecision: {},
  };
}

async function seedConsult(params: {
  organizationId: string;
  secondsAgo?: number;
  externalName?: string;
  sessionId?: string;
  outcome?: "answered" | "timeout";
  rawResponse?: Buffer;
  diagnostics?: Buffer;
  callerId?: string;
  role?: "annotator" | "audience_source";
  root?: string;
  callId?: string;
}): Promise<string> {
  const id = randomUUID();
  const createdAt = new Date(Date.now() - (params.secondsAgo ?? 0) * 1000);
  await db.insert(schema.openappaExternalConsultsTable).values({
    id,
    organizationId: params.organizationId,
    sessionId: params.sessionId ?? "session",
    callerId: params.callerId ?? "user:caller",
    createdAt,
    startedAt: createdAt,
    durationMs: 12,
    role: params.role ?? "annotator",
    externalName: params.externalName ?? "scan",
    backend: "url",
    request: { version: 1 },
    outcome: params.outcome ?? "answered",
    answer: params.outcome === "timeout" ? null : { verdict: "ok" },
    rawResponse: params.rawResponse ?? null,
    httpStatus: 200,
    diagnostics: params.diagnostics ?? null,
    root: params.root ?? "root",
    trajectory: params.root ?? "root",
    callId: params.callId ?? null,
  });
  return id;
}
