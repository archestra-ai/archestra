import {
  CompleteLinkedIdentityProviderIntentRequestSchema,
  CreateLinkedIdentityProviderIntentRequestSchema,
  LINKED_IDP_AUTH_COMPLETE_PATH,
  LINKED_IDP_AUTH_INTENT_PATH,
} from "@shared";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth/types";
import {
  completeLinkedIdentityProviderIntent,
  createLinkedIdentityProviderIntent,
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
          return ctx.json(
            await createLinkedIdentityProviderIntent({
              originalUserId: user.id,
              originalSessionId: session.id,
              providerId: ctx.body.providerId,
              redirectTo: ctx.body.redirectTo,
            }),
          );
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
