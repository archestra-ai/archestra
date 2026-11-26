import { randomBytes, randomUUID } from "node:crypto";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import OpenAppaOperationModel from "./openappa-operation";

function canonicalOfferId(): string {
  return randomBytes(32).toString("hex");
}

describe("OpenAppaOperationModel.activityByDay", () => {
  test("matches rendered 16-hex offer ids on decisions to canonical 64-hex consult offer ids", async ({
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const now = new Date();
    const approvedOffer = canonicalOfferId();
    const cleanedOffer = canonicalOfferId();
    const bothApprovedOffer = canonicalOfferId();
    const bothCleanedOffer = canonicalOfferId();
    const deniedOffer = canonicalOfferId();

    await db.insert(schema.openappaOperationsTable).values([
      {
        organizationId,
        sessionId: "sess-1",
        operationId: "call:approved",
        root: "root-1",
        status: "complete",
        input: { event: "tool_call", tool: "shell" },
        decision: {
          decision: "deny_call",
          offers: [{ offer_id: approvedOffer.slice(0, 16) }],
        },
        createdAt: now,
      },
      {
        organizationId,
        sessionId: "sess-1",
        operationId: "call:cleaned",
        root: "root-1",
        status: "complete",
        input: { event: "tool_call", tool: "fetch" },
        decision: {
          decision: "deny_call",
          offers: [{ offer_id: cleanedOffer.slice(0, 16) }],
        },
        createdAt: now,
      },
      {
        organizationId,
        sessionId: "sess-1",
        operationId: "call:both",
        root: "root-1",
        status: "complete",
        input: { event: "tool_call", tool: "mail" },
        decision: {
          decision: "deny_call",
          offers: [
            { offer_id: bothApprovedOffer.slice(0, 16) },
            { offer_id: bothCleanedOffer.slice(0, 16) },
          ],
        },
        createdAt: now,
      },
      {
        organizationId,
        sessionId: "sess-1",
        operationId: "call:denied",
        root: "root-1",
        status: "complete",
        input: { event: "tool_call", tool: "delete" },
        decision: {
          decision: "deny_call",
          offers: [{ offer_id: deniedOffer.slice(0, 16) }],
        },
        createdAt: now,
      },
      {
        organizationId,
        sessionId: "sess-1",
        operationId: "call:empty-offer",
        root: "root-1",
        status: "complete",
        input: { event: "tool_call", tool: "noop" },
        decision: {
          decision: "deny_call",
          offers: [{ offer_id: "" }],
        },
        createdAt: now,
      },
    ]);

    await db.insert(schema.openappaExternalConsultsTable).values([
      {
        id: randomUUID(),
        organizationId,
        createdAt: now,
        startedAt: now,
        durationMs: 10,
        role: "authority",
        externalName: "review",
        backend: "url",
        request: {},
        outcome: "answered",
        answer: { ruling: "approve" },
        root: "root-1",
        trajectory: "root-1",
        offerId: approvedOffer,
      },
      {
        id: randomUUID(),
        organizationId,
        createdAt: now,
        startedAt: now,
        durationMs: 10,
        role: "sanitizer",
        externalName: "redact",
        backend: "url",
        request: {},
        outcome: "answered",
        answer: {},
        root: "root-1",
        trajectory: "root-1",
        offerId: cleanedOffer,
      },
      {
        id: randomUUID(),
        organizationId,
        createdAt: now,
        startedAt: now,
        durationMs: 10,
        role: "authority",
        externalName: "review",
        backend: "url",
        request: {},
        outcome: "answered",
        answer: { ruling: "approve" },
        root: "root-1",
        trajectory: "root-1",
        offerId: bothApprovedOffer,
      },
      {
        id: randomUUID(),
        organizationId,
        createdAt: now,
        startedAt: now,
        durationMs: 10,
        role: "sanitizer",
        externalName: "redact",
        backend: "url",
        request: {},
        outcome: "answered",
        answer: {},
        root: "root-1",
        trajectory: "root-1",
        offerId: bothCleanedOffer,
      },
      {
        id: randomUUID(),
        organizationId,
        createdAt: now,
        startedAt: now,
        durationMs: 10,
        role: "authority",
        externalName: "review",
        backend: "url",
        request: {},
        outcome: "answered",
        answer: { ruling: "deny" },
        root: "root-1",
        trajectory: "root-1",
        offerId: deniedOffer,
      },
    ]);

    const days = await OpenAppaOperationModel.activityByDay({
      organizationId,
      timeZone: "UTC",
      days: 1,
    });

    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      approved: 2,
      cleaned: 1,
      blocked: 2,
    });
  });
});
