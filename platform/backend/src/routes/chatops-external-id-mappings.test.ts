import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/chatops/external-id-mappings", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    user = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import(
      "./chatops-external-id-mappings"
    );
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns mappings filtered by userId", async ({
    makeExternalIdMapping,
  }) => {
    const mapping = await makeExternalIdMapping({
      userId: user.id,
      adapterId: "whatsapp",
      externalId: "ext-list-1",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/chatops/external-id-mappings?userId=${user.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(mapping.id);
    expect(body.data[0].adapterId).toBe("whatsapp");
    expect(body.data[0].externalId).toBe("ext-list-1");
  });

  test("returns empty list when no mappings", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/chatops/external-id-mappings?userId=${user.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  test("returns 400 when userId is missing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/chatops/external-id-mappings",
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /api/chatops/external-id-mappings", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    user = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import(
      "./chatops-external-id-mappings"
    );
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates a mapping", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/external-id-mappings",
      payload: {
        userId: user.id,
        adapterId: "whatsapp",
        externalId: "ext-create-1",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.adapterId).toBe("whatsapp");
    expect(body.externalId).toBe("ext-create-1");
    expect(body.userId).toBe(user.id);
    expect(body.id).toBeDefined();
  });

  test("upserts on duplicate adapterId + externalId", async ({
    makeUser,
    makeMember,
  }) => {
    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId);

    await app.inject({
      method: "POST",
      url: "/api/chatops/external-id-mappings",
      payload: {
        userId: user.id,
        adapterId: "whatsapp",
        externalId: "ext-dup",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/external-id-mappings",
      payload: {
        userId: otherUser.id,
        adapterId: "whatsapp",
        externalId: "ext-dup",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().userId).toBe(otherUser.id);
  });

  test("returns 404 when user is not a member", async ({ makeUser }) => {
    const nonMember = await makeUser();

    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/external-id-mappings",
      payload: {
        userId: nonMember.id,
        adapterId: "whatsapp",
        externalId: "ext-no-member",
      },
    });

    expect(response.statusCode).toBe(404);
  });

  test("returns 400 for invalid adapterId", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/external-id-mappings",
      payload: {
        userId: user.id,
        adapterId: "invalid-adapter",
        externalId: "ext-bad-adapter",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("returns 400 for missing fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/external-id-mappings",
      payload: {
        adapterId: "whatsapp",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("returns 400 for empty externalId", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/external-id-mappings",
      payload: {
        userId: user.id,
        adapterId: "whatsapp",
        externalId: "",
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("DELETE /api/chatops/external-id-mappings/:id", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    user = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import(
      "./chatops-external-id-mappings"
    );
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("deletes a mapping", async ({ makeExternalIdMapping }) => {
    const mapping = await makeExternalIdMapping({ userId: user.id });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/chatops/external-id-mappings/${mapping.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
  });

  test("returns 404 for non-existent mapping", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/chatops/external-id-mappings/00000000-0000-0000-0000-000000000000",
    });

    expect(response.statusCode).toBe(404);
  });

  test("returns 400 for invalid UUID", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/chatops/external-id-mappings/not-a-uuid",
    });

    expect(response.statusCode).toBe(400);
  });
});
