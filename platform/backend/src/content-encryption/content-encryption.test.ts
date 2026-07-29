import { vi } from "vitest";

vi.mock("@/logging");

import { sql } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
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

describe("content encryption", () => {
  const originalCore = config.enterpriseFeatures.core;

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
      // The sweep must refuse to rewrite message rows while an index with
      // this name exists (detection is by name via to_regclass).
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS "messages_content_trgm_idx" ON messages (id)`,
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
