import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import config from "@/config";
import logger from "@/logging";

/**
 * Developer-only Better Auth plugin exposing `POST /api/auth/dev-auto-login`.
 *
 * It mints a real Better Auth session for the user named by
 * ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL and sets the session cookie via
 * Better Auth's own `setSessionCookie`, so the app treats the browser as logged
 * in without the sign-in form. RBAC is unchanged — the session is an ordinary
 * one for that user.
 *
 * Inert unless the env var is set AND the build is non-production: the endpoint
 * returns 404 otherwise, so it is not an auth bypass on a real deployment.
 * `config.auth.devAutoAuthenticateEmail` is already forced to `undefined` in
 * production; the `config.production` check is defense in depth.
 */
export const devAutoLoginPlugin = () =>
  ({
    id: "dev-auto-login",
    endpoints: {
      devAutoLogin: createAuthEndpoint(
        "/dev-auto-login",
        { method: "POST" },
        async (ctx) => {
          const email = config.auth.devAutoAuthenticateEmail;
          if (!email || config.production) {
            // Feature off / production: behave as if the route does not exist.
            throw new APIError("NOT_FOUND", { message: "Not found" });
          }

          const found =
            await ctx.context.internalAdapter.findUserByEmail(email);
          if (!found?.user) {
            logger.error(
              { email },
              "[dev-auto-login] No user for ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL",
            );
            throw new APIError("NOT_FOUND", {
              message: "Dev auto-login user not found",
            });
          }

          const { user } = found;
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          // Sets Better Auth's signed session cookie (and cookie cache) exactly
          // like the normal sign-in path. activeOrganizationId is filled in by
          // the session.create database hook in better-auth.ts.
          await setSessionCookie(ctx, { session, user });

          logger.warn(
            { email, userId: user.id },
            "[dev-auto-login] Minted a session via dev auto-login",
          );

          return ctx.json({ userId: user.id });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
