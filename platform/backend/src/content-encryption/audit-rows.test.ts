/**
 * Contract under test — the single funnel that decides which key an audit
 * row's content is written under, and the locked-safe read path that keeps a
 * row nobody here can open from breaking a logs page.
 */
import { randomBytes } from "node:crypto";
import {
  isLockedChatRedactedContent,
  isLockedChatSealedContent,
  LOCKED_CHAT_REDACTED_MARKER,
} from "@archestra/shared";
import { sql } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { InteractionRequest, InteractionResponse } from "@/types";
import { isContentEnvelope } from "@/utils/crypto";
import {
  encryptInteractionContent,
  encryptMcpToolCallContent,
  readInteractionRow,
  readMcpToolCallRow,
} from "./audit-rows";
// biome-ignore lint/style/noRestrictedImports: dual-licensed; the funnel's non-locked-chat branch IS the at-rest layer
import { runContentEncryptionBackfill } from "./backfill.ee";
import {
  _resetContentKeys,
  decryptContentValue,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
} from "./index.ee";
import { decryptLockedChatValue } from "./locked-chat";
import {
  decryptInteractionRow,
  decryptMcpToolCallRow,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
} from "./rows.ee";

const SERVER_SECRET = "audit-rows-server-secret-0123456789";
const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

const request = {
  model: "claude-sonnet-5",
  messages: [{ role: "user", content: "the private question" }],
} as unknown as InteractionRequest;
const response = {
  id: "r1",
  content: [{ type: "text", text: "the private answer" }],
} as unknown as InteractionResponse;
const toolCall = { id: "call-1", name: "read_email", arguments: { n: 1 } };
const toolResult = {
  id: "call-1",
  content: [{ type: "text", text: "the private inbox" }],
  isError: false,
};

/** Turn server-key at-rest encryption on or off for the current test. */
function setServerKey(secret: string | undefined) {
  config.contentEncryption.secret = secret;
  config.contentEncryption.secretPrevious = undefined;
  _resetContentKeys();
}

