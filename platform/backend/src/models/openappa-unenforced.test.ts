import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import OpenAppaUnenforcedModel from "./openappa-unenforced";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("OpenAppaUnenforcedModel.deleteOlderThan", () => {
  test("deletes the records written before the cutoff, in batches, and keeps newer ones", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const old = new Date(Date.now() - 40 * DAY_MS);
    await db.insert(schema.openappaUnenforcedSessionsTable).values([
      { organizationId: org.id, sessionId: "old-1", createdAt: old },
      { organizationId: org.id, sessionId: "old-2", createdAt: old },
      { organizationId: org.id, sessionId: "old-3", createdAt: old },
      { organizationId: org.id, sessionId: "new" },
    ]);
    await db.insert(schema.openappaUnenforcedCallsTable).values([
      {
        organizationId: org.id,
        sessionId: "governed",
        toolCallId: "old-call",
        reason: "made",
        createdAt: old,
      },
      {
        organizationId: org.id,
        sessionId: "governed",
        toolCallId: "new-call",
        reason: "child",
        childNativeId: "worker",
      },
    ]);

    const deleted = await OpenAppaUnenforcedModel.deleteOlderThan(
      new Date(Date.now() - 30 * DAY_MS),
      2,
    );

    expect(deleted).toEqual({ sessions: 3, calls: 1 });
    expect(
      await OpenAppaUnenforcedModel.findSessions({
        organizationId: org.id,
        sessionIds: ["old-1", "old-2", "old-3", "new"],
      }),
    ).toEqual([{ sessionId: "new", parentId: null }]);
    expect(
      await OpenAppaUnenforcedModel.findCalls({
        organizationId: org.id,
        sessionIds: ["governed"],
        toolCallIds: ["old-call", "new-call"],
      }),
    ).toEqual([
      expect.objectContaining({ toolCallId: "new-call", reason: "child" }),
    ]);
  });
});

describe("OpenAppaUnenforcedModel.findCalls", () => {
  test("finds a call by its id or by the child it started, only in the named sessions", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    await OpenAppaUnenforcedModel.recordCalls({
      organizationId: org.id,
      sessionId: "lead",
      toolCallIds: ["bash-1"],
      reason: "made",
    });
    await OpenAppaUnenforcedModel.recordCalls({
      organizationId: org.id,
      sessionId: "lead",
      toolCallIds: ["spawn-1"],
      reason: "child",
      childNativeId: "worker",
    });
    await OpenAppaUnenforcedModel.recordCalls({
      organizationId: org.id,
      sessionId: "other-lead",
      toolCallIds: ["bash-2"],
      reason: "made",
    });
    await OpenAppaUnenforcedModel.recordCalls({
      organizationId: other.id,
      sessionId: "lead",
      toolCallIds: ["bash-3"],
      reason: "made",
    });

    const found = await OpenAppaUnenforcedModel.findCalls({
      organizationId: org.id,
      sessionIds: ["lead"],
      toolCallIds: ["bash-1", "bash-2", "bash-3", "unknown"],
      childNativeIds: ["worker"],
    });

    expect(found).toHaveLength(2);
    expect(found).toEqual(
      expect.arrayContaining([
        { toolCallId: "bash-1", reason: "made", childNativeId: null },
        { toolCallId: "spawn-1", reason: "child", childNativeId: "worker" },
      ]),
    );
  });
});
