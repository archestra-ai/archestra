import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  AppaOpaqueHistoryError,
  collectOpaqueHistoryItems,
  recordIssuedResponseItems,
  validateInboundOpaqueItems,
} from "@/services/appa-opaque-history";
import { expect, test } from "@/test";
import type {
  AppaOpaqueHistoryMode,
  AppaOpaqueHistoryScope,
  AppaOpaqueHistoryWindowRef,
} from "@/types";

const ROOT_WINDOW = windowRef("window-0", 0, "turn-0");

test("accepts only stock empty-content normalization and restores the issued reasoning object", async () => {
  const scope = await makeScope();
  const absent = reasoningItem("reasoning-absent", "absent-ciphertext");
  const explicitNull = {
    ...reasoningItem("reasoning-null", "null-ciphertext"),
    content: null,
  };
  const { content: _content, ...omittedNull } = explicitNull;
  const explicitEmpty = {
    ...reasoningItem("reasoning-empty", "empty-ciphertext"),
    content: [],
  };
  const { content: _emptyContent, ...omittedEmpty } = explicitEmpty;
  const idless = {
    type: "reasoning",
    summary: [],
    encrypted_content: "idless-ciphertext",
  };
  await recordInference(scope, [absent, explicitNull, explicitEmpty, idless]);
  const validate = (items: Record<string, unknown>[]) =>
    validateInboundOpaqueItems({
      scope,
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      items,
    });
  await expect(
    validate([{ ...absent, content: [] }, omittedNull, omittedEmpty]),
  ).resolves.toEqual([absent, explicitNull, explicitEmpty]);
  await expect(
    validate([idless, { ...idless, content: null }]),
  ).rejects.toMatchObject({ code: "duplicate_item" });
  for (const altered of [
    { ...absent, content: null, encrypted_content: "altered" },
    { ...absent, content: [{ type: "reasoning_text", text: "injected" }] },
    {
      ...absent,
      content: null,
      summary: [{ type: "summary_text", text: "changed" }],
    },
  ]) {
    await expect(validate([altered])).rejects.toMatchObject({
      code: "cross_scope_item",
    });
  }
});

test("preserves native window lineage across empty, ordinary, and compaction turns", async () => {
  const scope = await makeScope();
  const reasoning = reasoningItem("reasoning-1", "reasoning-ciphertext");
  const sameWindowNextTurn = windowRef("window-0", 0, "turn-1");
  const compaction = {
    type: "compaction",
    encrypted_content: "idless-compaction-ciphertext",
  };
  const successor = windowRef("window-1", 1, "turn-2");

  await expect(
    validateInboundOpaqueItems({
      scope,
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      items: [],
    }),
  ).resolves.toEqual([]);

  await recordInference(scope, [reasoning]);
  await expect(
    validateInboundOpaqueItems({
      scope,
      mode: "inference",
      sourceWindow: sameWindowNextTurn,
      items: [reasoning],
    }),
  ).resolves.toEqual([reasoning]);

  await recordIssuedResponseItems({
    scope,
    mode: "compactv2",
    trigger: "automatic",
    sourceWindow: sameWindowNextTurn,
    responseItems: [compaction],
    maxItems: 16,
    maxBytes: 1024 * 1024,
  });
  await expect(
    validateInboundOpaqueItems({
      scope,
      mode: "inference",
      sourceWindow: successor,
      items: [compaction],
    }),
  ).resolves.toEqual([compaction]);

  await expect(
    validateInboundOpaqueItems({
      scope,
      mode: "inference",
      sourceWindow: windowRef("unknown-window", 1, "turn-3"),
      items: [reasoning],
    }),
  ).rejects.toMatchObject({ code: "unauthorized_lineage" });

  await expect(
    validateInboundOpaqueItems({
      scope,
      mode: "inference",
      sourceWindow: windowRef("window-0", 1, "turn-3"),
      items: [reasoning],
    }),
  ).rejects.toMatchObject({ code: "unauthorized_lineage" });
});

