import { and, eq, sql } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import OpenAppaYellModel from "@/models/openappa-yell";
import { describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  humanApprovalWaived,
  isUnattendedRequest,
  isUnattendedSession,
  recordWaivedCalls,
  recordWaivedReview,
  rememberUnattendedSession,
  unattendedNoteMatters,
  waiverFor,
} from "./break-the-glass";
import { findUnenforcedCalls, isUnenforcedSession } from "./unenforced";

// The unattended note lives in the real cache.
setupTestCacheManager();

/** `recordWaivedCalls` for one call. */
function recordWaivedCall(params: {
  session: Parameters<typeof recordWaivedCalls>[0]["session"];
  toolCallId: string;
  tool: string;
  kind: "approval_waived" | "block_waived";
  superyell: boolean;
}) {
  const { session, superyell, ...call } = params;
  return recordWaivedCalls({ session, calls: [call], superyell });
}

const on = {
  active: true,
  humanApprovalMode: "block" as const,
  unapprovableBlockMode: "refuse" as const,
};
const review = {
  feedback: "requires attention: human-approval",
  recorded: true,
  offers: [{ offer_id: "o1" }],
  review: [{ offer_id: "o1", text: "approve?" }],
};
const noRemedy = {
  feedback: "forbidden after a send effect",
  recorded: true,
  offers: [],
};

describe("waiverFor", () => {
  test("lets a call waiting for human approval through only where the setting reaches", () => {
    const cases = [
      { mode: "block", unattended: true, expected: null },
      { mode: "unattended", unattended: false, expected: null },
      { mode: "unattended", unattended: true, expected: "approval_waived" },
      { mode: "everywhere", unattended: false, expected: "approval_waived" },
    ] as const;
    for (const { mode, unattended, expected } of cases)
      expect(
        waiverFor({
          decision: review,
          settings: { ...on, humanApprovalMode: mode },
          unattended,
        }),
      ).toBe(expected);
  });

  test("leaves a call with a remedy the agent can run itself to the agent", () => {
    const everywhere = { ...on, humanApprovalMode: "everywhere" as const };
    // The ruling offers a plan the agent can run (o2) next to the review (o1).
    expect(
      waiverFor({
        decision: { ...review, offers: ["o1", "o2"] },
        settings: everywhere,
        unattended: true,
      }),
    ).toBe(null);
    // Every offer needs a person: the setting stands in for them.
    expect(
      waiverFor({
        decision: { ...review, offers: ["o1"] },
        settings: everywhere,
        unattended: true,
      }),
    ).toBe("approval_waived");
  });

  test("lets a call no remedy can lift through only when allowed", () => {
    expect(
      waiverFor({ decision: noRemedy, settings: on, unattended: true }),
    ).toBe(null);
    expect(
      waiverFor({
        decision: noRemedy,
        settings: { ...on, unapprovableBlockMode: "allow" },
        unattended: false,
      }),
    ).toBe("block_waived");
  });

  test("never lets through the blocked mark, unrecorded denials, remedies the agent can run (an offer or a tool to run first), or anything while enforcement is off", () => {
    const everything = {
      active: true,
      humanApprovalMode: "everywhere" as const,
      unapprovableBlockMode: "allow" as const,
    };
    for (const decision of [
      { ...noRemedy, feedback: "requires attention: blocked" },
      { ...noRemedy, feedback: "requires attention: hard-block" },
      { ...noRemedy, feedback: "requires attention: signoff, blocked" },
      // A redispatch names another tool to run first and mints no offer.
      {
        ...noRemedy,
        feedback:
          "[appa] Blocked: send_email cannot run yet.\n\nWhy:\n  - requires a prior scan effect\n\nContinue:\n  - Run scan first; it clears: requires a prior scan effect.",
      },
      {
        ...review,
        feedback:
          "requires attention: human-approval\n\nContinue:\n  - Run scan first; it clears: requires a prior scan effect.",
      },
      { ...review, feedback: "requires attention: blocked" },
      { feedback: "annotator failed", unanswered: true, offers: [] },
      { feedback: "not loaded" },
      { feedback: "sanitize first", recorded: true, offers: [{ id: "s" }] },
    ])
      expect(
        waiverFor({ decision, settings: everything, unattended: true }),
      ).toBe(null);
    expect(
      waiverFor({
        decision: review,
        settings: { ...everything, active: false },
        unattended: true,
      }),
    ).toBe(null);
  });
});

