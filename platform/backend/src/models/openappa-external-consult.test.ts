import { count } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import OpenappaExternalConsultModel from "./openappa-external-consult";

describe("OpenappaExternalConsultModel.deleteExpired", () => {
  test("keeps deleting in batches until no expired row is left", async ({
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const expired = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await db.insert(schema.openappaExternalConsultsTable).values(
      [expired, expired, expired, expired, expired, new Date()].map(
        (createdAt) => ({
          id: crypto.randomUUID(),
          organizationId,
          createdAt,
          startedAt: createdAt,
          durationMs: 1,
          role: "annotator" as const,
          externalName: "scan",
          backend: "url" as const,
          request: {},
          outcome: "answered" as const,
          root: "root",
          trajectory: "root",
        }),
      ),
    );

    const deleted = await OpenappaExternalConsultModel.deleteExpired({
      retentionDays: 30,
      batchSize: 2,
    });

    expect(deleted).toBe(5);
    const [{ total }] = await db
      .select({ total: count() })
      .from(schema.openappaExternalConsultsTable);
    expect(total).toBe(1);
  });
});

describe("OpenappaExternalConsultModel.findCursorPaginated llmSessionId", () => {
  test("returns every trajectory's consults for the LLM session, and nothing from other sessions or organizations", async ({
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const { id: otherOrganizationId } = await makeOrganization();
    // The session and its sub-agent share one root; a second session of the
    // same caller, and the same client id in another organization, do not.
    await db
      .insert(schema.openappaSessionsTable)
      .values([
        session(organizationId, "user:1|chat-1", "root-a"),
        session(organizationId, "user:1|chat-1/sub", "root-a"),
        session(organizationId, "user:1|chat-2", "root-b"),
        session(otherOrganizationId, "user:1|chat-1", "root-c"),
      ]);
    await db
      .insert(schema.openappaExternalConsultsTable)
      .values([
        consult(organizationId, "root-a", "gate"),
        consult(organizationId, "root-a", "scan"),
        consult(organizationId, "root-b", "elsewhere"),
        consult(otherOrganizationId, "root-c", "foreign"),
      ]);

    const page = await OpenappaExternalConsultModel.findCursorPaginated({
      organizationId,
      filters: { llmSessionId: "chat-1" },
      limit: 10,
    });

    expect(page.data.map((row) => row.externalName).sort()).toEqual([
      "gate",
      "scan",
    ]);
  });
});

function session(organizationId: string, sessionId: string, root: string) {
  return {
    organizationId,
    sessionId,
    root,
    actor: `${organizationId}:${sessionId}`,
    startDecision: {},
  };
}

function consult(organizationId: string, root: string, externalName: string) {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    organizationId,
    createdAt: now,
    startedAt: now,
    durationMs: 1,
    role: "authority" as const,
    externalName,
    backend: "llm" as const,
    request: {},
    outcome: "answered" as const,
    root,
    trajectory: root,
  };
}
