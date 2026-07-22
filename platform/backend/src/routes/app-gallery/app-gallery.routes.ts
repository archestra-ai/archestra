import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isRateLimited } from "@/agents/utils";
import { CacheKey } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { assertAppsHackathonAvailable } from "@/services/apps/apps-hackathon-gate";
import { ApiError, constructResponseSchema } from "@/types";

/**
 * GitHub OAuth device flow (RFC 8628) for sharing a recorded app session to
 * the public App Gallery, proxied through the backend because GitHub's device
 * endpoints do not allow browser CORS.
 *
 * The flow only obtains the participant's own GitHub OAuth token: `start`
 * requests a device/user code pair, the participant authorizes at github.com,
 * and `poll` is called by the frontend until GitHub returns the token. The
 * submission itself — fork the gallery repository, commit the recording
 * bundle, open the pull request — runs entirely in the browser against
 * api.github.com (which does allow CORS), so the recording never transits
 * this server and the token is returned once to its owner, never stored here.
 */
const appGalleryRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Same availability gate as the recorder routes, plus: sharing only exists
  // on deployments configured with a gallery OAuth client id and repository.
  fastify.addHook("preHandler", async ({ organizationId }) => {
    await assertAppsHackathonAvailable(organizationId);
    if (!galleryShareConfigured()) {
      throw new ApiError(
        403,
        "Sharing to the App Gallery is not configured on this deployment.",
      );
    }
  });

  fastify.post(
    "/api/app-gallery/device/start",
    {
      schema: {
        operationId: RouteId.AppGalleryDeviceAuthStart,
        description:
          "Start the GitHub device flow used to share a recorded app session to the public App Gallery",
        tags: ["App Gallery"],
        response: constructResponseSchema(DeviceStartResponseSchema),
      },
    },
    async ({ user }) => {
      // Both endpoints relay traffic to GitHub; cap per user so a misbehaving
      // client can't drive GitHub rate-limit pressure through the backend.
      if (
        await isRateLimited(
          `${CacheKey.AppGalleryDeviceAuthRateLimit}-start-${user.id}`,
          { windowMs: 10 * 60_000, maxRequests: 10 },
        )
      ) {
        throw new ApiError(
          429,
          "Too many GitHub sign-in attempts — try again later",
        );
      }

      const response = await fetch(`${GITHUB_BASE_URL}/login/device/code`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_id: config.hackathonRecorder.gallery.githubClientId,
          // The narrowest scope that can fork a public repository, push the
          // submission branch to the fork, and open the pull request.
          scope: "public_repo",
        }),
      });
      if (!response.ok) {
        logger.error(
          { status: response.status },
          "[AppGallery] device code request failed",
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
          payload.verification_uri ?? `${GITHUB_BASE_URL}/login/device`,
        interval: payload.interval ?? 5,
        expiresIn: payload.expires_in ?? 900,
      };
    },
  );

  fastify.post(
    "/api/app-gallery/device/poll",
    {
      schema: {
        operationId: RouteId.AppGalleryDeviceAuthPoll,
        description:
          "Poll the GitHub device flow once; returns the GitHub OAuth token when the participant has authorized",
        tags: ["App Gallery"],
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
          `${CacheKey.AppGalleryDeviceAuthRateLimit}-poll-${user.id}`,
          { windowMs: 60_000, maxRequests: 30 },
        )
      ) {
        throw new ApiError(
          429,
          "Polling too fast — honor the device-flow interval",
        );
      }

      const response = await fetch(
        `${GITHUB_BASE_URL}/login/oauth/access_token`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            client_id: config.hackathonRecorder.gallery.githubClientId,
            device_code: body.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        },
      );
      if (!response.ok) {
        logger.error(
          { status: response.status },
          "[AppGallery] device token poll failed",
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
            "[AppGallery] device token poll returned an error",
          );
          throw new ApiError(
            502,
            `GitHub sign-in failed${payload.error ? `: ${payload.error}` : ""}`,
          );
      }
    },
  );
};

export default appGalleryRoutes;

// ===== Internal helpers =====

/**
 * The gallery is github.com only — submissions go to one public repository —
 * so unlike the Copilot connector there is no configurable GHE base URL.
 */
const GITHUB_BASE_URL = "https://github.com";

function galleryShareConfigured(): boolean {
  const { githubClientId, repo } = config.hackathonRecorder.gallery;
  return Boolean(githubClientId && repo);
}

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
     * The caller's own GitHub OAuth token, scoped to public repositories. The
     * frontend uses it for the submission calls it makes directly against
     * api.github.com and keeps it in browser storage under a 24-hour expiry —
     * it is never sent back to this server.
     */
    accessToken: z.string(),
  }),
]);
