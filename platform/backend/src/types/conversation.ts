import { SupportedProvidersSchema, THINKING_EFFORTS } from "@archestra/shared";
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
 * Versioned escrow record stored on locked chats (enterprise
 * break-glass recovery — see content-encryption/locked-chat-escrow.ts).
 * Union of the two escrow sinks:
 * The conversation key wrapped to the operator's RSA escrow public key, stored
 * inline on the row. Safe there: without the offline private half the blob is
 * useless, so the database holds ciphertext under two different keys and can
 * open neither.
 *
 * Null only on a row written before escrow became mandatory.
 */
export const LockedChatEscrowBlobSchema = z.object({
  v: z.literal(1),
  alg: z.literal("RSA-OAEP-256"),
  escrowKeyFingerprint: z.string(),
  wrappedDek: z.string(),
});
export type LockedChatEscrowBlob = z.infer<typeof LockedChatEscrowBlobSchema>;

/**
 * Per-conversation content key for locked chats: the browser-held
 * DEK presented on the current request plus the conversation it belongs to
 * (the AAD binds ciphertext to the conversation). Threaded explicitly through
 * every message read/write — never stored, never global.
 */
export type ConversationContentKey = {
  dek: Buffer;
  conversationId: string;
};

/**
 * How hard the model should reason before answering. Null is the model's own
 * default — no depth chosen, so the request carries no reasoning field.
 */
export const ThinkingEffortSchema = z.enum(THINKING_EFFORTS);
const ThinkingEffortSettingSchema = ThinkingEffortSchema.nullable();

// Override selectedProvider to use the proper enum type
// For select schema, it's nullable (matches DB schema)
const selectExtendedFields = {
  selectedProvider: SupportedProvidersSchema.nullable(),
  origin: ConversationOriginSchema,
  thinkingEffort: ThinkingEffortSettingSchema,
};

// For insert/update schema, selectedProvider is optional
const insertUpdateExtendedFields = {
  selectedProvider: SupportedProvidersSchema.optional(),
  origin: ConversationOriginSchema.optional(),
  // Nullable as well as optional: null is the caller choosing the model's own
  // default, which is a different instruction from omitting the field.
  thinkingEffort: ThinkingEffortSettingSchema.optional(),
};

export const SelectConversationSchema = createSelectSchema(
  schema.conversationsTable,
)
  // lastReadAt is the owner's private read marker; it must never reach a
  // shared/project viewer. Keep it out of the response shape entirely — the
  // client only needs the derived `unread` flag — so it is stripped from every
  // response, while the model still reads the raw column to compute `unread`.
  // The locked-chat escrow blob and key fingerprint are server-side bookkeeping
  // (break-glass recovery / wrong-key rejection) — clients only need the flag.
  .omit({
    lastReadAt: true,
    lockedChatDekFingerprint: true,
    lockedChatEscrow: true,
  })
  .extend({
    /**
     * Locked chats only: true when the response omits message
     * content because no (valid) conversation key accompanied the request —
     * the client renders the key-lost tombstone instead of a thread.
     */
    contentLocked: z.boolean().optional(),
    // Agent is nullable when the associated profile has been deleted
    agent: z
      .object({
        id: z.string(),
        name: z.string(),
        /**
         * Only populated on detail reads (findById); list rows omit it so a
         * roster of large custom prompts doesn't ride along on every sidebar
         * refresh.
         */
        systemPrompt: z.string().nullable().optional(),
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
    thinkingEffort: true,
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
