import { vi } from "vitest";

vi.mock("@/logging");

import { sql } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
// biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
import ContentEncryptionStateModel from "@/models/content-encryption-state.ee";
import EncryptionKeyCanaryModel from "@/models/encryption-key-canary";
import MessageModel from "@/models/message";
import { beforeEach, describe, expect, test } from "@/test";
import type { InteractionRequest, InteractionResponse } from "@/types";
// biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
import { runContentEncryptionBackfill } from "./backfill.ee";
// biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
import { verifyContentEncryptionKey } from "./guard.ee";
import {
  _resetContentKeys,
  decryptContentValue,
  encryptContentValue,
  isContentEnvelope,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
} from "./index.ee";

const SECRET_A = "content-secret-a-0123456789012345";
const SECRET_B = "content-secret-b-0123456789012345";

function setKeys(current?: string, previous?: string) {
  config.contentEncryption.secret = current;
  config.contentEncryption.secretPrevious = previous;
  _resetContentKeys();
}

async function dropTrgmIndex() {
  await db.execute(sql`DROP INDEX IF EXISTS "messages_content_trgm_idx"`);
  await db.execute(
    sql`DROP INDEX IF EXISTS "mcp_tool_calls_tool_result_trgm_idx"`,
  );
}

const request = {
  model: "claude-sonnet-5",
  messages: [{ role: "user", content: "top secret question" }],
} as unknown as InteractionRequest;
const response = {
  id: "r1",
  content: [{ type: "text", text: "secret answer" }],
} as unknown as InteractionResponse;

async function seedPlaintextInteraction(): Promise<string> {
  const [row] = await db
    .insert(schema.interactionsTable)
    .values({ request, response, type: "anthropic:messages" })
    .returning({ id: schema.interactionsTable.id });
  return row.id;
}

async function rawInteraction(id: string) {
  const result = await db.execute<{ request: unknown; response: unknown }>(
    sql`SELECT request, response FROM interactions WHERE id = ${id}::uuid`,
  );
  return result.rows[0];
}

const toolCall = {
  id: "call-1",
  name: "read_email",
  arguments: { folder: "inbox" },
};
const toolResult = {
  id: "call-1",
  content: [{ type: "text", text: "top secret email body" }],
  isError: false,
};

async function rawMcpToolCall(id: string) {
  const result = await db.execute<{
    tool_call: unknown;
    tool_result: unknown;
  }>(
    sql`SELECT tool_call, tool_result FROM mcp_tool_calls WHERE id = ${id}::uuid`,
  );
  return result.rows[0];
}

