// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import type { AclEntry, ConnectorType } from "@/types";

/**
 * Pure ACL token helpers shared by the document-side builder
 * (`source-access-control.ts`) and the query-side group resolver
 * (`models/kb-external-user-group.ts`). Kept dependency-free (no model imports)
 * so both sides can import it without an import cycle.
 */

/**
 * Case-fold + trim normalizer shared by every email that crosses the ACL
 * boundary: `user_email:<email>` on documents, `memberEmail` in the group
 * snapshot, and the querying `user.email`. All three MUST normalize identically
 * or matching silently fails (the email normalization data-contract).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Namespace an upstream group id by connector type so group ids never collide
 * across connectors: `group:<connectorType>_<groupId>`. The token written on a
 * document and the token resolved for a user at query time both go through this
 * function, guaranteeing the groupId data-contract byte-matches.
 */
export function buildGroupToken(params: {
  connectorType: ConnectorType;
  groupId: string;
}): AclEntry {
  return `group:${params.connectorType}_${params.groupId}`;
}

/**
 * Reference a `kb_container_acls` row from a document/chunk ACL:
 * `container:<connectorId>:<containerKey>`. Namespaced by connector ID (not
 * type — searches span connector instances, and two Jira sites can share a
 * project key). The token written on documents and the token resolved for a
 * user at query time both go through this function; tokens are matched as
 * exact strings, never parsed.
 */
export function buildContainerToken(params: {
  connectorId: string;
  containerKey: string;
}): AclEntry {
  return `container:${params.connectorId}:${params.containerKey}`;
}
