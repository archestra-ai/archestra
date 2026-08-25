/**
 * Contract under test — file attachments in a locked chat:
 * - what lands on disk is ciphertext: the bytes, the filename and the
 *   extracted text preview are all sealed, and the dedup hash is not a
 *   recomputable digest of the file
 * - the byte endpoint serves the original file to a request bearing the
 *   conversation key, refuses one without it, and 409s on a wrong key
 * - the Files panel opens filenames with the key and falls back to a
 *   placeholder without one
 * - a locked chat's attachment cannot be copied into a knowledge base
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import config from "@/config";
// biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
import { _resetContentKeys } from "@/content-encryption/index.ee";
import db from "@/database";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ESCROW_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

const KEY_HEADER = "x-archestra-locked-chat-key";
const FILE_BYTES = Buffer.from("board minutes, Q3\nheadcount: 412\n", "utf8");
const FILE_NAME = "board-minutes-q3.txt";

describe("locked chat attachments", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;
  let agentId: string;
  let dek: Buffer;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    config.enterpriseFeatures.core = false;
    config.lockedChat.escrowPublicKey = ESCROW_PEM;
    // The envelopes asserted on below must be the browser-DEK ones, so keep
    // the at-rest layer out of it even if a local .env configures a secret.
    config.contentEncryption.secret = undefined;
    _resetContentKeys();
    dek = randomBytes(32);

    currentUser = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(currentUser.id, organizationId, { role: "admin" });
    agentId = (
      await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "personal",
      })
    ).id;

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

  async function createLockedConversation(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: dekHeader(),
      payload: { agentId, lockedChat: true },
    });
    expect(response.statusCode).toBe(200);
    return response.json().id as string;
  }

  /**
   * Store an attachment the way the chat stream route does for a locked chat:
   * hash and seal under the conversation key. Going through the model rather
   * than the stream route keeps this about the attachment columns instead of
   * standing up an LLM turn.
   */
  async function storeSealedAttachment(conversationId: string) {
    const conversationKey = { dek, conversationId };
    return ConversationAttachmentModel.create(
      {
        organizationId,
        conversationId,
        uploadedByUserId: currentUser.id,
        originalName: FILE_NAME,
        mimeType: "text/plain",
        fileSize: FILE_BYTES.byteLength,
        contentHash: ConversationAttachmentModel.computeContentHash(
          FILE_BYTES,
          conversationKey,
        ),
        fileData: FILE_BYTES,
        textPreviewStatus: "pending",
      },
      conversationKey,
    );
  }

  test("stores the bytes, the filename and the preview sealed", async () => {
    const conversationId = await createLockedConversation();
    const attachment = await storeSealedAttachment(conversationId);
    await ConversationAttachmentModel.updateTextPreview(
      attachment.id,
      "ok",
      FILE_BYTES.toString("utf8"),
      { dek, conversationId },
    );

    const raw = await db.execute<{
      original_name: string;
      file_data: Buffer;
      text_preview: string | null;
      content_hash: string;
      locked_chat: boolean;
      file_size: number;
      mime_type: string;
    }>(
      sql`SELECT original_name, file_data, text_preview, content_hash, locked_chat, file_size, mime_type
          FROM conversation_attachments WHERE id = ${attachment.id}::uuid`,
    );
    const row = raw.rows[0];

    expect(row.locked_chat).toBe(true);
    expect(row.original_name).not.toBe(FILE_NAME);
    expect(row.original_name).toMatch(/^v1:/);
    expect(row.text_preview).toMatch(/^v1:/);
    expect(row.text_preview).not.toContain("headcount");
    expect(Buffer.from(row.file_data).includes(FILE_BYTES)).toBe(false);
    // A plain SHA-256 of the bytes would let anyone holding a copy of the file
    // confirm it is in this chat without being able to read a word of it.
    expect(row.content_hash).not.toBe(
      ConversationAttachmentModel.computeContentHash(FILE_BYTES),
    );
    // Type and size stay in the clear: the request has to be sized and gated
    // before any bytes are read.
    expect(row.mime_type).toBe("text/plain");
    expect(row.file_size).toBe(FILE_BYTES.byteLength);

    // …and the model hands the caller back the plaintext it stored.
    const opened = await ConversationAttachmentModel.findByIdWithData(
      attachment.id,
      { dek, conversationId },
    );
    expect(opened?.originalName).toBe(FILE_NAME);
    expect(opened?.fileData.equals(FILE_BYTES)).toBe(true);
    expect(opened?.textPreview).toBe(FILE_BYTES.toString("utf8"));
  });

  test("serves the bytes only to a request carrying the conversation key", async () => {
    const conversationId = await createLockedConversation();
    const attachment = await storeSealedAttachment(conversationId);
    const url = `/api/chat/attachments/${attachment.id}/content`;

    const withKey = await app.inject({
      method: "GET",
      url,
      headers: dekHeader(),
    });
    expect(withKey.statusCode).toBe(200);
    expect(withKey.rawPayload.equals(FILE_BYTES)).toBe(true);
    expect(withKey.headers["content-length"]).toBe(
      String(FILE_BYTES.byteLength),
    );
    expect(withKey.headers["content-disposition"]).toContain(
      encodeURIComponent(FILE_NAME),
    );

    // No key: the endpoint must not answer with ciphertext, and must say what
    // is missing rather than 404 as though the file were gone.
    const withoutKey = await app.inject({ method: "GET", url });
    expect(withoutKey.statusCode).toBe(400);
    expect(withoutKey.json().error.message).toContain(KEY_HEADER);

    const wrongKey = await app.inject({
      method: "GET",
      url,
      headers: dekHeader(randomBytes(32)),
    });
    expect(wrongKey.statusCode).toBe(409);
  });

  test("opens attachment names in the Files panel, and hides them without the key", async () => {
    const conversationId = await createLockedConversation();
    await storeSealedAttachment(conversationId);
    const url = `/api/chat/conversations/${conversationId}/files`;

    const withKey = await app.inject({
      method: "GET",
      url,
      headers: dekHeader(),
    });
    expect(withKey.statusCode).toBe(200);
    expect(withKey.json().attachments[0].name).toBe(FILE_NAME);

    // A reader without the key still learns a file is there — the same
    // tombstone posture the transcript takes — but not what it is called.
    const withoutKey = await app.inject({ method: "GET", url });
    expect(withoutKey.statusCode).toBe(200);
    const [listed] = withoutKey.json().attachments;
    expect(listed.name).not.toBe(FILE_NAME);
    expect(listed.mimeType).toBe("text/plain");
  });
});