test("an Agent Runtime run is unattended whatever its image sends; other clients opt in with the header", () => {
  expect(isUnattendedRequest({ headers: {}, agentRuntimeRun: true })).toBe(
    true,
  );
  expect(
    isUnattendedRequest({
      headers: { "x-archestra-unattended": "1" },
      agentRuntimeRun: false,
    }),
  ).toBe(true);
  expect(
    isUnattendedRequest({
      headers: { "x-archestra-unattended": "0" },
      agentRuntimeRun: false,
    }),
  ).toBe(false);
  expect(isUnattendedRequest({ headers: {}, agentRuntimeRun: false })).toBe(
    false,
  );
});

test("a waived call is hidden from the runtime and repeats merge into one yell", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const session = {
    organization_id: organizationId,
    caller_id: "user:u1",
    session_id: "user:u1|s1",
  };
  for (const toolCallId of ["call-1", "call-2"])
    expect(
      await recordWaivedCall({
        session,
        toolCallId,
        tool: "mcp/slack/send",
        kind: "block_waived",
        superyell: false,
      }),
    ).toBe(true);

  const unenforced = await findUnenforcedCalls({
    session,
    toolCallIds: ["call-1", "call-2", "call-3"],
  });
  expect(Object.fromEntries(unenforced.reasons)).toEqual({
    "call-1": "waived",
    "call-2": "waived",
  });

  const yells = await db
    .select()
    .from(schema.openappaYellsTable)
    .where(
      and(
        eq(schema.openappaYellsTable.organizationId, organizationId),
        eq(schema.openappaYellsTable.sessionId, session.session_id),
      ),
    );
  expect(yells).toEqual([
    expect.objectContaining({
      kind: "block_waived",
      count: 2,
      superyell: false,
      message: expect.stringContaining("mcp/slack/send"),
    }),
  ]);
  // Without superyell the session stays under OpenAPPA.
  expect(await isUnenforcedSession(session)).toBe(false);
});

test("a waived call turns Guardrails off for the session when the yell is a superyell, as the agent's own yell does", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const session = {
    organization_id: organizationId,
    caller_id: "user:u1",
    session_id: "user:u1|s2",
  };
  expect(
    await recordWaivedCall({
      session,
      toolCallId: "call-1",
      tool: "mcp/slack/send",
      kind: "approval_waived",
      superyell: true,
    }),
  ).toBe(true);
  expect(await isUnenforcedSession(session)).toBe(true);
  const [yell] = await db
    .select()
    .from(schema.openappaYellsTable)
    .where(eq(schema.openappaYellsTable.sessionId, session.session_id));
  expect(yell).toMatchObject({ kind: "approval_waived", superyell: true });
});

test("a repeated evaluation of a waived call counts once; another call counts again", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const session = {
    organization_id: organizationId,
    caller_id: "user:u1",
    session_id: "user:u1|s3",
  };
  const waive = (toolCallId: string) =>
    recordWaivedCall({
      session,
      toolCallId,
      tool: "mcp/slack/send",
      kind: "approval_waived",
      superyell: false,
    });
  expect(await waive("call-1")).toBe(true);
  // A retried response proposes the same call id again.
  expect(await waive("call-1")).toBe(true);
  expect((await yellsOf(organizationId, session.session_id))[0]?.count).toBe(1);
  expect(await waive("call-2")).toBe(true);
  expect((await yellsOf(organizationId, session.session_id))[0]?.count).toBe(2);
});