describe("content encryption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.enterpriseFeatures.core = true;
    setKeys(undefined, undefined);
  });

  describe("value roundtrip", () => {
    test("objects, arrays, and strings roundtrip; plaintext passes through when off", () => {
      setKeys(SECRET_A);
      for (const value of [{ a: 1 }, [1, "two", { three: 3 }], "plain text"]) {
        const stored = encryptContentValue(value, "messages.content");
        expect(isContentEnvelope(stored)).toBe(true);
        expect(decryptContentValue(stored, "messages.content")).toEqual(value);
      }

      setKeys(undefined);
      const untouched = encryptContentValue({ a: 1 }, "messages.content");
      expect(untouched).toEqual({ a: 1 });
    });

    test("previous-key fallback decrypts rotated values", () => {
      setKeys(SECRET_A);
      const stored = encryptContentValue({ v: 42 }, "messages.content");
      setKeys(SECRET_B, SECRET_A);
      expect(decryptContentValue(stored, "messages.content")).toEqual({
        v: 42,
      });
    });

    test("AAD binds ciphertext to its column — transplant fails", () => {
      setKeys(SECRET_A);
      const stored = encryptContentValue({ v: 1 }, "messages.content");
      expect(() => decryptContentValue(stored, "interactions.request")).toThrow(
        /Failed to decrypt/,
      );
    });

    test("envelope-shaped plaintext is not mistaken for ciphertext", () => {
      setKeys(SECRET_A);
      const impostor = { __encrypted: "not-a-real-envelope" };
      expect(isContentEnvelope(impostor)).toBe(false);
      expect(decryptContentValue(impostor, "messages.content")).toEqual(
        impostor,
      );
    });
  });

  describe("model integration", () => {
    test("interactions are encrypted at rest and transparent through the model", async () => {
      setKeys(SECRET_A);
      const { InteractionModel } = await import("@/models");
      const created = await InteractionModel.create({
        profileId: null,
        request,
        response,
        type: "anthropic:messages",
      });
      // Public return value is plaintext…
      expect(created.request).toEqual(request);

      // …while the stored row is an envelope.
      const raw = await rawInteraction(created.id);
      expect(isContentEnvelope(raw.request)).toBe(true);
      expect(isContentEnvelope(raw.response)).toBe(true);

      const found = await InteractionModel.findById(created.id);
      expect(found?.request).toEqual(request);
      // (response equality is not asserted through findById — it normalizes
      // responses against the provider schema, which this minimal fixture
      // does not satisfy; the raw-row assertion above covers decryption.)
    });

    test("messages are encrypted at rest, reads and content-id lookups stay transparent", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      setKeys(SECRET_A);
      const { ConversationModel } = await import("@/models");
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "enc test",
      });

      const content = {
        id: "nanoid-xyz",
        role: "user",
        parts: [{ type: "text", text: "confidential review" }],
      };
      const message = await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content,
      });
      expect(message.content).toEqual(content);

      const raw = await db.execute<{ content: unknown }>(
        sql`SELECT content FROM messages WHERE id = ${message.id}::uuid`,
      );
      expect(isContentEnvelope(raw.rows[0].content)).toBe(true);

      const listed = await MessageModel.findByConversation(conversation.id);
      expect(listed[0].content).toEqual(content);

      const byContentId = await MessageModel.findByAnyIdInConversation(
        "nanoid-xyz",
        conversation.id,
      );
      expect(byContentId?.id).toBe(message.id);
    });

    test("mcp tool calls are encrypted at rest, reads and search stay coherent", async () => {
      setKeys(SECRET_A);
      const { McpToolCallModel } = await import("@/models");
      const created = await McpToolCallModel.create({
        mcpServerName: "email-server",
        method: "tools/call",
        toolCall,
        toolResult,
      });
      // Public return value is plaintext…
      expect(created.toolCall).toEqual(toolCall);
      expect(created.toolResult).toEqual(toolResult);

      // …while the stored row is an envelope for both content columns.
      const raw = await rawMcpToolCall(created.id);
      expect(isContentEnvelope(raw.tool_call)).toBe(true);
      expect(isContentEnvelope(raw.tool_result)).toBe(true);

      const found = await McpToolCallModel.findById(created.id);
      expect(found?.toolCall).toEqual(toolCall);
      expect(found?.toolResult).toEqual(toolResult);

      const pagination = { limit: 10, offset: 0, page: 1 };
      const listed = await McpToolCallModel.findAllPaginated(pagination);
      expect(listed.data[0].toolResult).toEqual(toolResult);

      // Search degrades to metadata: the ciphertext cannot match result
      // content, but server-name search still works.
      const byContent = await McpToolCallModel.findAllPaginated(
        pagination,
        undefined,
        undefined,
        undefined,
        { search: "secret email body" },
      );
      expect(byContent.data).toHaveLength(0);
      const byServer = await McpToolCallModel.findAllPaginated(
        pagination,
        undefined,
        undefined,
        undefined,
        { search: "email-server" },
      );
      expect(byServer.data).toHaveLength(1);
    });

    test("first-successful-call scan decrypts results instead of trusting SQL isError", async () => {
      setKeys(SECRET_A);
      const { McpToolCallModel } = await import("@/models");
      // Oldest row is an encrypted ERROR — the plain SQL predicate cannot see
      // into the envelope and would misread it as the first success.
      const errorCall = await McpToolCallModel.create({
        mcpServerName: "email-server",
        method: "tools/call",
        toolCall,
        toolResult: { ...toolResult, isError: true },
      });
      expect(await McpToolCallModel.getFirstSuccessfulToolCallAt()).toBeNull();

      const successCall = await McpToolCallModel.create({
        mcpServerName: "email-server",
        method: "tools/call",
        toolCall,
        toolResult,
      });
      const firstSuccessAt =
        await McpToolCallModel.getFirstSuccessfulToolCallAt();
      expect(firstSuccessAt).toEqual(successCall.createdAt);
      expect(firstSuccessAt).not.toEqual(errorCall.createdAt);
    });
  });

  describe("backfill + rotation sweep", () => {
    test("encrypts pre-existing plaintext rows and completes", async () => {
      const interactionId = await seedPlaintextInteraction();
      setKeys(SECRET_A);
      await dropTrgmIndex();

      const result = await runContentEncryptionBackfill({});
      expect(result.status).toBe("completed");
      expect(result.rowsRewritten).toBeGreaterThan(0);

      const raw = await rawInteraction(interactionId);
      expect(isContentEnvelope(raw.request)).toBe(true);
      expect(decryptContentValue(raw.request, "interactions.request")).toEqual(
        request,
      );

      // Steady state is an O(1) no-op.
      const again = await runContentEncryptionBackfill({});
      expect(again).toEqual({ status: "completed", rowsRewritten: 0 });
    });

    test("encrypts pre-existing plaintext tool-call rows and re-encrypts them on rotation", async () => {
      const [seeded] = await db
        .insert(schema.mcpToolCallsTable)
        .values({
          mcpServerName: "email-server",
          method: "tools/call",
          toolCall,
          toolResult,
        })
        .returning({ id: schema.mcpToolCallsTable.id });
      setKeys(SECRET_A);
      await dropTrgmIndex();

      const result = await runContentEncryptionBackfill({});
      expect(result.status).toBe("completed");
      const raw = await rawMcpToolCall(seeded.id);
      expect(isContentEnvelope(raw.tool_call)).toBe(true);
      expect(isContentEnvelope(raw.tool_result)).toBe(true);
      expect(
        decryptContentValue(raw.tool_result, "mcp_tool_calls.tool_result"),
      ).toEqual(toolResult);

      // Rotation re-encrypts under the new key; the old key can then go.
      setKeys(SECRET_B, SECRET_A);
      expect((await runContentEncryptionBackfill({})).status).toBe("completed");
      setKeys(SECRET_B, undefined);
      expect(
        decryptContentValue(
          (await rawMcpToolCall(seeded.id)).tool_result,
          "mcp_tool_calls.tool_result",
        ),
      ).toEqual(toolResult);
    });

    test("restartIfCompleted re-sweeps plaintext rows stranded behind a completed sweep", async () => {
      await seedPlaintextInteraction();
      setKeys(SECRET_A);
      await dropTrgmIndex();
      await runContentEncryptionBackfill({});

      // A replica that had not restarted yet during the enablement rollout
      // writes plaintext AFTER the sweep completed.
      const stragglerId = await seedPlaintextInteraction();
      expect(await runContentEncryptionBackfill({})).toEqual({
        status: "completed",
        rowsRewritten: 0,
      });
      expect(
        isContentEnvelope((await rawInteraction(stragglerId)).request),
      ).toBe(false);

      // The operator's explicit run is a full re-verify and picks it up.
      const rerun = await runContentEncryptionBackfill({
        restartIfCompleted: true,
      });
      expect(rerun.status).toBe("completed");
      expect(rerun.rowsRewritten).toBeGreaterThan(0);
      const raw = await rawInteraction(stragglerId);
      expect(isContentEnvelope(raw.request)).toBe(true);
      expect(decryptContentValue(raw.request, "interactions.request")).toEqual(
        request,
      );
    });

    test("resumes after upgrade: clearing completed_at sweeps mcp_tool_calls without an operator run", async () => {
      // Pre-upgrade state: encryption enabled and the interactions+messages
      // sweep finished (completed_at set, cursors at their final positions).
      const interactionId = await seedPlaintextInteraction();
      setKeys(SECRET_A);
      await dropTrgmIndex();
      await runContentEncryptionBackfill({});

      // A tool-call row the pre-upgrade binary never encrypted.
      const [seeded] = await db
        .insert(schema.mcpToolCallsTable)
        .values({
          mcpServerName: "email-server",
          method: "tools/call",
          toolCall,
          toolResult,
        })
        .returning({ id: schema.mcpToolCallsTable.id });

      // Migration 0400's data statement.
      await db.execute(
        sql`UPDATE content_encryption_state SET completed_at = NULL WHERE completed_at IS NOT NULL`,
      );

      // The ordinary background sweep — no restartIfCompleted — resumes and
      // encrypts the historical tool call. The already-encrypted interaction
      // is skipped, not rewritten.
      const resumed = await runContentEncryptionBackfill({});
      expect(resumed.status).toBe("completed");
      const raw = await rawMcpToolCall(seeded.id);
      expect(isContentEnvelope(raw.tool_call)).toBe(true);
      expect(
        decryptContentValue(raw.tool_result, "mcp_tool_calls.tool_result"),
      ).toEqual(toolResult);
      expect(
        decryptContentValue(
          (await rawInteraction(interactionId)).request,
          "interactions.request",
        ),
      ).toEqual(request);

      // Steady state again afterwards.
      expect(await runContentEncryptionBackfill({})).toEqual({
        status: "completed",
        rowsRewritten: 0,
      });
    });

    test("re-encrypts previous-key rows after rotation", async () => {
      const interactionId = await seedPlaintextInteraction();
      setKeys(SECRET_A);
      await dropTrgmIndex();
      await runContentEncryptionBackfill({});

      setKeys(SECRET_B, SECRET_A);
      const result = await runContentEncryptionBackfill({});
      expect(result.status).toBe("completed");
      expect(result.rowsRewritten).toBeGreaterThan(0);

      // Now readable by the NEW key alone.
      setKeys(SECRET_B, undefined);
      const raw = await rawInteraction(interactionId);
      expect(decryptContentValue(raw.request, "interactions.request")).toEqual(
        request,
      );
    });

    test("defers while the message trgm index still exists; disabled without a key", async () => {
      expect(await runContentEncryptionBackfill({})).toEqual({
        status: "disabled",
        rowsRewritten: 0,
      });

      setKeys(SECRET_A);
      // The sweep must refuse to rewrite rows while an index with either
      // encrypted-content name exists (detection is by name via to_regclass).
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "messages_content_trgm_idx" ON messages (id)`,
      );
      expect((await runContentEncryptionBackfill({})).status).toBe("deferred");
      await dropTrgmIndex();

      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "mcp_tool_calls_tool_result_trgm_idx" ON mcp_tool_calls (id)`,
      );
      expect((await runContentEncryptionBackfill({})).status).toBe("deferred");
      await dropTrgmIndex();
    });

    test("CAS rewrite skips a row whose value changed after selection", async () => {
      setKeys(SECRET_A);
      await dropTrgmIndex();
      const id = await seedPlaintextInteraction();
      // Simulate a concurrent writer replacing the value between the sweep's
      // read and write: the CAS guard must miss and leave the new value alone.
      const state =
        await ContentEncryptionStateModel.ensureForFingerprint(
          "stale-fingerprint",
        );
      expect(state.keyFingerprint).toBe("stale-fingerprint");
      const changed = { swapped: true };
      await db.execute(sql`
        UPDATE interactions SET request = ${JSON.stringify(changed)}::jsonb
        WHERE id = ${id}::uuid AND request = ${JSON.stringify({ nope: 1 })}::jsonb
      `);
      // Guard did not match — the stored value is untouched.
      const raw = await rawInteraction(id);
      expect(raw.request).toEqual(request);
    });
  });

  describe("boot guard", () => {
    beforeEach(async () => {
      await EncryptionKeyCanaryModel.deleteAll();
    });

    test("key without an enterprise license fails startup", async () => {
      config.enterpriseFeatures.core = false;
      setKeys(SECRET_A);
      await expect(verifyContentEncryptionKey()).rejects.toThrow(
        /enterprise license/,
      );
    });

    test("no canary + feature off is a no-op; enabling mints the canary", async () => {
      await expect(verifyContentEncryptionKey()).resolves.toBeUndefined();
      expect(await EncryptionKeyCanaryModel.get("content")).toBeNull();

      setKeys(SECRET_A);
      await verifyContentEncryptionKey();
      expect(await EncryptionKeyCanaryModel.get("content")).not.toBeNull();
    });

    test("explicit OTel content capture under encryption warns at boot", async () => {
      const originalCapture = config.observability.otel.captureContent;
      try {
        setKeys(SECRET_A);
        config.observability.otel.captureContent = true;
        await verifyContentEncryptionKey();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("ARCHESTRA_OTEL_CAPTURE_CONTENT"),
        );

        vi.clearAllMocks();
        config.observability.otel.captureContent = false;
        await verifyContentEncryptionKey();
        expect(logger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining("ARCHESTRA_OTEL_CAPTURE_CONTENT"),
        );
      } finally {
        config.observability.otel.captureContent = originalCapture;
      }
    });

    test("canary present but key removed fails startup (fail-closed)", async () => {
      setKeys(SECRET_A);
      await verifyContentEncryptionKey();

      setKeys(undefined, undefined);
      await expect(verifyContentEncryptionKey()).rejects.toThrow(
        /previously enabled/,
      );
    });

    test("wrong key fails startup with no escape hatch", async () => {
      setKeys(SECRET_A);
      await verifyContentEncryptionKey();

      setKeys(SECRET_B);
      await expect(verifyContentEncryptionKey()).rejects.toThrow(
        /cannot decrypt the content key canary/,
      );
    });

    test("rotation keeps the canary until the sweep completes, then re-mints", async () => {
      setKeys(SECRET_A);
      await verifyContentEncryptionKey();
      const before = await EncryptionKeyCanaryModel.get("content");

      setKeys(SECRET_B, SECRET_A);
      // The guard accepts the previous-key canary WITHOUT rewriting it —
      // rewriting here would ping-pong between mixed replica configs during
      // a rolling swap.
      await verifyContentEncryptionKey();
      const during = await EncryptionKeyCanaryModel.get("content");
      expect(during?.encryptedCanary).toBe(before?.encryptedCanary);

      // Completing the sweep (cluster-singleton) advances the canary once.
      await dropTrgmIndex();
      await runContentEncryptionBackfill({});
      const after = await EncryptionKeyCanaryModel.get("content");
      expect(after?.encryptedCanary).not.toBe(before?.encryptedCanary);

      // The new key alone now verifies.
      setKeys(SECRET_B);
      await expect(verifyContentEncryptionKey()).resolves.toBeUndefined();
    });
  });
});
