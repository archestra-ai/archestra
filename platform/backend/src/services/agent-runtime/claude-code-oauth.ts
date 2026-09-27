import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { ApiError } from "@/types/api";

/** The same public client and manual callback used by Claude Code setup-token. */
export const claudeCodeOAuth = {
  create() {
    return {
      verifier: randomBytes(32).toString("base64url"),
      state: randomBytes(32).toString("base64url"),
    };
  },

  authorizationUrl(params: { verifier: string; state: string }) {
    const url = new URL("https://claude.ai/oauth/authorize");
    url.search = new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: "user:inference",
      code_challenge: createHash("sha256")
        .update(params.verifier)
        .digest("base64url"),
      code_challenge_method: "S256",
      state: params.state,
    }).toString();
    return url.toString();
  },

  parseCode(params: { code: string; state: string }) {
    const [code, state, extra] = params.code.trim().split("#");
    if (
      !code ||
      !/^[A-Za-z0-9_-]+$/.test(code) ||
      state !== params.state ||
      extra !== undefined
    )
      throw new ApiError(
        400,
        "Paste the full authorization code from this Claude sign-in, including the part after #.",
      );
    return code;
  },

  async exchange(params: { code: string; verifier: string; state: string }) {
    const response = await providerRequest(
      "https://platform.claude.com/v1/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: params.code,
          state: params.state,
          redirect_uri: REDIRECT_URI,
          code_verifier: params.verifier,
          expires_in: 31536000,
        }),
      },
    );
    const result = TokenResponseSchema.safeParse(response);
    if (!result.success)
      throw new ApiError(
        502,
        "Claude returned an invalid sign-in result. Start sign-in again.",
      );
    return {
      token: result.data.access_token,
      expiresAt: new Date(
        Date.now() + result.data.expires_in * 1000,
      ).toISOString(),
    };
  },

  async models(token: string) {
    const response = await providerRequest(
      "https://api.anthropic.com/v1/models?limit=1000",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
    );
    const result = ModelsResponseSchema.safeParse(response);
    if (!result.success)
      throw new ApiError(502, "Claude returned an invalid model list.");
    return [
      {
        value: "default",
        displayName: "Default",
        description: "Claude Code's default model for your account",
      },
      ...result.data.data.map((model) => ({
        value: model.id,
        displayName: model.display_name,
        description: "",
      })),
    ];
  },
};

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const TokenResponseSchema = z.object({
  access_token: z
    .string()
    .min(32)
    .max(8192)
    .regex(/^sk-ant-oat[0-9]+-[A-Za-z0-9_-]+$/),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(366 * 24 * 3600),
  scope: z
    .string()
    .refine((value) => value.split(" ").includes("user:inference")),
});
const ModelsResponseSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        display_name: z.string().min(1).max(256),
      }),
    )
    .max(199),
});

async function providerRequest(
  url: string,
  init: RequestInit,
): Promise<unknown> {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("Provider request failed");
    return await response.json();
  } catch {
    // Provider bodies and fetch errors may contain credentials; never propagate them.
    throw new ApiError(502, "Could not contact Claude. Please try again.");
  }
}
