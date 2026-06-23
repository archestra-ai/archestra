import { describe, expect, test } from "vitest";
import { SelectAuditLogSchema } from "./audit-log";

/**
 * Read-side resilience for SelectAuditLogSchema.
 *
 * The action/actorType/outcome columns are unconstrained `text` in Postgres, so
 * a legacy or renamed value outside the current closed vocabulary can exist in
 * the DB. The select schema must coerce such out-of-vocabulary values to a safe
 * sentinel (via `.catch`) instead of throwing, otherwise a single anomalous row
 * fails response serialization and breaks the entire Audit Logs page.
 */
describe("SelectAuditLogSchema", () => {
  const baseRow = {
    id: "00000000-0000-0000-0000-000000000000",
    eventSequence: 1,
    organizationId: "org-1",
    occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    actorId: null,
    actorType: "user",
    actorName: null,
    actorEmail: null,
    action: "agent.created",
    outcome: "success",
    resourceType: null,
    resourceId: null,
    before: null,
    after: null,
    httpMethod: null,
    httpPath: null,
    httpRoute: null,
    httpStatus: null,
    requestId: null,
    sourceIp: null,
    userAgent: null,
  };

  test("coerces an out-of-vocabulary action to the 'unknown.updated' sentinel", () => {
    const parsed = SelectAuditLogSchema.parse({
      ...baseRow,
      action: "agent.archived",
    });
    expect(parsed.action).toBe("unknown.updated");
  });

  test("coerces an out-of-vocabulary actorType to the 'system' sentinel", () => {
    const parsed = SelectAuditLogSchema.parse({
      ...baseRow,
      actorType: "robot",
    });
    expect(parsed.actorType).toBe("system");
  });

  test("coerces an out-of-vocabulary outcome to the 'failure' sentinel", () => {
    const parsed = SelectAuditLogSchema.parse({
      ...baseRow,
      outcome: "errored",
    });
    expect(parsed.outcome).toBe("failure");
  });

  test("preserves a valid known action value as-is", () => {
    const parsed = SelectAuditLogSchema.parse({
      ...baseRow,
      action: "agent.created",
    });
    expect(parsed.action).toBe("agent.created");
  });
});
