import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import OpenAppaSessionModel from "./openappa-session";

describe("OpenAppaSessionModel retained results holding a NUL", () => {
  test("a tool result and a peer read the runtime stored in their plaintext envelope read back as they were", async ({
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const sessionId = `user:1|${crypto.randomUUID()}`;
    const approvedOutput = "head\u0000tail";
    await db.insert(schema.openappaProcessedResultsTable).values([
      {
        organizationId,
        callerId: "user:1",
        sessionId,
        toolCallId: "call-1",
        root: "root",
        status: "complete",
        // As OpenAPPA writes values PostgreSQL cannot store as they are.
        approvedOutput: textEnvelope(approvedOutput),
        decision: jsonEnvelope({ peer_read: true, note: "a\u0000b" }),
      },
    ]);
    const key = {
      organizationId,
      sessionId,
      callerId: "user:1",
      toolCallId: "call-1",
    };

    expect(await OpenAppaSessionModel.retainedToolResult(key)).toBe(
      approvedOutput,
    );
    expect(await OpenAppaSessionModel.retainedPeerReadReceipt(key)).toEqual({
      kind: "admitted",
      approvedOutput,
    });
  });
});

// ===

function envelopeBase64(body: string): string {
  return Buffer.concat([
    Buffer.from("\0appa-storage-v1\0", "latin1"),
    Buffer.from([0]),
    Buffer.from(body, "utf8"),
  ]).toString("base64");
}

function textEnvelope(text: string): string {
  return `appa-storage-v1:${envelopeBase64(text)}`;
}

function jsonEnvelope(value: unknown) {
  return { __appa_encrypted: envelopeBase64(JSON.stringify(value)) };
}
