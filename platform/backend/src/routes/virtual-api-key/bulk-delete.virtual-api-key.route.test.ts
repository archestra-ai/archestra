import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { userHasPermission } from "@/auth";

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("DELETE /api/llm-virtual-keys/bulk", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    mockUserHasPermission.mockReset();
    mockUserHasPermission.mockResolvedValue(false);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);

    const { default: virtualApiKeysRoutes } = await import(
      "./virtual-api-key.routes"
    );
    await app.register(virtualApiKeysRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const bulkDelete = (ids: unknown) =>
    app.inject({
      method: "DELETE",
      url: "/api/llm-virtual-keys/bulk",
      payload: { ids },
    });

  /**
   * Passthrough keys carry no provider mappings, so the fixture stays minimal;
   * the delete path is the same for both key types.
   */
  const makePersonalKey = async (name: string, authorId: string) =>
    (
      await VirtualApiKeyModel.create({
        organizationId,
        name,
        keyType: "passthrough",
        scope: "personal",
        authorId,
      })
    ).virtualKey;

  test("deletes every named key the caller owns", async () => {
    const first = await makePersonalKey("First Key", user.id);
    const second = await makePersonalKey("Second Key", user.id);

    const response = await bulkDelete([first.id, second.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "First Key" },
        { id: second.id, name: "Second Key" },
      ],
      failed: [],
    });
    expect(await VirtualApiKeyModel.findById(first.id)).toBeNull();
    expect(await VirtualApiKeyModel.findById(second.id)).toBeNull();
  });

  /**
   * Each id is authorized exactly as the single delete authorizes its own:
   * another user's personal key is visible in the same organization but not
   * manageable, and an unknown id is reported as not found — in both cases
   * the rest of the batch still applies.
   */
  test("reports unauthorized and unknown keys without abandoning the rest", async ({
    makeUser,
  }) => {
    const outsider = await makeUser();
    const mine = await makePersonalKey("Mine", user.id);
    const theirs = await makePersonalKey("Theirs", outsider.id);
    const unknownId = crypto.randomUUID();

    const response = await bulkDelete([mine.id, theirs.id, unknownId]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [{ id: mine.id, name: "Mine" }],
      failed: [
        {
          id: theirs.id,
          name: "Theirs",
          error: "You can only manage your own personal virtual keys",
        },
        {
          id: unknownId,
          name: null,
          error: "Virtual API key not found",
        },
      ],
    });
    expect(await VirtualApiKeyModel.findById(mine.id)).toBeNull();
    expect(await VirtualApiKeyModel.findById(theirs.id)).not.toBeNull();
  });

  test("rejects an empty batch", async () => {
    expect((await bulkDelete([])).statusCode).toBe(400);
  });

  test("writes one audit record covering the batch", async () => {
    const key = await makePersonalKey("Audited Key", user.id);

    expect((await bulkDelete([key.id])).statusCode).toBe(200);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "virtualApiKey.bulk_deleted"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].resourceType).toBe("virtualApiKey");
    expect(rows[0].before).toMatchObject({
      virtualApiKeys: [{ id: key.id, name: "Audited Key" }],
    });
    expect(rows[0].after).toMatchObject({ virtualApiKeys: [] });
  });
});
