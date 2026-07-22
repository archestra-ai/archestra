import { beforeEach, describe, expect, test } from "@/test";
import AuditLogModel from "./audit-log";

/**
 * Contract: AuditLogModel
 * - create: persists JSON snapshots, returns generated id/timestamps; invalid rows rejected by DB.
 * - findPaginated: always scoped by organizationId; filters combine with AND; search is ILIKE on four fields.
 *   Sort is (created_at DESC, event_sequence DESC) to give deterministic ordering even for same-ms rows.
 * - deleteOlderThan: deletes only rows strictly older than `before` for the given org; returns deleted count.
 */

const BASE_PAYLOAD = {
  actorId: null,
  actorType: "user" as const,
  actorName: "Test User",
  actorEmail: "test@example.com",
  action: "agent.created" as const,
  outcome: "success" as const,
  occurredAt: new Date("2025-01-01T00:00:00.000Z"),
  resourceType: "agent",
  resourceId: "agent-123",
  before: null,
  after: { name: "My Agent" },
  httpMethod: "POST",
  httpPath: "/api/agents",
  httpRoute: "/api/agents",
  httpStatus: 201,
  sourceIp: "127.0.0.1",
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

    test("inserts and returns row with id, createdAt, and eventSequence populated", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const row = await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: org.id,
      });

      expect(row.id).toBeDefined();
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.occurredAt).toBeInstanceOf(Date);
      expect(typeof row.eventSequence).toBe("number");
      expect(row.eventSequence).toBeGreaterThan(0);
      expect(row.organizationId).toBe(org.id);
      expect(row.action).toBe("agent.created");
      expect(row.outcome).toBe("success");
      expect(row.actorType).toBe("user");
      expect(row.resourceType).toBe("agent");
      expect(row.resourceId).toBe("agent-123");
      expect(row.actorEmail).toBe("test@example.com");
      expect(row.after).toEqual({ name: "My Agent" });
      expect(row.before).toBeNull();
    });

    test("preserves actor info when actorId is set", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const row = await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: org.id,
        actorId: user.id,
        actorName: user.name,
        actorEmail: user.email,
      });

      expect(row.actorId).toBe(user.id);
      expect(row.actorName).toBe(user.name);
      expect(row.actorEmail).toBe(user.email);
    });

    test("round-trips nested JSONB before and after exactly", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const before = {
        name: "Old",
        config: { env: ["A", "B"], retries: 3 },
        tags: ["x", "y"],
        nullable: null,
      };
      const after = {
        name: "New",
        config: { env: ["A", "C"], retries: 5 },
        tags: ["x", "z"],
        nullable: null,
        added: true,
      };

      const row = await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: org.id,
        action: "agent.updated",
        before,
        after,
      });

      // Read back via findPaginated so we exercise the SELECT path too.
      const result = await AuditLogModel.findPaginated({
        organizationId: org.id,
        limit: 10,
        offset: 0,
      });
      const fetched = result.data.find((r) => r.id === row.id);
      expect(fetched).toBeDefined();
      expect(fetched?.before).toEqual(before);
      expect(fetched?.after).toEqual(after);
    });

    test("stores auth event with null http fields", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const row = await AuditLogModel.create({
        organizationId: org.id,
        actorId: null,
        actorType: "user",
        actorName: "Test User",
        actorEmail: "test@example.com",
        action: "auth.signed_in",
        outcome: "success",
        occurredAt: new Date(),
        resourceType: null,
        resourceId: null,
        before: null,
        after: null,
        httpMethod: null,
        httpPath: "/api/auth/sign-in/email",
        httpRoute: null,
        httpStatus: null,
        sourceIp: "10.0.0.1",
        userAgent: "curl/7.88",
      });

      expect(row.action).toBe("auth.signed_in");
      expect(row.resourceType).toBeNull();
      expect(row.httpMethod).toBeNull();
      expect(row.httpStatus).toBeNull();
    });

    test("api_key actorType is stored and returned correctly", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const row = await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: org.id,
        actorType: "api_key",
        requestId: "req-abc-123",
      });

      expect(row.actorType).toBe("api_key");
      expect(row.requestId).toBe("req-abc-123");
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

    test("eventSequence tiebreaks same-createdAt rows deterministically", async () => {
      // Insert 5 rows — even if they share a millisecond, event_sequence is a
      // postgres bigserial that strictly increases. ORDER BY (created_at DESC,
      // event_sequence DESC) must return them last-inserted-first.
      const inserted: string[] = [];
      for (let i = 0; i < 5; i++) {
        const row = await AuditLogModel.create({
          ...BASE_PAYLOAD,
          organizationId: orgId,
          resourceId: `seq-${i}`,
        });
        inserted.push(row.id);
      }

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      const resultIds = result.data.map((r) => r.id);
      // Last inserted row must appear first (highest eventSequence wins tiebreak).
      expect(resultIds[0]).toBe(inserted[inserted.length - 1]);

      // event_sequence values must be strictly decreasing across the page.
      const sequences = result.data.map((r) => r.eventSequence);
      for (let i = 1; i < sequences.length; i++) {
        expect(sequences[i]).toBeLessThan(sequences[i - 1]);
      }
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

    test("actorId filter works independently", async ({ makeUser }) => {
      const user = await makeUser();
      const otherUser = await makeUser();

      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        actorId: user.id,
        resourceId: "by-user",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        actorId: otherUser.id,
        resourceId: "by-other",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        actorId: user.id,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("by-user");
    });

    test("outcome filter returns only matching rows", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        outcome: "success",
        resourceId: "success-row",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        outcome: "denied",
        resourceId: "denied-row",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        outcome: "failure",
        resourceId: "failure-row",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        outcome: "denied",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("denied-row");
      expect(result.data[0].outcome).toBe("denied");
    });

    test("actorType filter returns only matching rows", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        actorType: "user",
        resourceId: "user-row",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        actorType: "api_key",
        resourceId: "api-key-row",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        actorType: "api_key",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("api-key-row");
      expect(result.data[0].actorType).toBe("api_key");
    });

    test("combined outcome + action filter ANDs correctly", async () => {
      // Should match: denied agent.deleted
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        outcome: "denied",
        action: "agent.deleted",
        resourceId: "match",
      });
      // Wrong outcome
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        outcome: "success",
        action: "agent.deleted",
        resourceId: "wrong-outcome",
      });
      // Wrong action
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        outcome: "denied",
        action: "agent.created",
        resourceId: "wrong-action",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        outcome: "denied",
        action: "agent.deleted",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("match");
    });

    test("action filter works independently", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        action: "agent.created",
        resourceId: "create-row",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        action: "agent.deleted",
        resourceId: "delete-row",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        action: "agent.deleted",
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
        action: "role.created",
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

    test("search trims surrounding whitespace before matching", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceId: "trim-target",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        search: "   trim-target   ",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].resourceId).toBe("trim-target");
    });

    test("whitespace-only search is ignored (returns all org rows)", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceId: "row-a",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        resourceId: "row-b",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        search: "   ",
      });

      expect(result.data).toHaveLength(2);
    });

    test("multiple filters are AND-combined", async () => {
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        action: "agent.created",
        resourceType: "agent",
        resourceId: "match",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        action: "agent.deleted",
        resourceType: "agent",
        resourceId: "no-match-action",
      });
      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: orgId,
        action: "agent.created",
        resourceType: "role",
        resourceId: "no-match-type",
      });

      const result = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 100,
        offset: 0,
        action: "agent.created",
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

      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: org.id,
        resourceId: "recent",
      });

      await AuditLogModel.create({
        ...BASE_PAYLOAD,
        organizationId: otherOrg.id,
        resourceId: "other-org",
      });

      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const deleted = await AuditLogModel.deleteOlderThan({
        organizationId: org.id,
        before: futureDate,
      });

      expect(deleted).toBe(1);

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

      const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const deleted = await AuditLogModel.deleteOlderThan({
        organizationId: org.id,
        before: pastDate,
      });

      expect(deleted).toBe(0);

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

    test("second deleteOlderThan with the same cutoff is idempotent", async ({
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

  describe("deleteAllOlderThan", () => {
    test("deletes rows from every organization in one query", async ({
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

      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const deleted = await AuditLogModel.deleteAllOlderThan(tomorrow);

      expect(deleted).toBe(2);

      const org1Result = await AuditLogModel.findPaginated({
        organizationId: org1.id,
        limit: 100,
        offset: 0,
      });
      const org2Result = await AuditLogModel.findPaginated({
        organizationId: org2.id,
        limit: 100,
        offset: 0,
      });
      expect(org1Result.data).toHaveLength(0);
      expect(org2Result.data).toHaveLength(0);
    });

    test("returns 0 when no row predates the cutoff", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      await AuditLogModel.create({ ...BASE_PAYLOAD, organizationId: org.id });

      const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const deleted = await AuditLogModel.deleteAllOlderThan(pastDate);

      expect(deleted).toBe(0);
      const result = await AuditLogModel.findPaginated({
        organizationId: org.id,
        limit: 100,
        offset: 0,
      });
      expect(result.data).toHaveLength(1);
    });
  });
});
