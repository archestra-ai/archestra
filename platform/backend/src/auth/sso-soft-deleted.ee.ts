// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { HookEndpointContext } from "@better-auth/core";
import { APIError } from "better-auth";
import logger from "@/logging";
import UserModel from "@/models/user";

/**
 * Refuse the SSO sign-in of a user the identity provider deactivated through
 * SCIM (`user.soft_deleted`), and send them back to the sign-in page with
 * `?error=ACCOUNT_DEACTIVATED`.
 *
 * Every SSO sign-in of an existing user either links the account (the first
 * sign-in of a provisioned user) or refreshes the user from the IdP's claims
 * (every later one). Better Auth turns an error from either step into a
 * redirect with the error code. The session hook in better-auth.ts refuses the
 * session too, but an error there reaches the browser as a raw JSON body.
 */
export function withSsoSoftDeletedBlock(
  ctx: HookEndpointContext,
  internalAdapter: InternalAdapter,
): InternalAdapter | undefined {
  if (!ctx.request || !isSsoCallbackPath(new URL(ctx.request.url).pathname))
    return;
  const linkAccount: InternalAdapter["linkAccount"] = async (...args) => {
    await refuseIfSoftDeleted(args[0].userId);
    return internalAdapter.linkAccount(...args);
  };
  const updateUser = (async (
    ...args: Parameters<InternalAdapter["updateUser"]>
  ) => {
    await refuseIfSoftDeleted(args[0]);
    return internalAdapter.updateUser(...args);
  }) as InternalAdapter["updateUser"];
  return { ...internalAdapter, linkAccount, updateUser };
}

type InternalAdapter = HookEndpointContext["context"]["internalAdapter"];

// ===== internal helpers =====

async function refuseIfSoftDeleted(userId: string) {
  if (!(await UserModel.getSoftDeleted(userId))) return;
  logger.info(
    { userId },
    "SSO sign-in refused: the identity provider deactivated this user",
  );
  throw new APIError("FORBIDDEN", {
    code: "ACCOUNT_DEACTIVATED",
    message:
      "Your account was deactivated in your identity provider. Contact your administrator.",
  });
}

function isSsoCallbackPath(pathname: string): boolean {
  return SSO_CALLBACK_SEGMENTS.some((segment) => pathname.includes(segment));
}

const SSO_CALLBACK_SEGMENTS = [
  "/sso/callback/",
  "/sso/saml2/callback/",
  "/sso/saml2/sp/acs/",
];