test("a failed yell write leaves no marker behind, and the next record succeeds", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const session = {
    organization_id: organizationId,
    caller_id: "user:u1",
    session_id: "user:u1|s4",
  };
  const waive = () =>
    recordWaivedCall({
      session,
      toolCallId: "call-1",
      tool: "mcp/slack/send",
      kind: "approval_waived",
      superyell: true,
    });
  const failing = vi
    .spyOn(OpenAppaYellModel, "recordWaiver")
    .mockRejectedValueOnce(new Error("yell storage down"));
  try {
    expect(await waive()).toBe(false);
  } finally {
    failing.mockRestore();
  }
  // The marker rolled back with the yell: the refused call's result stays
  // withheld, and the session stays under OpenAPPA.
  expect(
    (await findUnenforcedCalls({ session, toolCallIds: ["call-1"] })).reasons
      .size,
  ).toBe(0);
  expect(await isUnenforcedSession(session)).toBe(false);
  expect(await yellsOf(organizationId, session.session_id)).toEqual([]);

  expect(await waive()).toBe(true);
  expect(
    Object.fromEntries(
      (await findUnenforcedCalls({ session, toolCallIds: ["call-1"] })).reasons,
    ),
  ).toEqual({ "call-1": "waived" });
  expect(await isUnenforcedSession(session)).toBe(true);
  expect(await yellsOf(organizationId, session.session_id)).toEqual([
    expect.objectContaining({ kind: "approval_waived", count: 1 }),
  ]);
});

test("a waived review records a yell for the reviewed tool and follows the Yell tool setting", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const session = {
    organization_id: organizationId,
    caller_id: "user:u1",
    session_id: "user:u1|s5",
  };
  const authorized = async () => true;
  expect(
    await recordWaivedReview({
      session,
      tool: "host/archestra/Agent",
      superyell: false,
      authorize: authorized,
    }),
  ).toBe("recorded");
  expect(await isUnenforcedSession(session)).toBe(false);
  expect(
    await recordWaivedReview({
      session,
      tool: "host/archestra/Agent",
      superyell: true,
      authorize: authorized,
    }),
  ).toBe("recorded");
  expect(await isUnenforcedSession(session)).toBe(true);
  expect(await yellsOf(organizationId, session.session_id)).toEqual([
    expect.objectContaining({
      kind: "approval_waived",
      count: 2,
      superyell: true,
      message: expect.stringContaining("host/archestra/Agent"),
    }),
  ]);
  // A failed write says so before the plan is authorized: nothing is spent.
  const authorize = vi.fn(async () => true);
  const failing = vi
    .spyOn(OpenAppaYellModel, "recordWaiver")
    .mockRejectedValueOnce(new Error("yell storage down"));
  try {
    expect(
      await recordWaivedReview({
        session,
        tool: "host/archestra/Agent",
        superyell: true,
        authorize,
      }),
    ).toBe("failed");
  } finally {
    failing.mockRestore();
  }
  expect(authorize).not.toHaveBeenCalled();
  // A plan the runtime refuses rolls its record back.
  const quiet = { ...session, session_id: "user:u1|s5-refused" };
  expect(
    await recordWaivedReview({
      session: quiet,
      tool: "host/archestra/Agent",
      superyell: true,
      authorize: async () => false,
    }),
  ).toBe("refused");
  expect(await yellsOf(organizationId, quiet.session_id)).toEqual([]);
  expect(await isUnenforcedSession(quiet)).toBe(false);
  // The runtime's own failure is the caller's, and leaves no record either.
  await expect(
    recordWaivedReview({
      session: quiet,
      tool: "host/archestra/Agent",
      superyell: true,
      authorize: async () => {
        throw new Error("runtime down");
      },
    }),
  ).rejects.toThrow("runtime down");
  expect(await yellsOf(organizationId, quiet.session_id)).toEqual([]);
});

