import { SupportedProvidersSchema } from "@archestra/shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { ToolExposureModeSchema } from "./agent";
import { SelectConversationChatErrorSchema } from "./conversation-chat-error";
import { SelectConversationCompactionSchema } from "./conversation-compaction";
import { ConversationShareVisibilitySchema } from "./conversation-share";

const ConversationShareSummarySchema = z
  .object({
    id: z.string().uuid(),
    visibility: ConversationShareVisibilitySchema,
  })
  .nullable();

/**
 * How a conversation was started: a person, a scheduled trigger run, or
 * opening an app from the apps page. `app_open` chats are drafts — hidden from
 * the conversations list until the user writes a message (see
 * `ConversationModel.findAll`).
 */
export const ConversationOriginSchema = z.enum([
  "user",
  "schedule_trigger",
  "app_open",
]);
export type ConversationOrigin = z.infer<typeof ConversationOriginSchema>;

/**
 * Versioned escrow record stored on incognito conversations (enterprise
 * break-glass recovery — see content-encryption/incognito-escrow.ee.ts).
 * Union of the two escrow sinks:
 * - `db` sink: the conversation key wrapped to the operator's RSA escrow
 *   public key, stored inline on the row.
 * - `vault` sink: a reference marker naming the HashiCorp Vault path the
 *   wrapped key was written to (the blob itself never touches the database).
 * Null when no escrow key is configured (free incognito chats store no
 * recoverable copy of the key at all).
 */
export const IncognitoEscrowBlobSchema = z.union([
  z.object({
    v: z.literal(1),
    alg: z.literal("RSA-OAEP-256"),
    escrowKeyFingerprint: z.string(),
    wrappedDek: z.string(),
  }),
  z.object({
    v: z.literal(1),
    sink: z.literal("vault"),
    path: z.string(),
  }),
]);
export type IncognitoEscrowBlob = z.infer<typeof IncognitoEscrowBlobSchema>;
/** The `db`-sink variant: the RSA-wrapped conversation key itself. */
export type IncognitoEscrowWrappedDek = Extract<
  IncognitoEscrowBlob,
  { wrappedDek: string }
>;

/**
 * Per-conversation content key for incognito conversations: the browser-held
 * DEK presented on the current request plus the conversation it belongs to
 * (the AAD binds ciphertext to the conversation). Threaded explicitly through
 * every message read/write — never stored, never global.
 */
export type ConversationContentKey = {
  dek: Buffer;
  conversationId: string;
};

// Override selectedProvider to use the proper enum type
// For select schema, it's nullable (matches DB schema)
const selectExtendedFields = {
  selectedProvider: SupportedProvidersSchema.nullable(),
  origin: ConversationOriginSchema,
};

// For insert/update schema, selectedProvider is optional
const insertUpdateExtendedFields = {
  selectedProvider: SupportedProvidersSchema.optional(),
  origin: ConversationOriginSchema.optional(),
};

export const SelectConversationSchema = createSelectSchema(
  schema.conversationsTable,
)
  // lastReadAt is the owner's private read marker; it must never reach a
  // shared/project viewer. Keep it out of the response shape entirely — the
  // client only needs the derived `unread` flag — so it is stripped from every
  // response, while the model still reads the raw column to compute `unread`.
  // The incognito escrow blob and key fingerprint are server-side bookkeeping
  // (break-glass recovery / wrong-key rejection) — clients only need the flag.
  .omit({
    lastReadAt: true,
    incognitoDekFingerprint: true,
    incognitoEscrow: true,
  })
  .extend({
    /**
     * Incognito conversations only: true when the response omits message
     * content because no (valid) conversation key accompanied the request —
     * the client renders the key-lost tombstone instead of a thread.
     */
    contentLocked: z.boolean().optional(),
    // Agent is nullable when the associated profile has been deleted
    agent: z
      .object({
        id: z.string(),
        name: z.string(),
        systemPrompt: z.string().nullable(),
        agentType: z.enum(["profile", "mcp_gateway", "llm_proxy", "agent"]),
        toolExposureMode: ToolExposureModeSchema,
        llmApiKeyId: z.string().nullable(),
      })
      .nullable(),
    share: ConversationShareSummarySchema,
    /** Project name when the chat belongs to one; populated by list queries only. */
    projectName: z.string().nullable().optional(),
    /** Project icon (emoji or data URL) for the chat's project; list queries only. */
    projectIcon: z.string().nullable().optional(),
    /** Has a message landed since the owner last read it; populated by list queries only. */
    unread: z.boolean().optional(),
    messages: z.array(z.any()), // UIMessage[] from AI SDK
    chatErrors: z.array(SelectConversationChatErrorSchema),
    compactions: z.array(SelectConversationCompactionSchema),
    ...selectExtendedFields,
  });

export const InsertConversationSchema = createInsertSchema(
  schema.conversationsTable,
  insertUpdateExtendedFields,
)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    // Override agentId to be required for creating conversations
    // (it's nullable in the DB schema to preserve conversations when agents are deleted)
    agentId: z.string().uuid(),
  });

export const UpdateConversationSchema = createUpdateSchema(
  schema.conversationsTable,
  insertUpdateExtendedFields,
)
  .pick({
    title: true,
    modelId: true,
    chatApiKeyId: true,
    agentId: true,
    artifact: true,
    pinnedAt: true,
  })
  .extend({
    // Override pinnedAt to accept ISO date strings from the frontend.
    // Uses z.string().datetime() instead of z.coerce.date() so OpenAPI codegen
    // emits a proper string type rather than unknown.
    pinnedAt: z.string().datetime().nullable().optional(),
    // Prevent explicit nullification of agentId via API
    // (null is only set by ON DELETE SET NULL when the agent is deleted)
    agentId: z.string().uuid().optional(),
  });

export type Conversation = z.infer<typeof SelectConversationSchema>;
export type InsertConversation = z.infer<typeof InsertConversationSchema>;
/** API request body type (pinnedAt as ISO string) */
export type UpdateConversationInput = z.infer<typeof UpdateConversationSchema>;
/** Model-level type (pinnedAt coerced to Date) */
export type UpdateConversation = Omit<UpdateConversationInput, "pinnedAt"> & {
  pinnedAt?: Date | null;
};
