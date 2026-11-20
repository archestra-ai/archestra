// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { FederatedCredentialClaimConditions } from "@/types/service-account-federated-credential";
import oauthClientsTable from "./oauth-client";
import organizationsTable from "./organization";
import usersTable from "./user";

/**
 * A trust policy that lets an external workload authenticate as a managed
 * OAuth client with an OIDC token from its own issuer, sent as the
 * `client_assertion` of a client credentials grant, in place of the client
 * secret. Matched exactly, like a service account's federated credentials;
 * see `services/workload-identity` for the checks.
 */
const oauthClientFederatedCredentialsTable = pgTable(
  "oauth_client_federated_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** The `oauth_client.id` (not its public `client_id`). */
    oauthClientId: text("oauth_client_id")
      .notNull()
      .references(() => oauthClientsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Exact `iss` value; also the base of the OIDC discovery document. */
    issuer: text("issuer").notNull(),
    /** One value the token's `aud` must contain. */
    audience: text("audience").notNull(),
    /** Exact `sub` value. */
    subject: text("subject").notNull(),
    /** Further claims that must equal these values exactly. */
    claimConditions: jsonb("claim_conditions")
      .$type<FederatedCredentialClaimConditions>()
      .notNull()
      .default({}),
    /** Last access token issued through this credential. */
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date()),
  },
  (table) => [
    index("oauth_client_federated_credentials_client_issuer_idx").on(
      table.oauthClientId,
      table.issuer,
    ),
    uniqueIndex("oauth_client_federated_credentials_client_name_unique_idx").on(
      table.oauthClientId,
      table.name,
    ),
  ],
);

export default oauthClientFederatedCredentialsTable;
