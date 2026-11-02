import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import {
  isUnattendedRequest,
  recordWaivedCall,
  waiverFor,
} from "./break-the-glass";
import { findUnenforcedCalls, isUnenforcedSession } from "./unenforced";

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

  test("never lets through the blocked mark, unrecorded denials, remedies the agent can run, or anything while enforcement is off", () => {
    const everything = {
      active: true,
      humanApprovalMode: "everywhere" as const,
      unapprovableBlockMode: "allow" as const,
    };
    for (const decision of [
      { ...noRemedy, feedback: "requires attention: blocked" },
      { ...noRemedy, feedback: "requires attention: hard-block" },
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
