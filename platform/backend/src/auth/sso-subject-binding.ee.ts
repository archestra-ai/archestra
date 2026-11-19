// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { HookEndpointContext } from "@better-auth/core";
import { APIError } from "better-auth";
import logger from "@/logging";
import AccountModel from "@/models/account";

/**
 * Refuse to bind a second subject from the same identity provider to one user.
 *
 * Better Auth finds the linked account by provider and subject first. When no
 * account matches, it falls back to the user with the same email and links the
 * new subject to it. A subject is the IdP's stable identity for a person, so a
 * new subject on an email that already carries a different one from the same
 * provider is a different person: the IdP reassigned the mailbox, for example
 * to a new hire after an employee left. Linking it would sign that person into
 * the previous owner's account and hand them its chats, agents, and
 * credentials.
 *
 * First links (a user with no account from this provider yet) and links from
 * a different provider are unchanged. An administrator resolves a conflict by
 * removing the previous user, after which the new subject signs up fresh.
 */
export function withSsoSubjectBinding<
  Adapter extends Pick<
    HookEndpointContext["context"]["internalAdapter"],
    "linkAccount"
  >,
>(ctx: HookEndpointContext, internalAdapter: Adapter) {
  if (!ctx.request || !isSsoCallbackPath(new URL(ctx.request.url).pathname))
    return;
  return {
    ...internalAdapter,
    linkAccount: async (
      ...args: Parameters<typeof internalAdapter.linkAccount>
    ) => {
      const [account] = args;
      const otherSubject = (
        await AccountModel.getAllByUserId(account.userId)
      ).find(
        (existing) =>
          existing.providerId === account.providerId &&
          existing.accountId !== account.accountId,
      );
      if (otherSubject) {
        logger.warn(
          { userId: account.userId, providerId: account.providerId },
          "SSO sign-in refused: the email already belongs to a different subject from this identity provider",
        );
        throw new APIError("CONFLICT", {
          code: "SSO_SUBJECT_CONFLICT",
          message:
            "This email belongs to a different person's account. Ask your administrator to remove the previous account, then sign in again.",
        });
      }
      return internalAdapter.linkAccount(...args);
    },
  };
}

function isSsoCallbackPath(pathname: string): boolean {
  return SSO_CALLBACK_SEGMENTS.some((segment) => pathname.includes(segment));
}

const SSO_CALLBACK_SEGMENTS = [
  "/sso/callback/",
  "/sso/saml2/callback/",
  "/sso/saml2/sp/acs/",
];
