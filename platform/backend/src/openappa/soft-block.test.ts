import { eq } from "drizzle-orm";
import { afterEach, vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import OpenAppaUnenforcedModel from "@/models/openappa-unenforced";
import OpenAppaYellModel from "@/models/openappa-yell";
import { clearRegisteredProcessLocalCaches } from "@/process-local-cache-registry";
import { expect, test } from "@/test";
import { waiveSoftBlock } from "./soft-block";
import { isUnenforcedSession, startedUnenforced } from "./unenforced";

const initialMode = config.openappa.softBlockMode;
const initialYell = config.openappa.yellEnabled;
afterEach(() => {
  config.openappa.softBlockMode = initialMode;
  config.openappa.yellEnabled = initialYell;
});

for (const reports of [true, false]) {
  test(`first-boundary waiver persists independently of yell reporting (${reports})`, async ({
    makeOrganization,
  }) => {
    const session = {
      organization_id: (await makeOrganization()).id,
      caller_id: "user:test",
      session_id: "first-return",
    };
    config.openappa.softBlockMode = "allow";
    config.openappa.yellEnabled = reports;
    expect(await waiveSoftBlock(session, "child_return", "void return")).toBe(
      true,
    );
    expect(await isUnenforcedSession(session)).toBe(true);
    const bypass = await db
      .select()
      .from(schema.openappaUnenforcedSessionsTable)
      .where(
        eq(
          schema.openappaUnenforcedSessionsTable.organizationId,
          session.organization_id,
        ),
      );
    expect(bypass).toHaveLength(1);
    const yells = await db
      .select()
      .from(schema.openappaYellsTable)
      .where(
        eq(schema.openappaYellsTable.organizationId, session.organization_id),
      );
    expect(yells).toHaveLength(reports ? 1 : 0);
    if (reports) {
      expect(yells[0].message).toContain("Original refusal:\nvoid return");
      expect(yells[0].message).toContain(
        "Guardrails enforcement off for session first-return",
      );
      expect(yells[0].message).toContain("Technical boundary: child_return");
    }
  });
}

test("a failed yell cannot roll back a session bypass", async ({
  makeOrganization,
}) => {
  const session = {
    organization_id: (await makeOrganization()).id,
    caller_id: "user:test",
    session_id: "yell-failure",
  };
  config.openappa.softBlockMode = "allow";
  config.openappa.yellEnabled = true;
  const yell = vi
    .spyOn(OpenAppaYellModel, "recordWaiver")
    .mockRejectedValue(new Error("reporting unavailable"));
  try {
    expect(await waiveSoftBlock(session, "tool_result", "withheld")).toBe(true);
    expect(await isUnenforcedSession(session)).toBe(true);
  } finally {
    yell.mockRestore();
  }
});

test("refuse mode and explicit hard blocks do not create a bypass", async ({
  makeOrganization,
}) => {
  const session = {
    organization_id: (await makeOrganization()).id,
    session_id: "not-waived",
  };
  config.openappa.softBlockMode = "refuse";
  expect(await waiveSoftBlock(session, "child_return", "void return")).toBe(
    false,
  );
  config.openappa.softBlockMode = "allow";
  expect(
    await waiveSoftBlock(session, "tool_call", "requires attention: blocked"),
  ).toBe(false);
  expect(await isUnenforcedSession(session)).toBe(false);
});

test("a fork recognizes a durable waiver from another process", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  config.openappa.softBlockMode = "allow";
  await OpenAppaUnenforcedModel.recordSession({
    organizationId,
    sessionId: "source",
    parentId: undefined,
    reason: "superyell",
  });
  expect(
    await isUnenforcedSession({
      organization_id: organizationId,
      session_id: "fork",
      fork_of: "source",
    }),
  ).toBe(true);
});

for (const relation of ["parent_id", "fork_of"] as const) {
  test(`an inherited ${relation} waiver persists through two hops`, async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    config.openappa.softBlockMode = "allow";
    config.openappa.yellEnabled = false;
    const source = { organization_id: organizationId, session_id: "source" };
    const intermediate = {
      ...source,
      session_id: "intermediate",
      [relation]: source.session_id,
    };
    const descendant = {
      ...source,
      session_id: "descendant",
      [relation]: intermediate.session_id,
    };
    await waiveSoftBlock(source, "child_return", "withheld");

    expect(await startedUnenforced(intermediate)).toBe(true);
    expect(
      await OpenAppaUnenforcedModel.findSessions({
        organizationId,
        sessionIds: [intermediate.session_id],
      }),
    ).toEqual([expect.objectContaining({ reason: "superyell" })]);
    clearRegisteredProcessLocalCaches();
    expect(await startedUnenforced(descendant)).toBe(true);
    expect(
      await isUnenforcedSession({
        ...descendant,
        organization_id: (await makeOrganization()).id,
      }),
    ).toBe(false);
  });

  test(`an inherited ${relation} waiver reaches the next hop while storage is unavailable`, async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    config.openappa.softBlockMode = "allow";
    config.openappa.yellEnabled = false;
    const source = { organization_id: organizationId, session_id: "source" };
    const intermediate = {
      ...source,
      session_id: "intermediate",
      [relation]: source.session_id,
    };
    const descendant = {
      ...source,
      session_id: "descendant",
      [relation]: intermediate.session_id,
    };
    await waiveSoftBlock(source, "child_return", "withheld");
    const record = vi
      .spyOn(OpenAppaUnenforcedModel, "recordSession")
      .mockRejectedValue(new Error("store unavailable"));
    try {
      expect(await startedUnenforced(intermediate)).toBe(true);
      expect(await startedUnenforced(descendant)).toBe(true);
    } finally {
      record.mockRestore();
    }
    // A later admission retries persistence after storage recovers.
    expect(await startedUnenforced(intermediate)).toBe(true);
    clearRegisteredProcessLocalCaches();
    expect(await startedUnenforced(descendant)).toBe(true);
  });
}