test("the proxy's unattended note is read for that session only, and withdrawn once a person is back", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const session = { organization_id: organizationId, session_id: "s6" };
  expect(await isUnattendedSession(session)).toBe(false);
  await rememberUnattendedSession(session, true);
  expect(await isUnattendedSession(session)).toBe(true);
  expect(await isUnattendedSession({ ...session, session_id: "s7" })).toBe(
    false,
  );
  expect(
    await isUnattendedSession({ ...session, organization_id: "other" }),
  ).toBe(false);
  // A session resumed with a person present stops being answered for.
  await rememberUnattendedSession(session, false);
  expect(await isUnattendedSession(session)).toBe(false);
  // Another replica noted the session unattended since this process withdrew
  // the note: the next attended request withdraws it again, memo or not.
  await rememberUnattendedSession(session, true);
  await rememberUnattendedSession(session, false);
  await rememberUnattendedSession(session, true);
  expect(await isUnattendedSession(session)).toBe(true);
  await rememberUnattendedSession(session, false);
  expect(await isUnattendedSession(session)).toBe(false);
});

/** Makes the cache's storage refuse the given writes to unattended notes. */
async function refuseUnattendedNoteWrites(
  writes: readonly ("DELETE" | "INSERT OR UPDATE")[],
): Promise<() => Promise<void>> {
  await db.execute(sql`
    CREATE FUNCTION refuse_unattended_note() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cache storage down'; END $$
  `);
  for (const [index, write] of writes.entries()) {
    const row = write === "DELETE" ? "OLD" : "NEW";
    await db.execute(
      sql.raw(`
        CREATE TRIGGER refuse_unattended_note_${index} BEFORE ${write} ON keyv_cache
        FOR EACH ROW WHEN (${row}.key LIKE '%openappa-unattended-session-%')
        EXECUTE FUNCTION refuse_unattended_note()
      `),
    );
  }
  return async () => {
    await db.execute(sql`DROP FUNCTION refuse_unattended_note() CASCADE`);
  };
}

test("an attended request whose note cannot be deleted overwrites it, so no review is answered for a person", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const session = { organization_id: organizationId, session_id: "s11" };
  await rememberUnattendedSession(session, true);
  const restore = await refuseUnattendedNoteWrites(["DELETE"]);
  try {
    await rememberUnattendedSession(session, false);
    expect(await isUnattendedSession(session)).toBe(false);
  } finally {
    await restore();
  }
  await rememberUnattendedSession(session, true);
  expect(await isUnattendedSession(session)).toBe(true);
  await rememberUnattendedSession(session, false);
  expect(await isUnattendedSession(session)).toBe(false);
});

test("an attended request whose note can be neither deleted nor overwritten fails, and the note recovers once the cache does", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const session = { organization_id: organizationId, session_id: "s12" };
  await rememberUnattendedSession(session, true);
  const restore = await refuseUnattendedNoteWrites([
    "DELETE",
    "INSERT OR UPDATE",
  ]);
  try {
    await expect(rememberUnattendedSession(session, false)).rejects.toThrow();
    expect(await isUnattendedSession(session)).toBe(true);
  } finally {
    await restore();
  }
  await rememberUnattendedSession(session, false);
  expect(await isUnattendedSession(session)).toBe(false);
  await rememberUnattendedSession(session, true);
  expect(await isUnattendedSession(session)).toBe(true);
  await rememberUnattendedSession(session, false);
  expect(await isUnattendedSession(session)).toBe(false);
});

test("humanApprovalWaived reaches an unattended session, everywhere, or nowhere", () => {
  const settings = (
    humanApprovalMode: "block" | "unattended" | "everywhere",
  ) => ({
    active: true,
    humanApprovalMode,
    unapprovableBlockMode: "refuse" as const,
  });
  expect(humanApprovalWaived(settings("block"), true)).toBe(false);
  expect(humanApprovalWaived(settings("unattended"), false)).toBe(false);
  expect(humanApprovalWaived(settings("unattended"), true)).toBe(true);
  expect(humanApprovalWaived(settings("everywhere"), false)).toBe(true);
  expect(
    humanApprovalWaived({ ...settings("everywhere"), active: false }, true),
  ).toBe(false);
});

async function yellsOf(organizationId: string, sessionId: string) {
  return db
    .select()
    .from(schema.openappaYellsTable)
    .where(
      and(
        eq(schema.openappaYellsTable.organizationId, organizationId),
        eq(schema.openappaYellsTable.sessionId, sessionId),
      ),
    );
}

