import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isRateLimited } from "@/agents/utils";
import { CacheKey } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { ApiError, constructResponseSchema } from "@/types";

/**
 * GitHub OAuth device flow for GitHub Copilot (RFC 8628), proxied through the
 * backend because GitHub's device endpoints do not allow browser CORS.
 *
 * The flow only obtains the user's GitHub OAuth token: `start` requests a
 * device/user code pair, the user authorizes at github.com, and `poll` is
 * called by the frontend until GitHub returns the token. The frontend then
 * creates the provider key through the standard CreateLlmProviderApiKey
 * endpoint (which validates the Copilot seat and syncs models), so this flow
 * adds no second key-creation path. Returning the token to its owner over the
 * authenticated session is equivalent to the supported manual flow (pasting
 * the token from ~/.config/github-copilot/apps.json).
 */
const githubCopilotAuthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/github-copilot-auth/device/start",
    {
      schema: {
        operationId: RouteId.GithubCopilotDeviceAuthStart,
        description:
          "Start the GitHub device flow used to connect a GitHub Copilot subscription",
        tags: ["GitHub Copilot Auth"],
        response: constructResponseSchema(DeviceStartResponseSchema),
      },
    },
    async ({ user }) => {
      // Both endpoints relay traffic to GitHub; cap per user so a misbehaving
      // client can't drive GitHub rate-limit pressure through the backend.
      if (
        await isRateLimited(
          `${CacheKey.GithubCopilotDeviceAuthRateLimit}-start-${user.id}`,
          { windowMs: 10 * 60_000, maxRequests: 10 },
        )
      ) {
        throw new ApiError(
          429,
          "Too many GitHub sign-in attempts — try again later",
        );
      }

      const response = await fetch(`${deviceAuthBaseUrl()}/login/device/code`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_id: config.llm["github-copilot"].clientId,
          scope: "read:user",
        }),
      });
      if (!response.ok) {
        logger.error(
          { status: response.status },
          "[GithubCopilotAuth] device code request failed",
        );
        throw new ApiError(
          502,
          "GitHub did not accept the device code request",
        );
      }

      const payload = (await response.json()) as {
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        interval?: number;
        expires_in?: number;
      };
      if (!payload.device_code || !payload.user_code) {
        throw new ApiError(
          502,
          "GitHub returned an unexpected device code payload",
        );
      }

      return {
        deviceCode: payload.device_code,
        userCode: payload.user_code,
        verificationUri:
          payload.verification_uri ?? `${deviceAuthBaseUrl()}/login/device`,
        interval: payload.interval ?? 5,
        expiresIn: payload.expires_in ?? 900,
      };
    },
  );

  fastify.post(
    "/api/github-copilot-auth/device/poll",
    {
      schema: {
        operationId: RouteId.GithubCopilotDeviceAuthPoll,
        description:
          "Poll the GitHub device flow once; returns the GitHub OAuth token when the user has authorized",
        tags: ["GitHub Copilot Auth"],
        body: z.object({
          deviceCode: z.string().min(1),
        }),
        response: constructResponseSchema(DevicePollResponseSchema),
      },
    },
    async ({ body, user }) => {
      // The frontend polls at GitHub's requested interval (>= 5s); this cap
      // only trips on clients ignoring interval/slow_down.
      if (
        await isRateLimited(
          `${CacheKey.GithubCopilotDeviceAuthRateLimit}-poll-${user.id}`,
          { windowMs: 60_000, maxRequests: 30 },
        )
      ) {
        throw new ApiError(
          429,
          "Polling too fast — honor the device-flow interval",
        );
      }

      const response = await fetch(
        `${deviceAuthBaseUrl()}/login/oauth/access_token`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            client_id: config.llm["github-copilot"].clientId,
            device_code: body.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        },
      );
      if (!response.ok) {
        logger.error(
          { status: response.status },
          "[GithubCopilotAuth] device token poll failed",
        );
        throw new ApiError(502, "GitHub did not accept the device token poll");
      }

      const payload = (await response.json()) as {
        access_token?: string;
        error?: string;
      };
      if (payload.access_token) {
        return {
          status: "complete" as const,
          accessToken: payload.access_token,
        };
      }

      switch (payload.error) {
        case "authorization_pending":
          return { status: "pending" as const };
        case "slow_down":
          return { status: "slow_down" as const };
        case "expired_token":
          throw new ApiError(
            400,
            "The GitHub sign-in expired before it was authorized — start again",
          );
        case "access_denied":
          throw new ApiError(400, "GitHub sign-in was declined");
        default:
          logger.error(
            { error: payload.error },
            "[GithubCopilotAuth] device token poll returned an error",
          );
          throw new ApiError(
            502,
            `GitHub sign-in failed${payload.error ? `: ${payload.error}` : ""}`,
          );
      }
    },
  );
};

export default githubCopilotAuthRoutes;

// ===== Internal helpers =====

const DeviceStartResponseSchema = z.object({
  /**
   * Opaque code the frontend round-trips to the poll endpoint. Usable only
   * with this deployment's client id to authorize the caller's own GitHub
   * account, never returned to anyone but the authenticated initiator.
   */
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  /** Seconds the client must wait between polls. */
  interval: z.number(),
  /** Seconds until the device code expires. */
  expiresIn: z.number(),
});

const DevicePollResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("slow_down") }),
  z.object({
    status: z.literal("complete"),
    /**
     * The caller's own GitHub OAuth token, used by the frontend as the
     * `apiKey` of a standard CreateLlmProviderApiKey call — same sensitivity
     * as the documented manual paste flow.
     */
    accessToken: z.string(),
  }),
]);

function deviceAuthBaseUrl(): string {
  return config.llm["github-copilot"].deviceAuthBaseUrl.replace(/\/+$/, "");
}
