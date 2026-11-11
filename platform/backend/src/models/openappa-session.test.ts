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

test("completed result IDs require the same organization, caller, session, parent and root", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const session = {
    organizationId,
    callerId: "user:synthetic",
    sessionId: "synthetic-child",
    parentId: "synthetic-parent",
  };
  await db.insert(schema.openappaSessionsTable).values({
    ...session,
    actor: "synthetic-actor",
    root: "synthetic-root",
    startDecision: { decision: "ack" },
  });
  const result = {
    organizationId,
    callerId: session.callerId,
    sessionId: session.sessionId,
    root: "synthetic-root",
    status: "complete",
    approvedOutput: "admitted",
    decision: { decision: "ack" },
  };
  await db.insert(schema.openappaProcessedResultsTable).values([
    { ...result, toolCallId: "completed" },
    { ...result, toolCallId: "foreign-root", root: "another-root" },
    {
      ...result,
      toolCallId: "pending",
      status: "pending",
      approvedOutput: null,
      decision: null,
    },
    { ...result, toolCallId: "foreign-caller", callerId: "user:another" },
  ]);
  const read = (
    overrides: Partial<
      Parameters<typeof OpenAppaSessionModel.completedToolResultIds>[0]
    > = {},
  ) =>
    OpenAppaSessionModel.completedToolResultIds({
      ...session,
      toolCallIds: [
        "completed",
        "foreign-root",
        "pending",
        "foreign-caller",
        "unknown",
      ],
      ...overrides,
    });
  expect(await read()).toEqual(new Set(["completed"]));
  expect(await read({ callerId: "user:another" })).toEqual(new Set());
  expect(await read({ callerId: undefined })).toEqual(new Set());
  expect(await read({ organizationId: "another" })).toEqual(new Set());
  expect(await read({ sessionId: "another" })).toEqual(new Set());
  expect(await read({ parentId: "another" })).toEqual(new Set());
  expect(await read({ parentId: undefined })).toEqual(new Set());
  expect(await read({ toolCallIds: [] })).toEqual(new Set());
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

test("waived peer reads retain recipient, caller, organization and expiry boundaries", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const session = {
    organizationId,
    callerId: "user:test",
    sessionId: "child",
    parentId: "parent",
  };
  await db.insert(schema.openappaSessionsTable).values({
    ...session,
    actor: "child-actor",
    root: "family",
    startDecision: { decision: "ack" },
  });
  const message = {
    root: "family",
    sender: "sender",
    recipient: "child-actor",
    dispatch: "send",
    digest: "digest",
    label: {},
    body: "Original peer message",
    status: "held",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    createdAt: Math.floor(Date.now() / 1000),
  };
  await db.insert(schema.openappaEmbeddedPeerMessagesTable).values([
    { ...message, id: "held" },
    {
      ...message,
      id: "sibling",
      dispatch: "send-sibling",
      recipient: "sibling-actor",
    },
    { ...message, id: "expired", dispatch: "send-expired", expiresAt: 1 },
  ]);
  const read = (
    overrides: Partial<
      Parameters<typeof OpenAppaSessionModel.waivedPeerBody>[0]
    > = {},
  ) =>
    OpenAppaSessionModel.waivedPeerBody({
      ...session,
      messageId: "held",
      ...overrides,
    });
  expect(await read()).toBe("Original peer message");
  expect(await read({ messageId: "sibling" })).toBeNull();
  expect(await read({ messageId: "expired" })).toBeNull();
  expect(await read({ messageId: "missing" })).toBeNull();
  expect(await read({ callerId: "user:other" })).toBeNull();
  expect(await read({ organizationId: "other" })).toBeNull();
  expect(await read({ parentId: "wrong-parent" })).toBeNull();
});

test("Grok native child identities survive resume, stay immutable and require the persisted caller and parent", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const child = {
    organizationId,
    callerId: "user:synthetic",
    sessionId: "parent:original-child",
    parentId: "parent",
    actor: "child-actor",
    root: "root",
    startDecision: { decision: "ack" },
  };
  await db
    .insert(schema.openappaSessionsTable)
    .values([
      child,
      { ...child, sessionId: "parent:other-child", actor: "other-child-actor" },
    ]);
  const binding = {
    organizationId,
    callerId: child.callerId,
    parentId: child.parentId,
    childSessionId: child.sessionId,
    nativeId: "resumed-native-id",
  };
  await OpenAppaSessionModel.retainGrokChildIdentity(binding);
  await OpenAppaSessionModel.retainGrokChildIdentity(binding);
  expect(await OpenAppaSessionModel.grokChildIdentity(binding)).toBe(
    child.sessionId,
  );
  for (const changed of [
    { callerId: "user:other" },
    { organizationId: "foreign" },
    { parentId: "another-parent" },
    { nativeId: "resumed" },
  ])
    expect(
      await OpenAppaSessionModel.grokChildIdentity({ ...binding, ...changed }),
    ).toBeUndefined();
  await expect(
    OpenAppaSessionModel.retainGrokChildIdentity({
      ...binding,
      childSessionId: "parent:other-child",
    }),
  ).rejects.toThrow("already bound");
  await OpenAppaSessionModel.retainGrokChildIdentity({
    ...binding,
    nativeId: "unstarted",
    childSessionId: "missing",
  });
  expect(
    await OpenAppaSessionModel.grokChildIdentity({
      ...binding,
      nativeId: "unstarted",
    }),
  ).toBeUndefined();
});
