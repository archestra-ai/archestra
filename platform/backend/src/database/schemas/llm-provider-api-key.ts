import type { SupportedProvider } from "@shared";
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
    // Visibility scope for this LLM provider API key.
    scope: text("scope")
      .$type<ResourceVisibilityScope>()
      .notNull()
      .default("personal"),
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    teamId: text("team_id").references(() => team.id, {
      onDelete: "cascade",
    }),
    /** Optional custom base URL override for the LLM provider API */
    baseUrl: text("base_url"),
    /** Optional custom HTTP headers sent on every request to the provider (e.g. RBAC headers required by gateways like Kubeflow). */
    extraHeaders: jsonb("extra_headers").$type<Record<string, string>>(),
    /** System keys are auto-managed for keyless LLM providers (Vertex AI, vLLM, etc.) */
    isSystem: boolean("is_system").notNull().default(false),
    /** When multiple LLM provider API keys exist for the same provider+scope, the primary key is preferred */
    isPrimary: boolean("is_primary").notNull().default(false),
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
    // Partial unique indexes: at most one primary key per provider+scope combination
    uniqueIndex("chat_api_keys_primary_personal_unique")
      .on(table.organizationId, table.provider, table.scope, table.userId)
      .where(sql`${table.isPrimary} = true AND ${table.scope} = 'personal'`),
    uniqueIndex("chat_api_keys_primary_team_unique")
      .on(table.organizationId, table.provider, table.scope, table.teamId)
      .where(sql`${table.isPrimary} = true AND ${table.scope} = 'team'`),
    uniqueIndex("chat_api_keys_primary_org_unique")
      .on(table.organizationId, table.provider, table.scope)
      .where(sql`${table.isPrimary} = true AND ${table.scope} = 'org'`),
  ],
);

export default llmProviderApiKeysTable;
