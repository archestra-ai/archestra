import { describe, expect, it } from "vitest";
import {
  credentialRequiresPerUserScope,
  decodeOpenAiCodexCredential,
  encodeOpenAiCodexCredential,
  extractChatgptAccountId,
  isOpenAiCodexCredential,
  perUserCredentialLabel,
} from "./openai-codex-credentials";

/** Builds a JWT with the given payload (header/signature are irrelevant here). */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

describe("openai-codex credential codec", () => {
  it("round-trips a credential through encode/decode", () => {
    const encoded = encodeOpenAiCodexCredential({
      refreshToken: "rt_secret",
      accountId: "acc_123",
    });
    expect(isOpenAiCodexCredential(encoded)).toBe(true);
    expect(decodeOpenAiCodexCredential(encoded)).toEqual({
      refreshToken: "rt_secret",
      accountId: "acc_123",
    });
  });

  it("treats plain API keys as non-codex credentials", () => {
    expect(isOpenAiCodexCredential("sk-plain-openai-key")).toBe(false);
    expect(decodeOpenAiCodexCredential("sk-plain-openai-key")).toBeNull();
    expect(isOpenAiCodexCredential(undefined)).toBe(false);
  });

  it("returns null when the marker is present but the payload is malformed", () => {
    expect(
      decodeOpenAiCodexCredential("chatgpt-oauth:not-base64!!"),
    ).toBeNull();
    // Missing accountId → invalid.
    const partial = `chatgpt-oauth:${Buffer.from(
      JSON.stringify({ refreshToken: "rt" }),
    ).toString("base64")}`;
    expect(decodeOpenAiCodexCredential(partial)).toBeNull();
  });
});

describe("extractChatgptAccountId", () => {
  it("reads the top-level chatgpt_account_id claim", () => {
    expect(
      extractChatgptAccountId(makeJwt({ chatgpt_account_id: "top_456" })),
    ).toBe("top_456");
  });

  it("reads the namespaced chatgpt_account_id claim", () => {
    const jwt = makeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "ns_789" },
    });
    expect(extractChatgptAccountId(jwt)).toBe("ns_789");
  });

  it("returns undefined for a token without the claim or an unparseable token", () => {
    expect(extractChatgptAccountId(makeJwt({ sub: "user" }))).toBeUndefined();
    expect(extractChatgptAccountId("not-a-jwt")).toBeUndefined();
  });
});

describe("credentialRequiresPerUserScope", () => {
  const codex = encodeOpenAiCodexCredential({
    refreshToken: "rt",
    accountId: "acc",
  });

  it("treats a ChatGPT-subscription openai key as per-user", () => {
    expect(
      credentialRequiresPerUserScope({ provider: "openai", apiKey: codex }),
    ).toBe(true);
  });

  it("treats a plain openai API key as NOT per-user", () => {
    expect(
      credentialRequiresPerUserScope({
        provider: "openai",
        apiKey: "sk-plain",
      }),
    ).toBe(false);
  });

  it("keeps inherently per-user providers per-user regardless of the secret", () => {
    expect(
      credentialRequiresPerUserScope({
        provider: "github-copilot",
        apiKey: "gho_x",
      }),
    ).toBe(true);
    expect(
      credentialRequiresPerUserScope({
        provider: "microsoft-365-copilot",
        apiKey: null,
      }),
    ).toBe(true);
  });
});

describe("perUserCredentialLabel", () => {
  it("labels a codex openai key as ChatGPT Subscription", () => {
    const codex = encodeOpenAiCodexCredential({
      refreshToken: "rt",
      accountId: "acc",
    });
    expect(perUserCredentialLabel({ provider: "openai", apiKey: codex })).toBe(
      "ChatGPT Subscription",
    );
  });

  it("labels other per-user providers by provider name", () => {
    expect(
      perUserCredentialLabel({ provider: "github-copilot", apiKey: "gho_x" }),
    ).toBe("github-copilot");
  });
});
