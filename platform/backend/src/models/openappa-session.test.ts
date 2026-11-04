import db, { schema } from "@/database";
import { expect, test } from "@/test";
import OpenAppaSessionModel from "./openappa-session";

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
