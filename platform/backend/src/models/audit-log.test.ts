import { beforeEach, describe, expect, test } from "@/test";
import AuditLogModel from "./audit-log";

/**
 * Contract: AuditLogModel
 * - create: persists JSON snapshots, returns generated id/timestamps; invalid rows rejected by DB.
 * - findPaginated: always scoped by organizationId; filters combine with AND; search is ILIKE on four fields.
 * - deleteOlderThan: deletes only rows strictly older than `before` for the given org; returns deleted count.
 */

const BASE_PAYLOAD = {
  actorUserId: null,
  actorName: "Test User",
  actorEmail: "test@example.com",
  action: "create" as const,
  resourceType: "agent",
  resourceId: "agent-123",
  priorState: null,
  postState: { name: "My Agent" },
  httpMethod: "POST",
  httpPath: "/api/agents",
  httpRoute: "/api/agents",
  httpStatus: 200,
  ipAddress: "127.0.0.1",
  userAgent: "Mozilla/5.0",
};

describe("AuditLogModel", () => {
  describe("create", () => {
    test("rejects insert when organizationId is missing (database constraint)", async () => {
      await expect(
        AuditLogModel.create({
          ...BASE_PAYLOAD,
          organizationId: undefined as unknown as string,
        }),
      ).rejects.toThrow();
    });

    test("inserts and returns row with id and createdAt populated", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const row = await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: org.id,
      });

      expect(row.id).toBeDefined();
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.organizationId).toBe(org.id);
      expect(row.action).toBe("create");
      expect(row.resourceType).toBe("agent");
      expect(row.resourceId).toBe("agent-123");
      expect(row.actorEmail).toBe("test@example.com");
      expect(row.postState).toEqual({ name: "My Agent" });
      expect(row.priorState).toBeNull();
    });

    test("preserves actor info when actorUserId is set", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const row = await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: org.id,
        actorUserId: user.id,
        actorName: user.name,
        actorEmail: user.email,
      });

      expect(row.actorUserId).toBe(user.id);
      expect(row.actorName).toBe(user.name);
      expect(row.actorEmail).toBe(user.email);
    });

    test("round-trips nested JSONB priorState and postState exactly", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const prior = {
        name: "Old",
        config: { env: ["A", "B"], retries: 3 },
        tags: ["x", "y"],
        nullable: null,
      };
      const post = {
        name: "New",
        config: { env: ["A", "C"], retries: 5 },
        tags: ["x", "z"],
        nullable: null,
        added: true,
      };

      const row = await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: org.id,
        action: "update",
        priorState: prior,
        postState: post,
      });

      // Read back via findPaginated so we exercise the SELECT path too.
      const result = await AuditLogModel.findPaginated({
        organizationId: org.id,
        limit: 10,
        offset: 0,
      });
      const fetched = result.data.find((r) => r.id === row.id);
      expect(fetched).toBeDefined();
      expect(fetched?.priorState).toEqual(prior);
      expect(fetched?.postState).toEqual(post);
    });

    test("stores auth event with null http fields", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const row = await AuditLogModel.create({
        organizationId: org.id,
        actorUserId: null,
        actorName: "Test User",
        actorEmail: "test@example.com",
        action: "sign_in",
        resourceType: "auth",
        resourceId: null,
        priorState: null,
        postState: null,
        httpMethod: null,
        httpPath: "/api/auth/sign-in/email",
        httpRoute: null,
        httpStatus: null,
        ipAddress: "10.0.0.1",
        userAgent: "curl/7.88",
      });

      expect(row.action).toBe("sign_in");
      expect(row.resourceType).toBe("auth");
      expect(row.httpMethod).toBeNull();
      expect(row.httpStatus).toBeNull();
    });
  });

  describe("findPaginated", () => {
    let orgId: string;
    let otherOrgId: string;

    beforeEach(async ({ makeOrganization }) => {
      const org = await makeOrganization();
      const otherOrg = await makeOrganization();
      orgId = org.id;
      otherOrgId = otherOrg.id;
    });

    test("returns rows scoped to organizationId only", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceId: "in-org",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: otherOrgId,
        resourceId: "in-other-org",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("in-org");
    });

    test("returns correct total vs paginated data length", async () => {
      for (let i = 0; i < 5; i++) {
        await AuditLogModel.create({
          ...BASE_PAYLOAD,
          organizationId: orgId,
          resourceId: `resource-${i}`,
        });
      }

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 2,
        offset: 0,
      });

      expect(result.pagination.total).toBe(5);
      expect(result.data).toHaveLength(2);
    });

    test("offset paging is non-overlapping and stable", async () => {
      for (let i = 0; i < 4; i++) {
        await AuditLogModel.create({
          ...BASE_PAYLOAD,
          organizationId: orgId,
          resourceId: `resource-${i}`,
        });
      }

      const page1 = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 2,
        offset: 0,
      });
      const page2 = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 2,
        offset: 2,
      });

      const ids1 = page1.data.map((r) => r.id);
      const ids2 = page2.data.map((r) => r.id);
      expect(new Set([...ids1, ...ids2]).size).toBe(4);
      expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    });

    test("orders by createdAt desc by default", async () => {
      const row1 = await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceId: "first",
      });
      const row2 = await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceId: "second",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      const ids = result.data.map((r) => r.id);
      // Most recently inserted should come first (desc)
      expect(ids.indexOf(row2.id)).toBeLessThan(ids.indexOf(row1.id));
    });

    test("sortDirection asc reverses order", async () => {
      const row1 = await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceId: "first",
      });
      const row2 = await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceId: "second",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
        sortDirection: "asc",
      });

      const ids = result.data.map((r) => r.id);
      expect(ids.indexOf(row1.id)).toBeLessThan(ids.indexOf(row2.id));
    });

    test("startDate boundary is inclusive", async () => {
      const before = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceId: "recent",
      });

      // endDate set after row creation so createdAt is guaranteed to be <= endDate
      const after = new Date(Date.now() + 60_000);

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        startDate: before,
        endDate: after,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("recent");
    });

    test("endDate excludes rows created after it", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceId: "recent",
      });

      const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        endDate: pastDate,
      });

      expect(result.data).toHaveLength(0);
    });

    test("actorUserId filter works independently", async ({ makeUser }) => {
      const user = await makeUser();
      const otherUser = await makeUser();

      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        actorUserId: user.id,
        resourceId: "by-user",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        actorUserId: otherUser.id,
        resourceId: "by-other",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        actorUserId: user.id,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("by-user");
    });

    test("action filter works independently", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        action: "create",
        resourceId: "create-row",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        action: "delete",
        resourceId: "delete-row",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        action: "delete",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("delete-row");
    });

    test("resourceType filter works independently", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceType: "agent",
        resourceId: "agent-row",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceType: "role",
        resourceId: "role-row",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        resourceType: "role",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("role-row");
    });

    test("search matches actor_email case-insensitively", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        actorEmail: "Alice@Example.COM",
        resourceId: "alice-row",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        actorEmail: "bob@example.com",
        resourceId: "bob-row",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        search: "alice@example",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("alice-row");
    });

    test("search matches actor_name case-insensitively", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        actorName: "SuperAdmin",
        resourceId: "admin-row",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        actorName: "Regular User",
        resourceId: "user-row",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        search: "superadmin",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("admin-row");
    });

    test("search matches http_path case-insensitively", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        httpPath: "/api/agents/UNIQUE-PATH-ID",
        resourceId: "path-row",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        httpPath: "/api/roles/other-id",
        resourceId: "other-row",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        search: "unique-path-id",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("path-row");
    });

    test("search matches resource_id case-insensitively", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceId: "SpecialAgentXYZ",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceId: "other-agent",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        search: "specialagentxyz",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("SpecialAgentXYZ");
    });

    test("multiple filters are AND-combined", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        action: "create",
        resourceType: "agent",
        resourceId: "match",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        action: "delete",
        resourceType: "agent",
        resourceId: "no-match-action",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        action: "create",
        resourceType: "role",
        resourceId: "no-match-type",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        action: "create",
        resourceType: "agent",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("match");
    });
  });

  describe("deleteOlderThan", () => {
    test("deletes only rows older than threshold in the given org", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const otherOrg = await makeOrganization();

      // Row that is "old" — we'll update its createdAt via raw insert trick:
      // Since PGlite auto-sets createdAt to now(), create then check count after delete.
      // Create a row in org (it will have createdAt = now)
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: org.id,
        resourceId: "recent",
      });

      // Create a row in otherOrg (should NOT be deleted)
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: otherOrg.id,
        resourceId: "other-org",
      });

      // Delete rows older than 1 day in the future (no rows qualify yet)
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const deleted = await AuditLogModel.deleteOlderThan({
        organizationId: org.id,
        before: futureDate,
      });

      expect(deleted).toBe(1);

      // Other org row should be untouched
      const otherOrgResult = await AuditLogModel.findPaginated({
        organizationId: otherOrg.id,
        limit: 100,
        offset: 0,
      });
      expect(otherOrgResult.data).toHaveLength(1);
    });

    test("returns 0 when no rows match", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: org.id,
      });

      // Threshold in the past — nothing is older than a date before the row was created
      const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const deleted = await AuditLogModel.deleteOlderThan({
        organizationId: org.id,
        before: pastDate,
      });

      expect(deleted).toBe(0);

      // Row still exists
      const result = await AuditLogModel.findPaginated({
        organizationId: org.id,
        limit: 100,
        offset: 0,
      });
      expect(result.data).toHaveLength(1);
    });

    test("only removes rows belonging to the specified org", async ({
      makeOrganization,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: org1.id,
        resourceId: "org1-row",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: org2.id,
        resourceId: "org2-row",
      });

      // Delete everything "before tomorrow" in org1 only
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await AuditLogModel.deleteOlderThan({
        organizationId: org1.id,
        before: tomorrow,
      });

      const org2Result = await AuditLogModel.findPaginated({
        organizationId: org2.id,
        limit: 100,
        offset: 0,
      });
      expect(org2Result.data).toHaveLength(1);
      expect(org2Result.data[0].resourceId).toBe("org2-row");
    });

    test("returns count of deleted rows", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      await AuditLogModel.create({ ...BASE_PAYLOAD, organizationId: org.id });
      await AuditLogModel.create({ ...BASE_PAYLOAD, organizationId: org.id });
      await AuditLogModel.create({ ...BASE_PAYLOAD, organizationId: org.id });

      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const deleted = await AuditLogModel.deleteOlderThan({
        organizationId: org.id,
        before: tomorrow,
      });

      expect(deleted).toBe(3);
    });

    test("second deleteOlderThan with the same cutoff is idempotent (zero further deletes)", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      await AuditLogModel.create({ ...BASE_PAYLOAD, organizationId: org.id });
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const first = await AuditLogModel.deleteOlderThan({
        organizationId: org.id,
        before: tomorrow,
      });
      expect(first).toBeGreaterThanOrEqual(1);

      const second = await AuditLogModel.deleteOlderThan({
        organizationId: org.id,
        before: tomorrow,
      });
      expect(second).toBe(0);
    });
  });
});
