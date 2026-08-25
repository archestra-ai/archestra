import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { LlmOauthClientModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("DELETE /api/llm-oauth-clients/bulk", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);

    const { default: llmOauthClientsRoutes } = await import(
      "./llm-oauth-clients"
    );
    await app.register(llmOauthClientsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const bulkDelete = (ids: unknown) =>
    app.inject({
      method: "DELETE",
      url: "/api/llm-oauth-clients/bulk",
      payload: { ids },
    });

  /**
   * authorization_code clients need no LLM proxy or provider key fixtures;
   * the delete path is the same for both grant types.
   */
  const makeClient = async (name: string, authorId: string) =>
    (
      await LlmOauthClientModel.create({
        organizationId,
        name,
        grantType: "authorization_code",
        redirectUris: ["https://chat.example.com/oauth/callback"],
        scope: "personal",
        authorId,
      })
    ).oauthClient;

  const findById = (id: string) =>
    LlmOauthClientModel.findById({ id, organizationId });

  test("deletes every named client the caller owns", async () => {
    const first = await makeClient("First Client", user.id);
    const second = await makeClient("Second Client", user.id);

    const response = await bulkDelete([first.id, second.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "First Client" },
        { id: second.id, name: "Second Client" },
      ],
      failed: [],
    });
    expect(await findById(first.id)).toBeNull();
    expect(await findById(second.id)).toBeNull();
  });

  /**
   * Each id is fenced exactly as the list fences reads: another user's
   * personal client is invisible to the caller, so it reports as not found
   * (no name disclosed), and an unknown id reports the same — in both cases
   * the rest of the batch still applies.
   */
  test("reports invisible and unknown clients without abandoning the rest", async ({
    makeUser,
  }) => {
    const outsider = await makeUser();
    const mine = await makeClient("Mine", user.id);
    const theirs = await makeClient("Theirs", outsider.id);
    const unknownId = crypto.randomUUID();

    const response = await bulkDelete([mine.id, theirs.id, unknownId]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [{ id: mine.id, name: "Mine" }],
      failed: [
        {
          id: theirs.id,
          name: null,
          error: "LLM OAuth client not found",
        },
        {
          id: unknownId,
          name: null,
          error: "LLM OAuth client not found",
        },
      ],
    });
    expect(await findById(mine.id)).toBeNull();
    expect(await findById(theirs.id)).not.toBeNull();
  });

  test("rejects an empty batch", async () => {
    expect((await bulkDelete([])).statusCode).toBe(400);
  });

  test("writes one audit record covering the batch", async () => {
    const client = await makeClient("Audited Client", user.id);

    expect((await bulkDelete([client.id])).statusCode).toBe(200);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "llmOauthClient.bulk_deleted"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].resourceType).toBe("llmOauthClient");
    expect(rows[0].before).toMatchObject({
      llmOauthClients: [{ id: client.id, name: "Audited Client" }],
    });
    expect(rows[0].after).toMatchObject({ llmOauthClients: [] });
  });
});
