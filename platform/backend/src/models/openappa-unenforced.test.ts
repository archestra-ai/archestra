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
      // A superyell record from an earlier release expires like any other.
      {
        organizationId: org.id,
        sessionId: "superyelled",
        reason: "superyell",
        createdAt: old,
      },
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

    expect(deleted).toEqual({ sessions: 4, calls: 1 });
    expect(
      await OpenAppaUnenforcedModel.findSessions({
        organizationId: org.id,
        sessionIds: ["old-1", "old-2", "old-3", "new", "superyelled"],
      }),
    ).toEqual([
      { sessionId: "new", parentId: null, reason: "enforcement_off" },
    ]);
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

describe("legacy records exempt nothing", () => {
  test("no read returns a superyell session or a waived call", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await db.insert(schema.openappaUnenforcedSessionsTable).values([
      { organizationId: org.id, sessionId: "root:off", parentId: "root" },
      {
        organizationId: org.id,
        sessionId: "root:off:worker",
        parentId: "root:off",
        reason: "superyell",
      },
      {
        organizationId: org.id,
        sessionId: "root:worker",
        parentId: "root",
      },
    ]);
    await db.insert(schema.openappaUnenforcedCallsTable).values([
      {
        organizationId: org.id,
        sessionId: "root",
        toolCallId: "denied-run",
        reason: "waived",
      },
      {
        organizationId: org.id,
        sessionId: "root",
        toolCallId: "spawn",
        reason: "waived",
        childNativeId: "waived-child",
      },
    ]);

    expect(
      await OpenAppaUnenforcedModel.findSessions({
        organizationId: org.id,
        sessionIds: ["root:off:worker"],
      }),
    ).toEqual([]);
    // The legacy sibling at another depth does not make the id ambiguous.
    expect(
      await OpenAppaUnenforcedModel.findFamilyMembers({
        organizationId: org.id,
        rootSessionId: "root",
        nativeId: "worker",
      }),
    ).toEqual([
      { sessionId: "root:worker", parentId: "root", reason: "enforcement_off" },
    ]);
    expect(
      await OpenAppaUnenforcedModel.findCalls({
        organizationId: org.id,
        sessionIds: ["root"],
        toolCallIds: ["denied-run", "spawn"],
        childNativeIds: ["waived-child"],
      }),
    ).toEqual([]);
  });

  test("an enforcement-off observation replaces a superyell row, and nothing replaces an observation", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const old = new Date(Date.now() - 40 * DAY_MS);
    await db.insert(schema.openappaUnenforcedSessionsTable).values({
      organizationId: org.id,
      sessionId: "root:child",
      reason: "superyell",
      createdAt: old,
    });

    await OpenAppaUnenforcedModel.recordSession({
      organizationId: org.id,
      sessionId: "root:child",
      parentId: "root",
    });
    await OpenAppaUnenforcedModel.recordSession({
      organizationId: org.id,
      sessionId: "root:child",
      parentId: "elsewhere",
    });

    expect(
      await OpenAppaUnenforcedModel.findSessions({
        organizationId: org.id,
        sessionIds: ["root:child"],
      }),
    ).toEqual([
      { sessionId: "root:child", parentId: "root", reason: "enforcement_off" },
    ]);
    // The observation is fresh, so the retention sweep keeps it.
    expect(
      await OpenAppaUnenforcedModel.deleteOlderThan(
        new Date(Date.now() - 30 * DAY_MS),
      ),
    ).toEqual({ sessions: 0, calls: 0 });
  });
});
