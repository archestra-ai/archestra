import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isRateLimited } from "@/agents/utils";
import { CacheKey } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import {
  encodeOpenAiCodexCredential,
  extractChatgptAccountId,
} from "@/services/openai-codex-credentials";
import {
  exchangeOpenAiCodexAuthCode,
  oauthErrorLogFields,
} from "@/services/openai-codex-token";
import { ApiError, constructResponseSchema } from "@/types";

const DEVICE_AUTH_START_RATE_LIMIT = {
  windowMs: 10 * 60_000,
  maxRequests: 10,
};

const DEVICE_AUTH_POLL_RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: 30,
};

// OpenAI device-flow endpoints, resolved against `config.llm.openai.codex.issuer`.
// Kept here so the OpenAI API surface this route talks to is discoverable in one
// place (matching the first-party Codex CLI's codex-rs paths).
const DEVICE_USERCODE_PATH = "/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_PATH = "/api/accounts/deviceauth/token";

/**
 * ChatGPT/Codex subscription OAuth **device flow**, proxied through the backend.
 *
 * Unlike the Codex CLI's loopback (localhost:1455) flow — which can't work for a
 * hosted, custom-domain deployment — the device flow needs no local redirect:
 * `start` asks OpenAI for a user code, the user approves at auth.openai.com, and
 * `poll` exchanges the resulting authorization code for the tokens. This is the
 * same shape as the GitHub/Microsoft Copilot device flows already in this repo.
 *
 * The flow only obtains the user's OAuth credential (refresh token + ChatGPT
 * account id, encoded together). The frontend then creates the provider key
 * through the standard CreateLlmProviderApiKey endpoint (an `openai` key whose
 * secret is that encoded credential), so this flow adds no second key-creation
 * path.
 */
const openaiCodexAuthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/openai-codex-auth/device/start",
    {
      schema: {
        operationId: RouteId.OpenaiCodexDeviceAuthStart,
        description:
          "Start the ChatGPT/Codex OAuth device flow used to connect a ChatGPT subscription as an OpenAI provider credential",
        tags: ["OpenAI Codex Auth"],
        response: constructResponseSchema(DeviceStartResponseSchema),
      },
    },
    async ({ user }) => {
      if (
        await isRateLimited(
          `${CacheKey.OpenaiCodexDeviceAuthRateLimit}-start-${user.id}`,
          DEVICE_AUTH_START_RATE_LIMIT,
        )
      ) {
        throw new ApiError(
          429,
          "Too many ChatGPT sign-in attempts — try again later",
        );
      }

      const { issuer, clientId } = config.llm.openai.codex;
      // The device endpoint takes ONLY the client id — matching the first-party
      // Codex CLI (codex-rs `UserCodeReq { client_id }`). Sending extra fields
      // such as `scope` is not part of the contract.
      //
      // NOTE: this deliberately sends JSON, not the `application/x-www-form-
      // urlencoded` body RFC 8628 device authorization specifies. OpenAI's
      // deviceauth endpoints expect JSON (this mirrors the first-party CLI); the
      // later OAuth token exchange (`exchangeOpenAiCodexAuthCode`) does use the
      // standard form encoding.
      const response = await fetch(`${issuer}${DEVICE_USERCODE_PATH}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ client_id: clientId }),
      });
      if (!response.ok) {
        const body = await response.text();
        // OpenAI returns 404 when device-code login is disabled for the account.
        // It is off by default, so this is a user-configuration issue (log at
        // warn, not error) — tell the user how to turn it on.
        if (response.status === 404) {
          logger.warn(
            { status: response.status, ...oauthErrorLogFields(body) },
            "[OpenAiCodexAuth] device code login is disabled for the account",
          );
          throw new ApiError(
            400,
            'Device code sign-in is turned off for this ChatGPT account. Turn it on in ChatGPT → Settings → Security → "Allow device code login", then try again.',
          );
        }
        logger.error(
          { status: response.status, ...oauthErrorLogFields(body) },
          "[OpenAiCodexAuth] device code request failed",
        );
        throw new ApiError(
          502,
          "ChatGPT did not accept the device code request",
        );
      }

      let rawPayload: unknown;
      try {
        rawPayload = await response.json();
      } catch {
        logger.error(
          { status: response.status },
          "[OpenAiCodexAuth] device code response was not JSON",
        );
        throw new ApiError(
          502,
          "ChatGPT returned an unexpected device code payload",
        );
      }

      const parsed = DeviceCodePayloadSchema.safeParse(rawPayload);
      // OpenAI ships the user code under either `user_code` or `usercode`, and
      // sends `interval` as a string — the schema tolerates both so a valid
      // response is never misread as malformed.
      const userCode = parsed.success
        ? (parsed.data.user_code ?? parsed.data.usercode)
        : undefined;
      if (!parsed.success || !userCode) {
        logger.error(
          {
            payloadKeys:
              rawPayload && typeof rawPayload === "object"
                ? Object.keys(rawPayload as Record<string, unknown>)
                : typeof rawPayload,
            issues: parsed.success
              ? ["missing user_code"]
              : parsed.error.issues.map((i) => i.path.join(".") || "(root)"),
          },
          "[OpenAiCodexAuth] unexpected device code payload shape",
        );
        throw new ApiError(
          502,
          "ChatGPT returned an unexpected device code payload",
        );
      }

      return {
        deviceAuthId: parsed.data.device_auth_id,
        userCode,
        verificationUri: `${issuer}/codex/device`,
        interval: coerceSeconds(parsed.data.interval, 5),
        expiresIn: coerceSeconds(parsed.data.expires_in, 900),
      };
    },
  );

  fastify.post(
    "/api/openai-codex-auth/device/poll",
    {
      schema: {
        operationId: RouteId.OpenaiCodexDeviceAuthPoll,
        description:
          "Poll the ChatGPT/Codex OAuth device flow once; returns the encoded provider credential when the user has authorized",
        tags: ["OpenAI Codex Auth"],
        body: z.object({
          deviceAuthId: z.string().min(1),
          // The device endpoint pairs the poll handle with the same user code it
          // issued at start; both are required to redeem the authorization code.
          userCode: z.string().min(1),
        }),
        response: constructResponseSchema(DevicePollResponseSchema),
      },
    },
    async ({ body, user }) => {
      if (
        await isRateLimited(
          `${CacheKey.OpenaiCodexDeviceAuthRateLimit}-poll-${user.id}`,
          DEVICE_AUTH_POLL_RATE_LIMIT,
        )
      ) {
        throw new ApiError(
          429,
          "Polling too fast — honor the device-flow interval",
        );
      }

      const { issuer } = config.llm.openai.codex;
      // Poll body is exactly { device_auth_id, user_code } — matching codex-rs
      // `TokenPollReq`. The client id is NOT part of the poll contract.
      const response = await fetch(`${issuer}${DEVICE_TOKEN_PATH}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          device_auth_id: body.deviceAuthId,
          user_code: body.userCode,
        }),
      });

      // OpenAI reports the not-yet-authorized state as 403/404 (or a pending
      // error in the body); only a 200 carries the authorization code.
      if (response.status === 403 || response.status === 404) {
        await response.body?.cancel();
        return { status: "pending" as const };
      }

      let payload: {
        authorization_code?: string;
        code_verifier?: string;
        error?: string;
      };
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        logger.error(
          { status: response.status },
          "[OpenAiCodexAuth] device token poll returned a non-JSON body",
        );
        throw new ApiError(502, "ChatGPT did not accept the device token poll");
      }

      if (!response.ok) {
        if (isPendingError(payload.error)) {
          return { status: "pending" as const };
        }
        if (payload.error === "slow_down") {
          return { status: "slow_down" as const };
        }
        if (payload.error === "expired_token") {
          throw new ApiError(
            400,
            "The ChatGPT sign-in expired before it was authorized — start again",
          );
        }
        // Remaining poll errors (e.g. access_denied) are user-triggered outcomes
        // of the device flow, not backend faults — log at warn, not error.
        logger.warn(
          { status: response.status, error: payload.error },
          "[OpenAiCodexAuth] device token poll returned an error",
        );
        throw new ApiError(
          502,
          `ChatGPT sign-in failed${payload.error ? `: ${payload.error}` : ""}`,
        );
      }

      if (!payload.authorization_code || !payload.code_verifier) {
        // 200 without the code yet — treat as still pending.
        return { status: "pending" as const };
      }

      const { refreshToken, idToken } = await exchangeOpenAiCodexAuthCode({
        code: payload.authorization_code,
        codeVerifier: payload.code_verifier,
        redirectUri: `${issuer}/deviceauth/callback`,
      });

      const accountId = extractChatgptAccountId(idToken);
      if (!accountId) {
        // Without the ChatGPT account id the credential can't send the required
        // `chatgpt-account-id` header, so every request would fail — reject now.
        throw new ApiError(
          502,
          "ChatGPT sign-in did not return an account id — make sure the account has an active ChatGPT/Codex subscription",
        );
      }

      return {
        status: "complete" as const,
        credential: encodeOpenAiCodexCredential({ refreshToken, accountId }),
      };
    },
  );
};

