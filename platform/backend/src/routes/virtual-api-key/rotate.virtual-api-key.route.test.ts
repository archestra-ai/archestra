import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import SecretModel from "@/models/secret";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const HOUR_SECONDS = 60 * 60;

describe("POST /api/llm-virtual-keys/:id/rotate", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });

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
    vi.useRealTimers();
    await app.close();
  });

  const rotate = (id: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `/api/llm-virtual-keys/${id}/rotate`,
      payload,
    });

  const makeOwnKey = async () =>
    VirtualApiKeyModel.create({
      organizationId,
      name: "Rotating key",
      keyType: "passthrough",
      scope: "personal",
      authorId: user.id,
    });

  test("replaces the value and keeps the key's identity and settings", async () => {
    const { virtualKey, value: oldValue } = await makeOwnKey();

    const response = await rotate(virtualKey.id);

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: virtualKey.id,
      name: "Rotating key",
      keyType: "passthrough",
      authorId: user.id,
      rotationCount: 1,
      previousTokenExpiresAt: null,
    });
    expect(body.value).toEqual(expect.any(String));
    expect(body.value).not.toBe(oldValue);
    expect(body.value.startsWith(body.tokenStart)).toBe(true);
    expect(body.lastRotatedAt).not.toBeNull();

    // Without a grace period the old value stops working at once, and its
    // secret is gone.
    expect(await VirtualApiKeyModel.validateToken(oldValue)).toBeNull();
    expect(await SecretModel.findById(virtualKey.secretId)).toBeNull();
    expect(
      (await VirtualApiKeyModel.validateToken(body.value))?.virtualKey.id,
    ).toBe(virtualKey.id);
    // The value endpoint hands out the new value afterwards.
    const read = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys/${virtualKey.id}/value`,
    });
    expect(read.json()).toEqual({ value: body.value });
  });

  test("keeps the old value working until the grace period ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    const { virtualKey, value: oldValue } = await makeOwnKey();

    const response = await rotate(virtualKey.id, {
      gracePeriodSeconds: 24 * HOUR_SECONDS,
    });
    expect(response.statusCode, response.body).toBe(200);
    const { value: newValue } = response.json();

    // Both the plain lookup and the passthrough owner lookup accept both
    // values during the grace period.
    for (const value of [oldValue, newValue]) {
      expect(
        (await VirtualApiKeyModel.validateToken(value))?.virtualKey.id,
      ).toBe(virtualKey.id);
      expect(
        (await VirtualApiKeyModel.validateTokenWithOwner(value))?.virtualKey.id,
      ).toBe(virtualKey.id);
    }

    vi.setSystemTime(Date.now() + 23 * HOUR_SECONDS * 1000);
    expect(await VirtualApiKeyModel.validateToken(oldValue)).not.toBeNull();

    vi.setSystemTime(Date.now() + 2 * HOUR_SECONDS * 1000);
    expect(await VirtualApiKeyModel.validateToken(oldValue)).toBeNull();
    expect(
      await VirtualApiKeyModel.validateTokenWithOwner(oldValue),
    ).toBeNull();
    expect(
      (await VirtualApiKeyModel.validateToken(newValue))?.virtualKey.id,
    ).toBe(virtualKey.id);
  });

  test("rotating again ends the earlier grace period at once", async () => {
    const { virtualKey, value: firstValue } = await makeOwnKey();

    const first = await rotate(virtualKey.id, {
      gracePeriodSeconds: HOUR_SECONDS,
    });
    const secondValue = first.json().value;
    const second = await rotate(virtualKey.id, {
      gracePeriodSeconds: HOUR_SECONDS,
    });
    expect(second.statusCode, second.body).toBe(200);

    expect(await VirtualApiKeyModel.validateToken(firstValue)).toBeNull();
    expect(await VirtualApiKeyModel.validateToken(secondValue)).not.toBeNull();
    expect(
      await VirtualApiKeyModel.validateToken(second.json().value),
    ).not.toBeNull();
    expect(second.json().rotationCount).toBe(2);
  });

  test("withholds the new value from a manager who did not create the key", async ({
    makeUser,
    makeMember,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, organizationId);
    const { virtualKey } = await VirtualApiKeyModel.create({
      organizationId,
      name: "Owner's key",
      keyType: "passthrough",
      scope: "personal",
      authorId: owner.id,
    });

    const response = await rotate(virtualKey.id);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().value).toBeUndefined();
    expect(response.json().tokenStart).not.toBe(virtualKey.tokenStart);
  });

  test("refuses a member who cannot edit the key", async ({
    makeUser,
    makeMember,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, organizationId);
    const { virtualKey } = await VirtualApiKeyModel.create({
      organizationId,
      name: "Owner's key",
      keyType: "passthrough",
      scope: "personal",
      authorId: owner.id,
    });
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "member" });

    const response = await rotate(virtualKey.id);

    expect([403, 404]).toContain(response.statusCode);
    expect((await VirtualApiKeyModel.findById(virtualKey.id))?.tokenStart).toBe(
      virtualKey.tokenStart,
    );
  });

  test("rejects a grace period longer than 30 days", async () => {
    const { virtualKey } = await makeOwnKey();
    const response = await rotate(virtualKey.id, {
      gracePeriodSeconds: 31 * 24 * HOUR_SECONDS,
    });
    expect(response.statusCode).toBe(400);
  });

  test("records the rotation in the audit log without the value", async () => {
    const { virtualKey, value: oldValue } = await makeOwnKey();

    const response = await rotate(virtualKey.id, {
      gracePeriodSeconds: HOUR_SECONDS,
    });
    expect(response.statusCode).toBe(200);
    const newValue = response.json().value;

    let rows: Array<{ before: unknown; after: unknown }> = [];
    await vi.waitFor(async () => {
      rows = await db
        .select({
          before: schema.auditLogsTable.before,
          after: schema.auditLogsTable.after,
        })
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.action, "virtualApiKey.rotated"),
            eq(schema.auditLogsTable.resourceId, virtualKey.id),
          ),
        );
      expect(rows).toHaveLength(1);
    });
    expect(rows[0].before).toMatchObject({
      tokenStart: virtualKey.tokenStart,
      rotationCount: 0,
    });
    expect(rows[0].after).toMatchObject({
      tokenStart: response.json().tokenStart,
      previousTokenStart: virtualKey.tokenStart,
      rotationCount: 1,
    });
    const snapshot = JSON.stringify(rows[0]);
    expect(snapshot).not.toContain(oldValue);
    expect(snapshot).not.toContain(newValue);
  });
});
