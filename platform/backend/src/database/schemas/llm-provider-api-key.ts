import type { SupportedProvider } from "@archestra/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ResourceVisibilityScope } from "@/types";
import secretsTable from "./secret";
import serviceAccountsTable from "./service-account";
import { team } from "./team";
import usersTable from "./user";

const llmProviderApiKeysTable = pgTable(
  "chat_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    provider: text("provider").$type<SupportedProvider>().notNull(),
    secretId: uuid("secret_id").references(() => secretsTable.id, {
      onDelete: "set null",
    }),
    // Retired visibility scope. Access comes from grants, ownership from
    // `userId`, and the primary partition from `userId`.
    scope: text("scope")
      .$type<ResourceVisibilityScope>()
      .notNull()
      .default("personal"),
    /**
     * The owner of an own ("just for me") key: only this user uses it. Null on
     * a shared key, whose audience is its grants.
     */
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    teamId: text("team_id").references(() => team.id, {
      onDelete: "cascade",
    }),
    /**
     * Who created this key. Deliberately NOT `userId` above: that column is the
     * *audience* of a `personal`-scoped key and is null on every `org`- and
     * `team`-scoped one, so it answers "who may use this", not "who added it" —
     * and the org-scoped keys are exactly the ones somebody needs to ask about.
     * Its `ON DELETE cascade` is wrong here too: deleting the author must not
     * delete an organization's provider key.
     *
     * Nullable: keys predating creator tracking have no answer, and the FK
     * returns the column to "unknown" when the account is deleted.
     */
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /** Optional custom base URL override for the LLM provider API */
    baseUrl: text("base_url"),
    /** Optional runtime endpoint override when discovery and inference use different provider URLs. */
    inferenceBaseUrl: text("inference_base_url"),
    /** Optional custom HTTP headers sent on every request to the provider (e.g. RBAC headers required by gateways like Kubeflow). */
    extraHeaders: jsonb("extra_headers").$type<Record<string, string>>(),
    /** System keys are auto-managed for keyless LLM providers (Vertex AI, vLLM, etc.) */
    isSystem: boolean("is_system").notNull().default(false),
    /**
     * The preferred key for its provider among the owner's own keys, or among
     * the organization's shared keys when `userId` is null.
     */
    isPrimary: boolean("is_primary").notNull().default(false),
    /** A provider rejected this credential; cleared after successful validation. */
    requiresReauthentication: boolean("requires_reauthentication")
      .notNull()
      .default(false),
    /** Service account creator; separate from human ownership. */
    createdByServiceAccountId: uuid("created_by_service_account_id").references(
      () => serviceAccountsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Index for efficient lookups by organization
    index("chat_api_keys_organization_id_idx").on(table.organizationId),
    // Index for finding keys by org + provider
    index("chat_api_keys_org_provider_idx").on(
      table.organizationId,
      table.provider,
    ),
    // Partial unique index: only one system key per provider (global)
    uniqueIndex("chat_api_keys_system_unique")
      .on(table.provider)
      .where(sql`${table.isSystem} = true`),
    // At most one primary key per provider for each owner's own keys, and one
    // per provider among the organization's shared keys (no owner). The owner
    // column, not the retired scope, decides which partition a key is in.
    uniqueIndex("chat_api_keys_primary_owner_unique")
      .on(table.organizationId, table.provider, table.userId)
      .where(sql`${table.isPrimary} = true AND ${table.userId} IS NOT NULL`),
    uniqueIndex("chat_api_keys_primary_shared_unique")
      .on(table.organizationId, table.provider)
      .where(sql`${table.isPrimary} = true AND ${table.userId} IS NULL`),
  ],
);

export default llmProviderApiKeysTable;
