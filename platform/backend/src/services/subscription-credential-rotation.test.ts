import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeOpenAiCodexCredential,
  encodeOpenAiCodexCredential,
} from "./openai-codex-credentials";
import { openAiCodexTokenManager } from "./openai-codex-token";
import { withLatestRotatedRefreshToken } from "./subscription-credential-rotation";
import {
  decodeXaiSubscriptionCredential,
  encodeXaiSubscriptionCredential,
} from "./xai-subscription-credentials";
import { xaiSubscriptionTokenManager } from "./xai-subscription-token";

describe("withLatestRotatedRefreshToken", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "at_1",
          expires_in: 3600,
          refresh_token: "rt-rotated",
        }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns non-subscription values unchanged", () => {
    expect(withLatestRotatedRefreshToken("sk-plain")).toBe("sk-plain");
  });

  it("returns the credential unchanged when no rotation was observed", () => {
    const value = encodeOpenAiCodexCredential({
      refreshToken: `rt-quiet-${crypto.randomUUID()}`,
      accountId: "acc-1",
    });
    expect(withLatestRotatedRefreshToken(value)).toBe(value);
  });

  it("re-encodes a Codex credential with the rotation its validation observed", async () => {
    const rtOriginal = `rt-orig-${crypto.randomUUID()}`;
    const value = encodeOpenAiCodexCredential({
      refreshToken: rtOriginal,
      accountId: "acc-1",
    });
    // The create route's validation path: an ID-less redemption that rotates.
    await openAiCodexTokenManager.getAccessToken({ refreshToken: rtOriginal });

    const latest = withLatestRotatedRefreshToken(value);
    expect(decodeOpenAiCodexCredential(latest)).toMatchObject({
      refreshToken: "rt-rotated",
      accountId: "acc-1",
    });
  });

  it("re-encodes a SuperGrok credential the same way, preserving identity fields", async () => {
    const rtOriginal = `rt-orig-${crypto.randomUUID()}`;
    const value = encodeXaiSubscriptionCredential({
      refreshToken: rtOriginal,
      userId: "x-user",
      email: "user@example.com",
    });
    // Discovery + token endpoint both served by the fetch stub above; the
    // discovery response only needs the shape when the endpoint cache is cold,
    // so serve both from one handler.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/.well-known/openid-configuration")) {
          const issuer = new URL(String(url)).origin;
          return Response.json({
            device_authorization_endpoint: `${issuer}/oauth2/device/code`,
            token_endpoint: `${issuer}/oauth2/token`,
          });
        }
        return Response.json({
          access_token: "at_1",
          expires_in: 3600,
          refresh_token: "rt-rotated",
        });
      }),
    );
    await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: rtOriginal,
    });

    const latest = withLatestRotatedRefreshToken(value);
    expect(decodeXaiSubscriptionCredential(latest)).toMatchObject({
      refreshToken: "rt-rotated",
      userId: "x-user",
      email: "user@example.com",
    });
  });
});
