// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  ROLE_ASSIGNMENT_BLOCKED_CODE,
  type RoleAssignmentBlockedDetails,
  RoleAssignmentBlockedDetailsSchema,
} from "@archestra/shared";

/**
 * A role or team assignment the server refused because the role or team
 * shares items the caller cannot share. Mutations throw this instead of
 * toasting, so the dialog can render {@link RoleAssignmentBlockedNotice}
 * with the item list a toast has no room for.
 */
export class RoleAssignmentBlockedError extends Error {
  constructor(
    message: string,
    readonly details: RoleAssignmentBlockedDetails,
  ) {
    super(message);
    this.name = "RoleAssignmentBlockedError";
  }
}

/**
 * The refusal carried by an error from either the generated API client
 * (`{ error: { internal_code, details } }`) or the better-auth client
 * (`{ code, details }`), or null for any other error.
 */
export function parseRoleAssignmentBlocked(
  error: unknown,
): RoleAssignmentBlockedError | null {
  if (error instanceof RoleAssignmentBlockedError) return error;
  if (typeof error !== "object" || error === null) return null;
  const body =
    "error" in error && typeof error.error === "object" && error.error !== null
      ? error.error
      : error;
  const code =
    ("internal_code" in body && body.internal_code) ||
    ("code" in body && body.code);
  if (code !== ROLE_ASSIGNMENT_BLOCKED_CODE) return null;
  const details = RoleAssignmentBlockedDetailsSchema.safeParse(
    "details" in body ? body.details : undefined,
  );
  if (!details.success) return null;
  const message =
    "message" in body && typeof body.message === "string" ? body.message : "";
  return new RoleAssignmentBlockedError(message, details.data);
}