test("records source-real id-less compaction and late-binds the client successor", async () => {
  const scope = await makeScope();
  const compaction = {
    type: "compaction",
    encrypted_content: "source-real-idless-compaction",
    summary: [{ type: "summary_text", text: "opaque" }],
  };

  await recordIssuedResponseItems({
    scope,
    mode: "compactv2",
    trigger: "automatic",
    sourceWindow: ROOT_WINDOW,
    responseItems: [compaction],
    maxItems: 16,
    maxBytes: 1024 * 1024,
  });

  const [issued] = await db
    .select({
      providerItemId: schema.appaOpaqueHistoryItemsTable.providerItemId,
      serverIdentity: schema.appaOpaqueHistoryItemsTable.serverIdentity,
      windowId: schema.appaOpaqueHistoryItemsTable.windowId,
    })
    .from(schema.appaOpaqueHistoryItemsTable)
    .where(eq(schema.appaOpaqueHistoryItemsTable.sessionId, scope.sessionId));
  expect(issued?.providerItemId).toBeNull();
  expect(issued?.serverIdentity).toEqual(expect.any(String));

  const successor = windowRef("client-window-after-compact", 1, "turn-1");
  await expect(
    validateInboundOpaqueItems({
      scope,
      mode: "compactv2",
      sourceWindow: successor,
      items: [compaction],
    }),
  ).resolves.toEqual([compaction]);

  const windows = await db
    .select()
    .from(schema.appaOpaqueHistoryWindowsTable)
    .where(eq(schema.appaOpaqueHistoryWindowsTable.sessionId, scope.sessionId));
  const bound = windows.find(
    (window) => window.providerWindowId === successor.providerWindowId,
  );
  expect(bound).toMatchObject({
    parentWindowId: issued?.windowId,
    boundByServerIdentity: issued?.serverIdentity,
  });
});

test("tracks ordinary reasoning and known nested encrypted args and output", async () => {
  const scope = await makeScope();
  const items = [
    {
      type: "reasoning",
      id: "reasoning-provider-id",
      encrypted_content: "reasoning-ciphertext",
    },
    {
      type: "function_call",
      arguments: { encrypted_content: "nested-argument-ciphertext" },
    },
    {
      type: "function_call_output",
      output: { encrypted_content: "nested-output-ciphertext" },
    },
  ];

  await recordIssuedResponseItems({
    scope,
    mode: "inference",
    sourceWindow: ROOT_WINDOW,
    responseItems: [{ type: "message", content: "not opaque" }, ...items],
    maxItems: 16,
    maxBytes: 1024 * 1024,
  });

  await expect(
    validateInboundOpaqueItems({
      scope,
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      items,
    }),
  ).resolves.toEqual(items);
});

test("rejects altered, cross-session, changed-model, and duplicate opaque history", async () => {
  const scope = await makeScope();
  const item = reasoningItem("reasoning-id", "original-ciphertext");
  await recordInference(scope, [item]);

  await expect(
    validateInboundOpaqueItems({
      scope,
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      items: [{ ...item, encrypted_content: "altered-ciphertext" }],
    }),
  ).rejects.toMatchObject({ code: "cross_scope_item" });

  await expect(
    validateInboundOpaqueItems({
      scope,
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      items: [item, item],
    }),
  ).rejects.toMatchObject({ code: "duplicate_item" });

  const foreignScope = await makeScope();
  await expect(
    validateInboundOpaqueItems({
      scope: foreignScope,
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      items: [item],
    }),
  ).rejects.toMatchObject({ code: "unauthorized_lineage" });

  await expect(
    validateInboundOpaqueItems({
      scope: { ...scope, ownerScopeHash: "different-owner" },
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      items: [item],
    }),
  ).rejects.toMatchObject({ code: "unauthorized_lineage" });

  await expect(
    validateInboundOpaqueItems({
      scope: { ...scope, provider: "other-provider" },
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      items: [item],
    }),
  ).rejects.toMatchObject({ code: "unauthorized_lineage" });

  await expect(
    validateInboundOpaqueItems({
      scope: { ...scope, model: "different-model" },
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      items: [item],
    }),
  ).rejects.toMatchObject({ code: "unauthorized_lineage" });
});