describe("audit row content funnel", () => {
  let audit: { dek: Buffer; conversationId: string };

  beforeEach(() => {
    config.enterpriseFeatures.core = true;
    // A developer .env may set ARCHESTRA_CONTENT_ENCRYPTION_SECRET; pin the
    // at-rest layer OFF explicitly so each test states its own posture.
    setServerKey(undefined);
    audit = { dek: randomBytes(32), conversationId: CONVERSATION_ID };
  });

  afterEach(() => {
    // The derived-key cache is module-level and outlives the shared setup's
    // config restore, so it must be cleared by hand or it leaks to later files.
    setServerKey(undefined);
  });

  describe("write path", () => {
    test("an audit context encrypts under the DEK and stamps the row, even with the server key active", () => {
      // Server-key encryption ON: the two paths are exclusive-or, so the
      // stored value must be openable by the CONVERSATION key, not the
      // server key, and must not be wrapped twice.
      setServerKey(SERVER_SECRET);

      const values = encryptInteractionContent(
        { request, response, type: "anthropic:messages" },
        audit,
      ) as Record<string, unknown>;

      expect(isContentEnvelope(values.request)).toBe(true);
      expect(isContentEnvelope(values.response)).toBe(true);
      expect(values.lockedChatConversationId).toBe(CONVERSATION_ID);

      // The server key cannot open it...
      expect(() =>
        decryptContentValue(values.request, "interactions.request"),
      ).toThrow();

      // ...the conversation key can, and one unwrap yields the ORIGINAL value.
      // Callers hand plaintext to the funnel; a caller-side pre-encrypt (or a
      // funnel that also ran the at-rest layer) would surface here as a
      // nested envelope.
      const opened = decryptLockedChatValue(values.request, {
        ...audit,
        context: "interactions.request",
      });
      expect(isContentEnvelope(opened)).toBe(false);
      expect(opened).toEqual(request);
      expect(
        decryptLockedChatValue(values.response, {
          ...audit,
          context: "interactions.response",
        }),
      ).toEqual(response);
    });

    test("tool-call content follows the same exclusive-or rule", () => {
      setServerKey(SERVER_SECRET);

      const values = encryptMcpToolCallContent(
        { mcpServerName: "email", method: "tools/call", toolCall, toolResult },
        audit,
      ) as Record<string, unknown>;

      expect(values.lockedChatConversationId).toBe(CONVERSATION_ID);
      expect(() =>
        decryptContentValue(values.toolResult, "mcp_tool_calls.tool_result"),
      ).toThrow();
      expect(
        decryptLockedChatValue(values.toolResult, {
          ...audit,
          context: "mcp_tool_calls.tool_result",
        }),
      ).toEqual(toolResult);
      // Metadata is untouched by either key.
      expect(values.mcpServerName).toBe("email");
    });

    test("without an audit context the row goes to the at-rest path and is never stamped", () => {
      // At-rest OFF: plaintext through, and crucially NO discriminator — a
      // stamped row would be read as locked and its content lost to readers.
      const plain = encryptInteractionContent(
        { request, response, type: "anthropic:messages" },
        null,
      ) as Record<string, unknown>;
      expect(plain.request).toEqual(request);
      expect(plain.lockedChatConversationId).toBeUndefined();

      // At-rest ON: a server-key envelope, still unstamped.
      setServerKey(SERVER_SECRET);
      const encrypted = encryptInteractionContent(
        { request, response, type: "anthropic:messages" },
        null,
      ) as Record<string, unknown>;
      expect(isContentEnvelope(encrypted.request)).toBe(true);
      expect(encrypted.lockedChatConversationId).toBeUndefined();
      expect(
        decryptContentValue(encrypted.request, "interactions.request"),
      ).toEqual(request);

      const toolValues = encryptMcpToolCallContent(
        { mcpServerName: "email", method: "tools/call", toolCall, toolResult },
        null,
      ) as Record<string, unknown>;
      expect(isContentEnvelope(toolValues.toolResult)).toBe(true);
      expect(toolValues.lockedChatConversationId).toBeUndefined();
    });

    test("null and absent content columns are left alone", () => {
      const values = encryptInteractionContent(
        {
          request,
          response: null,
          dualLlmAnalyses: null,
          unsafeContextBoundary: undefined,
        },
        audit,
      ) as Record<string, unknown>;

      // An envelope over null would be indistinguishable from real content on
      // the read side, and would show as locked instead of empty.
      expect(values.response).toBeNull();
      expect(values.dualLlmAnalyses).toBeNull();
      expect(values.unsafeContextBoundary).toBeUndefined();
      expect(isContentEnvelope(values.request)).toBe(true);

      const toolValues = encryptMcpToolCallContent(
        { toolCall: null, toolResult },
        audit,
      ) as Record<string, unknown>;
      expect(toolValues.toolCall).toBeNull();
      expect(isContentEnvelope(toolValues.toolResult)).toBe(true);
    });
  });

  describe("read path", () => {
    test("a locked interaction row reads as the locked sentinel instead of throwing", () => {
      const stored = encryptInteractionContent(
        { request, response, type: "anthropic:messages" },
        audit,
      ) as Record<string, unknown>;
      // A deployment that later turned server-key encryption on: the naive
      // read path now has a key, tries it, and blows up on this row.
      setServerKey(SERVER_SECRET);
      expect(() => decryptInteractionRow({ ...stored })).toThrow();

      // The locked-safe read never throws — one such row must not 500 a
      // whole logs page — and names the conversation whose escrow opens it.
      const read = readInteractionRow({ ...stored }) as Record<string, unknown>;
      expect(isLockedChatSealedContent(read.request)).toBe(true);
      expect(isLockedChatSealedContent(read.response)).toBe(true);
      expect(read.request).toEqual({ __lockedChatSealed: CONVERSATION_ID });
    });

    test("a locked tool-call row reads as locked under both column spellings", () => {
      const camel = encryptMcpToolCallContent(
        { toolCall, toolResult },
        audit,
      ) as Record<string, unknown>;
      setServerKey(SERVER_SECRET);
      expect(() => decryptMcpToolCallRow({ ...camel })).toThrow();

      const readCamel = readMcpToolCallRow({ ...camel }) as Record<
        string,
        unknown
      >;
      expect(isLockedChatSealedContent(readCamel.toolCall)).toBe(true);
      expect(isLockedChatSealedContent(readCamel.toolResult)).toBe(true);

      // Raw-SQL reads come back snake_case, including the discriminator; a
      // read site that only understood camelCase would fall through to a
      // server-key decrypt and throw.
      const snake = {
        tool_call: camel.toolCall,
        tool_result: camel.toolResult,
        locked_chat_conversation_id: CONVERSATION_ID,
      };
      const readSnake = readMcpToolCallRow({ ...snake }) as Record<
        string,
        unknown
      >;
      expect(isLockedChatSealedContent(readSnake.tool_call)).toBe(true);
      expect(readSnake.tool_result).toEqual({
        __lockedChatSealed: CONVERSATION_ID,
      });
    });

    test("an unstamped row takes the ordinary at-rest path", () => {
      setServerKey(SERVER_SECRET);
      const stored = encryptInteractionContent(
        { request, response, type: "anthropic:messages" },
        null,
      ) as Record<string, unknown>;

      const read = readInteractionRow({ ...stored }) as Record<string, unknown>;
      expect(read.request).toEqual(request);
      expect(read.response).toEqual(response);
      expect(isLockedChatSealedContent(read.request)).toBe(false);
    });

    test("the fail-closed redaction marker keeps its own meaning", () => {
      const encryptedResponse = encryptInteractionContent(
        { response },
        audit,
      ) as Record<string, unknown>;

      // Mixed row: the request could not be encrypted at write time (no key
      // on the request) and was dropped; the response was stored encrypted.
      const read = readInteractionRow({
        request: LOCKED_CHAT_REDACTED_MARKER,
        response: encryptedResponse.response,
        lockedChatConversationId: CONVERSATION_ID,
      }) as Record<string, unknown>;

      // "Never stored" must not be relabelled as "recoverable via escrow".
      expect(isLockedChatRedactedContent(read.request)).toBe(true);
      expect(isLockedChatSealedContent(read.request)).toBe(false);
      expect(isLockedChatSealedContent(read.response)).toBe(true);
    });
  });

  describe("at-rest backfill inertness", () => {
    test("the sweep leaves locked-chat rows byte-identical", async () => {
      const [interaction] = await db
        .insert(schema.interactionsTable)
        .values(
          encryptInteractionContent(
            { request, response, type: "anthropic:messages" as const },
            audit,
          ),
        )
        .returning({ id: schema.interactionsTable.id });
      const [call] = await db
        .insert(schema.mcpToolCallsTable)
        .values(
          encryptMcpToolCallContent(
            { mcpServerName: "email", method: "tools/call", toolCall },
            audit,
          ),
        )
        .returning({ id: schema.mcpToolCallsTable.id });

      // Ordinary plaintext rows in the same tables: controls proving the
      // sweep actually reached both tables rather than no-opping.
      const [plainInteraction] = await db
        .insert(schema.interactionsTable)
        .values({ request, response, type: "anthropic:messages" })
        .returning({ id: schema.interactionsTable.id });
      const [plainCall] = await db
        .insert(schema.mcpToolCallsTable)
        .values({ mcpServerName: "email", method: "tools/call", toolCall })
        .returning({ id: schema.mcpToolCallsTable.id });

      const interactionBefore = await rawInteraction(interaction.id);
      const callBefore = await rawToolCall(call.id);

      // An operator enables at-rest encryption later and the sweep runs over
      // rows that already exist. LockedChat envelopes look exactly like at-rest
      // envelopes, so the sweep must recognize them as foreign-key and skip
      // them — re-wrapping under the server key would make them unopenable by
      // the conversation DEK and by break-glass alike.
      setServerKey(SERVER_SECRET);
      await db.execute(sql`DROP INDEX IF EXISTS "messages_content_trgm_idx"`);
      await db.execute(
        sql`DROP INDEX IF EXISTS "mcp_tool_calls_tool_result_trgm_idx"`,
      );

      const result = await runContentEncryptionBackfill({});
      expect(result.status).toBe("completed");

      // The controls were rewritten under the server key...
      expect(
        decryptContentValue(
          (await rawInteraction(plainInteraction.id)).request,
          "interactions.request",
        ),
      ).toEqual(request);
      expect(
        isContentEnvelope((await rawToolCall(plainCall.id)).tool_call),
      ).toBe(true);

      // ...while the locked-chat rows came through untouched.
      expect(await rawInteraction(interaction.id)).toEqual(interactionBefore);
      expect(await rawToolCall(call.id)).toEqual(callBefore);

      // And they still open with the conversation key.
      expect(
        decryptLockedChatValue(interactionBefore.request, {
          ...audit,
          context: "interactions.request",
        }),
      ).toEqual(request);
      expect(
        decryptLockedChatValue(callBefore.tool_call, {
          ...audit,
          context: "mcp_tool_calls.tool_call",
        }),
      ).toEqual(toolCall);
    });
  });
});

async function rawInteraction(id: string) {
  const result = await db.execute<{ request: unknown; response: unknown }>(
    sql`SELECT request, response FROM interactions WHERE id = ${id}::uuid`,
  );
  return result.rows[0];
}

async function rawToolCall(id: string) {
  const result = await db.execute<{ tool_call: unknown }>(
    sql`SELECT tool_call, tool_result FROM mcp_tool_calls WHERE id = ${id}::uuid`,
  );
  return result.rows[0];
}
