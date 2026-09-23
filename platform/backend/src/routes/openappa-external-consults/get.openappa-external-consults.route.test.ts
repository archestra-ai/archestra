import { randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import db, { schema } from "@/database";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
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

  test("a caller without log:admin is refused", async ({
    makeUser,
    makeMember,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: EDITOR_ROLE_NAME });
    await seedConsult({ organizationId });

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
}): Promise<string> {
  const id = randomUUID();
  const createdAt = new Date(Date.now() - (params.secondsAgo ?? 0) * 1000);
  await db.insert(schema.openappaExternalConsultsTable).values({
    id,
    organizationId: params.organizationId,
    sessionId: "session",
    callerId: "user:caller",
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