test("does not treat arbitrary strings as opaque history", async () => {
  const scope = await makeScope();
  await recordIssuedResponseItems({
    scope,
    mode: "inference",
    sourceWindow: ROOT_WINDOW,
    responseItems: [{ type: "message", content: "arbitrary string" }],
    maxItems: 16,
    maxBytes: 1024 * 1024,
  });

  const rows = await db
    .select()
    .from(schema.appaOpaqueHistoryItemsTable)
    .where(eq(schema.appaOpaqueHistoryItemsTable.sessionId, scope.sessionId));
  expect(rows).toEqual([]);

  await expect(
    validateInboundOpaqueItems({
      scope,
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      items: [{ type: "message", content: "arbitrary string" }],
    }),
  ).rejects.toMatchObject({ code: "invalid_item" });
});

test("blocks unobserved opaque markers before APPA or client projection", async () => {
  expect(() =>
    collectOpaqueHistoryItems([
      { type: "future_provider_item", encrypted_content: "unobserved" },
    ]),
  ).toThrow(AppaOpaqueHistoryError);

  const scope = await makeScope();
  await expect(
    recordIssuedResponseItems({
      scope,
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      responseItems: [
        { type: "future_provider_item", encrypted_content: "unobserved" },
      ],
      maxItems: 16,
      maxBytes: 1024 * 1024,
    }),
  ).rejects.toMatchObject({ code: "invalid_item" });
});

test("bounds immutable history by item count and canonical bytes without pruning", async () => {
  const scope = await makeScope();
  await recordInference(scope, [reasoningItem("one", "ciphertext-one")], 1);

  await expect(
    recordInference(scope, [reasoningItem("two", "ciphertext-two")], 1),
  ).rejects.toMatchObject({ code: "storage_limit" });

  const byteScope = await makeScope();
  await expect(
    recordIssuedResponseItems({
      scope: byteScope,
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      responseItems: [reasoningItem("too-large", "ciphertext")],
      maxItems: 16,
      maxBytes: 1,
    }),
  ).rejects.toMatchObject({ code: "storage_limit" });
});

test("surfaces decryption failure as a quarantine-required ledger error", async () => {
  const scope = await makeScope();
  const item = reasoningItem("corrupt-me", "ciphertext");
  await recordInference(scope, [item]);
  await db
    .update(schema.appaOpaqueHistoryItemsTable)
    .set({ canonicalPayloadEncrypted: "not-valid-ciphertext" })
    .where(
      and(
        eq(schema.appaOpaqueHistoryItemsTable.sessionId, scope.sessionId),
        eq(schema.appaOpaqueHistoryItemsTable.providerItemId, "corrupt-me"),
      ),
    );

  await expect(
    validateInboundOpaqueItems({
      scope,
      mode: "inference",
      sourceWindow: ROOT_WINDOW,
      items: [item],
    }),
  ).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof AppaOpaqueHistoryError &&
      error.code === "persistence_uncertain" &&
      error.quarantineRequired,
  );
});

async function makeScope(): Promise<AppaOpaqueHistoryScope> {
  const sessionId = randomUUID();
  const ownerScopeHash = `owner-${sessionId}`;
  await db.insert(schema.appaProxySessionsTable).values({
    id: sessionId,
    profileId: randomUUID(),
    ownerScopeHash,
    clientSessionId: `client-${sessionId}`,
    rootId: `root-${sessionId}`,
  });
  return {
    sessionId,
    ownerScopeHash,
    provider: "openai",
    protocol: "responses",
    model: "gpt-test",
  };
}

async function recordInference(
  scope: AppaOpaqueHistoryScope,
  responseItems: Record<string, unknown>[],
  maxItems = 16,
): Promise<void> {
  await recordIssuedResponseItems({
    scope,
    mode: "inference" satisfies AppaOpaqueHistoryMode,
    sourceWindow: ROOT_WINDOW,
    responseItems,
    maxItems,
    maxBytes: 1024 * 1024,
  });
}

function windowRef(
  providerWindowId: string,
  frameVersion: number,
  sourceTurnId: string,
): AppaOpaqueHistoryWindowRef {
  return { providerWindowId, frameVersion, sourceTurnId };
}

function reasoningItem(
  id: string,
  encryptedContent: string,
): Record<string, unknown> {
  return { type: "reasoning", id, encrypted_content: encryptedContent };
}
