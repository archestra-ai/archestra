// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  CompleteLinkedIdentityProviderIntentRequestSchema,
  CreateLinkedIdentityProviderIntentRequestSchema,
  LINKED_IDP_AUTH_COMPLETE_PATH,
  LINKED_IDP_AUTH_INTENT_PATH,
} from "@archestra/shared";
import type { AuthContext } from "@better-auth/core";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth/types";
import {
  completeLinkedIdentityProviderIntent,
  createLinkedIdentityProviderIntent,
  LINKED_IDP_INTENT_TTL_SECONDS,
} from "@/services/identity-providers/linked-idp-auth";
import { ApiError } from "@/types";

export function linkedIdentityProviderPlugin() {
  return {
    id: "linked-identity-provider",
    endpoints: {
      createLinkedIdentityProviderIntent: createAuthEndpoint(
        LINKED_IDP_AUTH_INTENT_PATH,
        {
          method: "POST",
          use: [sessionMiddleware],
          body: CreateLinkedIdentityProviderIntentRequestSchema,
        },
        async (ctx) => {
          const { user, session } = ctx.context.session;
          const intent = await createLinkedIdentityProviderIntent({
            originalUserId: user.id,
            originalSessionId: session.id,
            providerId: ctx.body.providerId,
            redirectTo: ctx.body.redirectTo,
          });
          const cookie = getIntentCookie(ctx);
          await ctx.setSignedCookie(
            cookie.name,
            intent.intentId,
            ctx.context.secret,
            cookie.attributes,
          );
          return ctx.json(intent);
        },
      ),
      completeLinkedIdentityProviderIntent: createAuthEndpoint(
        LINKED_IDP_AUTH_COMPLETE_PATH,
        {
          method: "POST",
          use: [sessionMiddleware],
          body: CompleteLinkedIdentityProviderIntentRequestSchema,
        },
        async (ctx) => {
          const { user, session } = ctx.context.session;
          // Only the browser that created the intent may complete it.
          const cookie = getIntentCookie(ctx);
          const cookieIntentId = await ctx.getSignedCookie(
            cookie.name,
            ctx.context.secret,
          );
          if (!cookieIntentId || cookieIntentId !== ctx.body.intentId) {
            throw ctx.error("BAD_REQUEST", {
              message: "Linked identity provider request not found",
            });
          }

          try {
            const result = await completeLinkedIdentityProviderIntent({
              intentId: ctx.body.intentId,
              currentUserId: user.id,
              currentSessionId: session.id,
            });
            const originalSession =
              await ctx.context.internalAdapter.findSession(
                result.originalSessionToken,
              );

            if (!originalSession) {
              throw new ApiError(
                400,
                "Original session is no longer available",
              );
            }

            await setSessionCookie(ctx, originalSession);
            expireCookie(ctx, cookie);
            return ctx.json({ redirectTo: result.redirectTo });
          } catch (error) {
            if (error instanceof ApiError) {
              throw ctx.error("BAD_REQUEST", { message: error.message });
            }

            throw error;
          }
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

// === Internal helpers

/**
 * The cookie that ties a linked IdP intent to the browser that created it.
 * Better Auth's cookie getter gives it the same prefix, Secure flag and domain
 * as the session cookie.
 */
function getIntentCookie(ctx: {
  context: Pick<AuthContext, "createAuthCookie">;
}) {
  return ctx.context.createAuthCookie(LINKED_IDP_INTENT_COOKIE, {
    maxAge: LINKED_IDP_INTENT_TTL_SECONDS,
  });
}

const LINKED_IDP_INTENT_COOKIE = "linked_idp_intent";
