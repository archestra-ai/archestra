import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth/types";
import { z } from "zod";
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
        "/linked-idp/intent",
        {
          method: "POST",
          use: [sessionMiddleware],
          body: z.object({
            providerId: z.string().min(1),
            redirectTo: z.string().default("/chat"),
          }),
        },
        async (ctx) => {
          const { user, session } = ctx.context.session;
          return ctx.json(
            await createLinkedIdentityProviderIntent({
              originalUserId: user.id,
              originalSessionId: session.id,
              originalSessionToken: session.token,
              providerId: ctx.body.providerId,
              redirectTo: ctx.body.redirectTo,
            }),
          );
        },
      ),
      completeLinkedIdentityProviderIntent: createAuthEndpoint(
        "/linked-idp/complete",
        {
          method: "POST",
          use: [sessionMiddleware],
          body: z.object({
            intentId: z.string().min(1),
          }),
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
