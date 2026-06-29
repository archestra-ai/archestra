import { z } from "zod";

/**
 * Incoming email security modes.
 * - private: Requires sender email to match an Archestra user who has access to the agent
 * - internal: Only allows emails from a specific domain
 * - public: No sender restrictions (anyone can email the agent)
 */
export const IncomingEmailSecurityModeSchema = z.enum([
  "private",
  "internal",
  "public",
]);
export type IncomingEmailSecurityMode = z.infer<
  typeof IncomingEmailSecurityModeSchema
>;
export const IncomingEmailSecurityModes = Object.values(
  IncomingEmailSecurityModeSchema.enum,
);

/**
 * Constant object for incoming email security mode values.
 * Use this for type-safe comparisons and UI selects.
 */
export const INCOMING_EMAIL_SECURITY_MODE = {
  PRIVATE: "private",
  INTERNAL: "internal",
  PUBLIC: "public",
} as const satisfies Record<string, IncomingEmailSecurityMode>;

/**
 * Check if a value is a valid incoming email security mode
 */
export function isValidIncomingEmailSecurityMode(
  value: string,
): value is IncomingEmailSecurityMode {
  return IncomingEmailSecurityModes.includes(
    value as IncomingEmailSecurityMode,
  );
}

/**
 * Regex pattern for validating domain format.
 * Matches domains like: company.com, sub.company.com, my-company.co.uk
 * Does not match: spaces, special characters (except hyphen), domains starting/ending with hyphen
 */
export const DOMAIN_VALIDATION_REGEX =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

/**
 * Maximum domain length per DNS specification (RFC 1035).
 */
export const MAX_DOMAIN_LENGTH = 253;
