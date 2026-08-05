// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Contract under test — incognito conversations at the route level:
 * - creation is gated on an EE license + configured escrow key + a valid
 *   32-byte key header, and stores fingerprint + escrow but never the raw key
 * - message content at rest is an envelope only the browser-held key opens;
 *   GET decrypts with the key, returns the locked shape without it, and 409s
 *   on a wrong key
 * - the sidebar list carries no message content for incognito rows
 * - share/fork/compact/projects/title-generation are rejected or no-op
 * - the at-rest backfill sweep never rewrites incognito envelopes
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
  isContentEnvelope,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
} from "@/content-encryption/index.ee";
import db from "@/database";
import MessageModel from "@/models/message";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const ESCROW_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

const KEY_HEADER = "x-archestra-incognito-key";

describe("incognito conversation routes", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;
  let agentId: string;
  let dek: Buffer;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    config.enterpriseFeatures.core = true;
    config.chatIncognito.escrowPublicKey = ESCROW_PEM;
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

  async function createIncognitoConversation(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: dekHeader(),
      payload: { agentId, incognito: true },
    });
    expect(response.statusCode).toBe(200);
    return response.json().id as string;
  }

  describe("POST /api/chat/conversations (incognito)", () => {
    test("rejects without an enterprise license", async () => {
      config.enterpriseFeatures.core = false;
      const response = await app.inject({
        method: "POST",
        url: "/api/chat/conversations",
        headers: dekHeader(),
        payload: { agentId, incognito: true },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain("enterprise");
    });

    test("rejects without a configured escrow key", async () => {
      config.chatIncognito.escrowPublicKey = undefined;
      const response = await app.inject({
        method: "POST",
        url: "/api/chat/conversations",
        headers: dekHeader(),
        payload: { agentId, incognito: true },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain(
        "ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY",
      );
    });

    test("rejects a missing or malformed key header", async () => {
      const missing = await app.inject({
        method: "POST",
        url: "/api/chat/conversations",
        payload: { agentId, incognito: true },
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.message).toContain(KEY_HEADER);

      const short = await app.inject({
        method: "POST",
        url: "/api/chat/conversations",
        headers: { [KEY_HEADER]: randomBytes(8).toString("base64url") },
        payload: { agentId, incognito: true },
      });
      expect(short.statusCode).toBe(400);
      expect(short.json().error.message).toContain("32 bytes");
    });

    test("rejects incognito in a project", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/chat/conversations",
        headers: dekHeader(),
        payload: {
          agentId,
          incognito: true,
          projectId: "33333333-3333-4333-8333-333333333333",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("project");
    });

    test("stores fingerprint + recoverable escrow, static title, and never the raw key", async () => {
      const id = await createIncognitoConversation();

      const body = (
        await app.inject({
          method: "GET",
          url: `/api/chat/conversations/${id}`,
          headers: dekHeader(),
        })
      ).json();
      expect(body.incognito).toBe(true);
      expect(body.title).toBe("Incognito chat");
      // Server-side bookkeeping never reaches the API response.
      expect(body.incognitoEscrow).toBeUndefined();
      expect(body.incognitoDekFingerprint).toBeUndefined();

      const raw = await db.execute<{
        incognito: boolean;
        incognito_dek_fingerprint: string | null;
        incognito_escrow: {
          v: number;
          alg: string;
          wrappedDek: string;
        } | null;
      }>(
        sql`SELECT incognito, incognito_dek_fingerprint, incognito_escrow FROM conversations WHERE id = ${id}::uuid`,
      );
      const row = raw.rows[0];
      expect(row.incognito).toBe(true);
      expect(row.incognito_dek_fingerprint).toBeTruthy();
      // The fingerprint is a digest, not the key.
      expect(row.incognito_dek_fingerprint).not.toContain(
        dek.toString("base64url"),
      );
      // The escrow blob is independently recoverable with the private key —
      // the break-glass contract.
      expect(row.incognito_escrow?.alg).toBe("RSA-OAEP-256");
      const recovered = privateDecrypt(
        {
          key: privateKey,
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(row.incognito_escrow?.wrappedDek ?? "", "base64"),
      );
      expect(recovered.equals(dek)).toBe(true);
    });
  });

  describe("GET /api/chat/conversations/:id (incognito)", () => {
    test("decrypts with the key; locked without it; 409 on a wrong key", async () => {
      const id = await createIncognitoConversation();
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

    test("the conversations list carries no message content for incognito rows", async ({
      makeConversation,
    }) => {
      const id = await createIncognitoConversation();
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
        incognito: boolean;
        messages: unknown[];
      }>;
      const incognitoRow = rows.find((r) => r.id === id);
      expect(incognitoRow?.incognito).toBe(true);
      expect(list.body).not.toContain("listable secret");
    });
  });

  describe("disabled features", () => {
    test("share, fork, and compact are rejected; title generation is a no-op", async () => {
      const id = await createIncognitoConversation();

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
      expect(title.json().title).toBe("Incognito chat");
    });
  });

  describe("at-rest backfill interaction", () => {
    test("the server-key sweep completes without rewriting incognito envelopes", async () => {
      const id = await createIncognitoConversation();
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

      // Enable server-side content encryption and run the sweep to completion.
      config.contentEncryption.secret = "server-secret-01234567890123456789";
      _resetContentKeys();
      try {
        await db.execute(sql`DROP INDEX IF EXISTS "messages_content_trgm_idx"`);
        await db.execute(
          sql`DROP INDEX IF EXISTS "mcp_tool_calls_tool_result_trgm_idx"`,
        );
        const result = await runContentEncryptionBackfill({});
        expect(result.status).toBe("completed");

        // The incognito envelope is byte-identical: skipped, not re-wrapped.
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
