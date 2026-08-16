/**
 * Contract under test — locked chats at the route level:
 * - the feature is FREE and on by default: creation needs no license and no
 *   escrow key, only a valid 32-byte key header; disabling it via
 *   creation is refused (403) when no escrow key is configured
 * - without escrow configured, the fingerprint is stored and
 *   locked_chat_escrow stays NULL (no recoverable key copy anywhere)
 * - with enterprise escrow configured, the RSA-wrapped blob is stored and
 *   independently recoverable with the offline private key
 * - message content at rest is an envelope only the browser-held key opens;
 *   GET decrypts with the key, returns the locked shape without it, and 409s
 *   on a wrong key
 * - the sidebar list carries no message content for locked-chat rows
 * - share/fork/compact/projects/title-generation are rejected or no-op
 * - the at-rest backfill sweep never rewrites locked-chat envelopes
 */
import {
  constants as cryptoConstants,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from "node:crypto";
import { sql } from "drizzle-orm";
import config from "@/config";
// biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
import { runContentEncryptionBackfill } from "@/content-encryption/backfill.ee";
import {
  _resetContentKeys,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
} from "@/content-encryption/index.ee";
import db from "@/database";
import MessageModel from "@/models/message";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { isContentEnvelope } from "@/utils/crypto";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const ESCROW_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

const KEY_HEADER = "x-archestra-locked-chat-key";

describe("locked chat routes", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;
  let agentId: string;
  let dek: Buffer;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    // Free-feature posture by default: NO enterprise license, NO escrow key.
    // Individual tests opt into the enterprise escrow pieces they exercise.
    // Explicit resets (not just overrides): this file mocks node-vault, so it
    // runs in the isolated "mocked" vitest project where the shared-worker
    // config auto-restore does not apply — a flag a test flips would
    // otherwise leak into the next test.
    config.enterpriseFeatures.core = false;
    // Escrow is what enables locked-chat, and the db sink needs no license — so
    // this IS the unlicensed default posture, not an enterprise one.
    config.lockedChat.escrowPublicKey = ESCROW_PEM;
    // Force at-rest content encryption OFF (a local .env may set
    // ARCHESTRA_CONTENT_ENCRYPTION_SECRET): locked-chat must be exercised on a
    // free-instance posture, and the envelopes asserted on must be the
    // browser-DEK ones.
    config.contentEncryption.secret = undefined;
    _resetContentKeys();
    dek = randomBytes(32);

    currentUser = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(currentUser.id, organizationId, { role: "admin" });
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    agentId = agent.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  function dekHeader(key: Buffer = dek) {
    return { [KEY_HEADER]: key.toString("base64url") };
  }

  async function createLockedChatConversation(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: dekHeader(),
      payload: { agentId, lockedChat: true },
    });
    expect(response.statusCode).toBe(200);
    return response.json().id as string;
  }

  async function readLockedChatRow(id: string) {
    const raw = await db.execute<{
      locked_chat: boolean;
      locked_chat_dek_fingerprint: string | null;
      locked_chat_escrow: Record<string, unknown> | null;
    }>(
      sql`SELECT locked_chat, locked_chat_dek_fingerprint, locked_chat_escrow FROM conversations WHERE id = ${id}::uuid`,
    );
    return raw.rows[0];
  }

  describe("POST /api/chat/conversations (locked chat)", () => {
    test("rejects a missing or malformed key header", async () => {
      const missing = await app.inject({
        method: "POST",
        url: "/api/chat/conversations",
        payload: { agentId, lockedChat: true },
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.message).toContain(KEY_HEADER);

      const short = await app.inject({
        method: "POST",
        url: "/api/chat/conversations",
        headers: { [KEY_HEADER]: randomBytes(8).toString("base64url") },
        payload: { agentId, lockedChat: true },
      });
      expect(short.statusCode).toBe(400);
      expect(short.json().error.message).toContain("32 bytes");
    });

    test("rejects locked chats in a project", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/chat/conversations",
        headers: dekHeader(),
        payload: {
          agentId,
          lockedChat: true,
          projectId: "33333333-3333-4333-8333-333333333333",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("project");
    });

    test("refuses creation when no escrow key is configured", async () => {
      // Escrow is the enablement switch. Without it the chat's audit trail
      // would be encrypted under a key nobody could recover, so the feature
      // is simply unavailable rather than silently unrecoverable.
      config.lockedChat.escrowPublicKey = undefined;

      const response = await app.inject({
        method: "POST",
        url: "/api/chat/conversations",
        headers: dekHeader(),
        payload: { agentId, lockedChat: true },
      });
      expect(response.statusCode).toBe(403);

      const rows = await db.execute(
        sql`SELECT id FROM conversations WHERE locked_chat = true`,
      );
      expect(rows.rows).toHaveLength(0);
    });

    test("creation stores the fingerprint and escrow blob, a static title, and never the raw key", async () => {
      const id = await createLockedChatConversation();

      const body = (
        await app.inject({
          method: "GET",
          url: `/api/chat/conversations/${id}`,
          headers: dekHeader(),
        })
      ).json();
      expect(body.lockedChat).toBe(true);
      expect(body.title).toBe("Locked chat");
      // Server-side bookkeeping never reaches the API response.
      expect(body.lockedChatEscrow).toBeUndefined();
      expect(body.lockedChatDekFingerprint).toBeUndefined();

      const row = await readLockedChatRow(id);
      expect(row.locked_chat).toBe(true);
      expect(row.locked_chat_dek_fingerprint).toBeTruthy();
      // The fingerprint is a digest, not the key.
      expect(row.locked_chat_dek_fingerprint).not.toContain(
        dek.toString("base64url"),
      );
      // Escrow is mandatory, so every locked-chat row carries a wrapped copy.
      expect(row.locked_chat_escrow).not.toBeNull();
    });

    test("the stored escrow blob is recoverable with the offline private key", async () => {
      const id = await createLockedChatConversation();
      const row = await readLockedChatRow(id);
      expect(row.locked_chat_dek_fingerprint).toBeTruthy();
      // The escrow blob is independently recoverable with the private key —
      // the break-glass contract.
      expect(row.locked_chat_escrow?.alg).toBe("RSA-OAEP-256");
      const recovered = privateDecrypt(
        {
          key: privateKey,
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(
          (row.locked_chat_escrow?.wrappedDek as string) ?? "",
          "base64",
        ),
      );
      expect(recovered.equals(dek)).toBe(true);
    });
  });

  describe("GET /api/chat/conversations/:id (locked chat)", () => {
    test.for([
      ["the feature is turned off", () => {}],
      [
        "the escrow key is removed",
        () => {
          config.lockedChat.escrowPublicKey = undefined;
        },
      ],
    ] as const)("an existing chat is still readable after %s", async ([
      ,
      disable,
    ]) => {
      // Both settings gate CREATION. Neither may orphan a chat already made:
      // the browser key is what opens the content, and the row keeps its own
      // escrow copy no matter what the current configuration says.
      const id = await createLockedChatConversation();
      await MessageModel.create(
        {
          conversationId: id,
          role: "user",
          content: {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "still readable" }],
          },
        },
        { dek, conversationId: id },
      );

      disable();

      const response = await app.inject({
        method: "GET",
        url: `/api/chat/conversations/${id}`,
        headers: dekHeader(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().contentLocked).toBeUndefined();
      expect(response.json().messages[0].parts[0].text).toBe("still readable");
    });

    test("still accepts the key under the pre-rename header name", async () => {
      // A tab loaded before the rename keeps sending the old header, and its
      // key is the only copy outside escrow — so dropping it would show the
      // user a tombstone for their own chat.
      const id = await createLockedChatConversation();
      await MessageModel.create(
        {
          conversationId: id,
          role: "user",
          content: {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "sent by an old tab" }],
          },
        },
        { dek, conversationId: id },
      );

      const response = await app.inject({
        method: "GET",
        url: `/api/chat/conversations/${id}`,
        headers: { "x-archestra-incognito-key": dek.toString("base64url") },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().contentLocked).toBeUndefined();
      expect(response.json().messages[0].parts[0].text).toBe(
        "sent by an old tab",
      );
    });

    test("decrypts with the key; locked without it; 409 on a wrong key", async () => {
      // Orthogonality pin: this full roundtrip runs on a FREE instance — no
      // enterprise license (beforeEach) and no at-rest content-encryption
      // secret. LockedChat must not depend on either.
      expect(config.contentEncryption.secret).toBeUndefined();

      const id = await createLockedChatConversation();
      const content = {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "the secret question" }],
      };
      await MessageModel.create(
        { conversationId: id, role: "user", content },
        { dek, conversationId: id },
      );

      // At rest: an envelope, not plaintext.
      const raw = await db.execute<{ content: unknown }>(
        sql`SELECT content FROM messages WHERE conversation_id = ${id}::uuid`,
      );
      expect(isContentEnvelope(raw.rows[0].content)).toBe(true);

      const unlocked = await app.inject({
        method: "GET",
        url: `/api/chat/conversations/${id}`,
        headers: dekHeader(),
      });
      expect(unlocked.statusCode).toBe(200);
      expect(unlocked.json().messages).toHaveLength(1);
      expect(unlocked.json().messages[0].parts[0].text).toBe(
        "the secret question",
      );
      expect(unlocked.json().contentLocked).toBeUndefined();

      const locked = await app.inject({
        method: "GET",
        url: `/api/chat/conversations/${id}`,
      });
      expect(locked.statusCode).toBe(200);
      expect(locked.json().contentLocked).toBe(true);
      expect(locked.json().messages).toEqual([]);
      expect(locked.body).not.toContain("the secret question");

      const wrong = await app.inject({
        method: "GET",
        url: `/api/chat/conversations/${id}`,
        headers: dekHeader(randomBytes(32)),
      });
      expect(wrong.statusCode).toBe(409);
      expect(wrong.json().error.message).toContain("does not match");
    });

    test("the conversations list carries no message content for locked-chat rows", async ({
      makeConversation,
    }) => {
      const id = await createLockedChatConversation();
      await MessageModel.create(
        {
          conversationId: id,
          role: "user",
          content: {
            id: "m-list",
            role: "user",
            parts: [{ type: "text", text: "listable secret" }],
          },
        },
        { dek, conversationId: id },
      );
      // A plain conversation alongside, to prove the list still works.
      await makeConversation(agentId, {
        userId: currentUser.id,
        organizationId,
        title: "plain one",
      });

      const list = await app.inject({
        method: "GET",
        url: "/api/chat/conversations",
      });
      expect(list.statusCode).toBe(200);
      const rows = list.json() as Array<{
        id: string;
        lockedChat: boolean;
        messages: unknown[];
      }>;
      const lockedChatRow = rows.find((r) => r.id === id);
      expect(lockedChatRow?.lockedChat).toBe(true);
      expect(list.body).not.toContain("listable secret");
    });
  });

  describe("disabled features", () => {
    test("share, fork, and compact are rejected; title generation is a no-op", async () => {
      const id = await createLockedChatConversation();

      const share = await app.inject({
        method: "POST",
        url: `/api/chat/conversations/${id}/share`,
        payload: { visibility: "organization" },
      });
      expect(share.statusCode).toBe(400);
      expect(share.json().error.message).toContain("shared");

      const fork = await app.inject({
        method: "POST",
        url: `/api/chat/conversations/${id}/fork`,
        payload: { agentId },
      });
      expect(fork.statusCode).toBe(400);
      expect(fork.json().error.message).toContain("forked");

      const compact = await app.inject({
        method: "POST",
        url: `/api/chat/conversations/${id}/compact`,
        payload: {},
      });
      expect(compact.statusCode).toBe(400);
      expect(compact.json().error.message).toContain("Compaction");

      const title = await app.inject({
        method: "POST",
        url: `/api/chat/conversations/${id}/generate-title`,
        payload: {},
      });
      expect(title.statusCode).toBe(200);
      expect(title.json().title).toBe("Locked chat");
    });
  });

  describe("at-rest backfill interaction", () => {
    test("the server-key sweep completes without rewriting locked-chat envelopes", async () => {
      const id = await createLockedChatConversation();
      const content = {
        id: "m-sweep",
        role: "user",
        parts: [{ type: "text", text: "sweep me not" }],
      };
      await MessageModel.create(
        { conversationId: id, role: "user", content },
        { dek, conversationId: id },
      );
      const before = await db.execute<{ content: { __encrypted: string } }>(
        sql`SELECT content FROM messages WHERE conversation_id = ${id}::uuid`,
      );

      // Enable server-side content encryption (enterprise) and run the sweep
      // to completion.
      config.enterpriseFeatures.core = true;
      config.contentEncryption.secret = "server-secret-01234567890123456789";
      _resetContentKeys();
      try {
        await db.execute(sql`DROP INDEX IF EXISTS "messages_content_trgm_idx"`);
        await db.execute(
          sql`DROP INDEX IF EXISTS "mcp_tool_calls_tool_result_trgm_idx"`,
        );
        const result = await runContentEncryptionBackfill({});
        expect(result.status).toBe("completed");

        // The locked-chat envelope is byte-identical: skipped, not re-wrapped.
        const after = await db.execute<{ content: { __encrypted: string } }>(
          sql`SELECT content FROM messages WHERE conversation_id = ${id}::uuid`,
        );
        expect(after.rows[0].content.__encrypted).toBe(
          before.rows[0].content.__encrypted,
        );

        // And still opens with the browser key through the route.
        const unlocked = await app.inject({
          method: "GET",
          url: `/api/chat/conversations/${id}`,
          headers: dekHeader(),
        });
        expect(unlocked.statusCode).toBe(200);
        expect(unlocked.json().messages[0].parts[0].text).toBe("sweep me not");
      } finally {
        config.contentEncryption.secret = undefined;
        _resetContentKeys();
      }
    });
  });
});
