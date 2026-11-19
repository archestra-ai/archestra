// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { JWK } from "jose";
import secretsTable from "./secret";

/**
 * A key Archestra signs agents' JWT-SVIDs with. The newest key signs; older
 * ones stay published for a while so SVIDs they signed keep verifying. The
 * private half lives in the secrets store.
 */
const spiffeSigningKeysTable = pgTable("spiffe_signing_keys", {
  /** The key ID (`kid`) SVIDs and the published key set name it by. */
  id: text("id").primaryKey(),
  /** The public half, as published in the issuer's key set. */
  publicJwk: jsonb("public_jwk").$type<JWK>().notNull(),
  privateKeySecretId: uuid("private_key_secret_id")
    .notNull()
    .references(() => secretsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export default spiffeSigningKeysTable;
