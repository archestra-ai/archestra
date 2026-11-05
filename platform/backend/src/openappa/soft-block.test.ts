import { eq } from "drizzle-orm";
import { afterEach, vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import OpenAppaUnenforcedModel from "@/models/openappa-unenforced";
import OpenAppaYellModel from "@/models/openappa-yell";
import { expect, test } from "@/test";
import { waiveSoftBlock } from "./soft-block";
import { isUnenforcedSession } from "./unenforced";

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
