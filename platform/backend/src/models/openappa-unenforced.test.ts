import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import OpenAppaUnenforcedModel from "./openappa-unenforced";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("OpenAppaUnenforcedModel.deleteOlderThan", () => {
  test("deletes the records written before the cutoff and keeps newer ones", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const old = new Date(Date.now() - 40 * DAY_MS);
    await db.insert(schema.openappaUnenforcedSessionsTable).values([
      { organizationId: org.id, sessionId: "old", createdAt: old },
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
    );

    expect(deleted).toEqual({ sessions: 1, calls: 1 });
    expect(
      await OpenAppaUnenforcedModel.findSessions({
        organizationId: org.id,
        sessionIds: ["old", "new"],
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