test("a batch's waived calls commit together as one yell per tool, and reports off record nothing", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const session = {
    organization_id: organizationId,
    caller_id: "user:u1",
    session_id: "user:u1|s8",
  };
  expect(
    await recordWaivedCalls({
      session,
      calls: [
        {
          toolCallId: "call-1",
          tool: "mcp/slack/send",
          kind: "approval_waived",
        },
        {
          toolCallId: "call-2",
          tool: "mcp/slack/send",
          kind: "approval_waived",
        },
        { toolCallId: "call-3", tool: "mcp/mail/send", kind: "block_waived" },
      ],
      superyell: false,
    }),
  ).toBe(true);
  expect(
    Object.fromEntries(
      (
        await findUnenforcedCalls({
          session,
          toolCallIds: ["call-1", "call-2", "call-3"],
        })
      ).reasons,
    ),
  ).toEqual({ "call-1": "waived", "call-2": "waived", "call-3": "waived" });
  const yells = await yellsOf(organizationId, session.session_id);
  expect(
    yells.map(({ kind, count, message }) => ({ kind, count, message })),
  ).toEqual(
    expect.arrayContaining([
      {
        kind: "approval_waived",
        count: 2,
        message: expect.stringContaining("mcp/slack/send"),
      },
      {
        kind: "block_waived",
        count: 1,
        message: expect.stringContaining("mcp/mail/send"),
      },
    ]),
  );

  // Reports off: the call still runs, but nothing is recorded as a yell and
  // the session is not turned off, whatever the Yell tool setting says.
  const yellEnabled = config.openappa.yellEnabled;
  config.openappa.yellEnabled = false;
  try {
    const quiet = { ...session, session_id: "user:u1|s9" };
    expect(
      await recordWaivedCall({
        session: quiet,
        toolCallId: "call-1",
        tool: "mcp/slack/send",
        kind: "approval_waived",
        superyell: true,
      }),
    ).toBe(true);
    expect(await yellsOf(organizationId, quiet.session_id)).toEqual([]);
    expect(await isUnenforcedSession(quiet)).toBe(false);
    // A waived review says there is no yell to point to.
    expect(
      await recordWaivedReview({
        session: quiet,
        tool: "host/archestra/Agent",
        superyell: true,
        authorize: async () => true,
      }),
    ).toBe("reports_off");
    expect(await yellsOf(organizationId, quiet.session_id)).toEqual([]);
    expect(await isUnenforcedSession(quiet)).toBe(false);
  } finally {
    config.openappa.yellEnabled = yellEnabled;
  }
});

test("a resolved yell raised again starts over as a new one", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const session = {
    organization_id: organizationId,
    caller_id: "user:u1",
    session_id: "user:u1|s10",
  };
  const waive = (toolCallId: string) =>
    recordWaivedCall({
      session,
      toolCallId,
      tool: "mcp/slack/send",
      kind: "block_waived",
      superyell: false,
    });
  await waive("call-1");
  await waive("call-2");
  const [first] = await yellsOf(organizationId, session.session_id);
  expect(first?.count).toBe(2);
  const resolvedAt = new Date("2026-01-01T00:00:00Z");
  await db
    .update(schema.openappaYellsTable)
    .set({ createdAt: resolvedAt, resolvedAt, resolvedBy: "user:u1" })
    .where(eq(schema.openappaYellsTable.id, first.id));

  await waive("call-3");
  const [again] = await yellsOf(organizationId, session.session_id);
  expect(again).toMatchObject({ id: first.id, count: 1, resolvedAt: null });
  expect(again.createdAt.getTime()).toBeGreaterThan(resolvedAt.getTime());
});

test("the unattended note is kept only in the mode that reads it", () => {
  const settings = (
    humanApprovalMode: "block" | "unattended" | "everywhere",
    active = true,
  ) => ({ active, humanApprovalMode });
  expect(unattendedNoteMatters(settings("unattended"))).toBe(true);
  expect(unattendedNoteMatters(settings("block"))).toBe(false);
  expect(unattendedNoteMatters(settings("everywhere"))).toBe(false);
  expect(unattendedNoteMatters(settings("unattended", false))).toBe(false);
});
