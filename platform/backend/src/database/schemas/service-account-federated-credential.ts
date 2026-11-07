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
import organizationsTable from "./organization";
import serviceAccountsTable from "./service-account";
import usersTable from "./user";

/**
 * A trust policy that lets an external workload (a CI job, a Kubernetes pod)
 * exchange an OIDC token from its own issuer for a short-lived token acting as
 * the service account. Every field is matched exactly; see
 * `services/workload-identity` for the checks.
 */
const serviceAccountFederatedCredentialsTable = pgTable(
  "service_account_federated_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccountsTable.id, { onDelete: "cascade" }),
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
    /** Last successful exchange through this credential. */
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
    index("service_account_federated_credentials_sa_issuer_idx").on(
      table.serviceAccountId,
      table.issuer,
    ),
    uniqueIndex("service_account_federated_credentials_sa_name_unique_idx").on(
      table.serviceAccountId,
      table.name,
    ),
  ],
);

export default serviceAccountFederatedCredentialsTable;