export default openaiCodexAuthRoutes;

// ===== Internal helpers =====

const DeviceStartResponseSchema = z.object({
  /**
   * Opaque id the frontend round-trips to the poll endpoint. Usable only with
   * this deployment's client id to authorize the caller's own ChatGPT account.
   */
  deviceAuthId: z.string(),
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
     * The encoded ChatGPT-subscription credential (refresh token + account id),
     * used by the frontend as the `apiKey` of a standard CreateLlmProviderApiKey
     * call against the `openai` provider. Redeemed for short-lived Codex access
     * tokens at request time.
     */
    credential: z.string(),
  }),
]);

/**
 * Fields Archestra reads from OpenAI's device-authorization response; extra
 * fields pass through unvalidated. `device_auth_id` is the poll handle.
 *
 * The shape faithfully mirrors the first-party Codex CLI (codex-rs
 * `UserCodeResp`): the user code arrives under either `user_code` or `usercode`
 * (serde alias), and `interval` is sent as a STRING like `"5"` (codex-rs parses
 * it with a custom string deserializer). `expires_in` is usually absent — the
 * CLI hardcodes the 15-minute lifetime — so it stays optional with a fallback.
 */
const DeviceCodePayloadSchema = z.looseObject({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1).optional(),
  usercode: z.string().min(1).optional(),
  interval: z.union([z.string(), z.number()]).optional(),
  expires_in: z.union([z.string(), z.number()]).optional(),
});

/**
 * Reads a device-flow duration OpenAI may send as a number or a numeric string,
 * falling back when it is absent or unparseable.
 */
function coerceSeconds(
  value: string | number | undefined,
  fallback: number,
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function isPendingError(error: string | undefined): boolean {
  return (
    error === "authorization_pending" ||
    error === "pending" ||
    error === "token_pending"
  );
}
