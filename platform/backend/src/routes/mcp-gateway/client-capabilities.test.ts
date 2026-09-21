import { describe, expect, test } from "@/test";
import {
  clientCapabilityKey,
  clientCapabilityStore,
  encodeCapabilitySession,
  readCapabilitySession,
} from "./client-capabilities";

describe("capability session ids", () => {
  test("gives a caller's elicitation capability and extensions back only to the bound caller and gateway", () => {
    const capabilities = {
      elicitation: { form: {} },
      futureSdkExtension: { arbitrary: ["value", { nested: true }] },
    };
    const sessionId = encodeCapabilitySession({
      profileId: "gateway-a",
      principal: "user:alice",
      capabilities,
      now: 0,
    });
    if (!sessionId) throw new Error("expected a session id");
    const read = (
      overrides: Partial<Parameters<typeof readCapabilitySession>[0]>,
    ) =>
      readCapabilitySession({
        sessionId,
        profileId: "gateway-a",
        principal: "user:alice",
        now: 1,
        ...overrides,
      });

    expect(read({})).toEqual(capabilities);
    expect(read({ principal: "user:bob" })).toBeUndefined();
    expect(read({ profileId: "gateway-b" })).toBeUndefined();
    expect(read({ now: 31 * 24 * 60 * 60 * 1000 })).toBeUndefined();
    const [payload, signature] = sessionId.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        u: "user:bob",
      }),
    ).toString("base64url");
    expect(
      read({ sessionId: `${forged}.${signature}`, principal: "user:bob" }),
    ).toBeUndefined();
    expect(read({ sessionId: "not-a-session" })).toBeUndefined();
  });

  test("returns a session just below the header budget but omits an oversized extension", () => {
    const sessionId = encodeCapabilitySession({
      profileId: "gateway-a",
      principal: "user:alice",
      capabilities: {
        elicitation: { form: {} },
        futureSdkExtension: { payload: "x".repeat(2_900) },
      },
      now: 0,
    });

    expect(sessionId).toBeDefined();
    expect(Buffer.byteLength(sessionId ?? "")).toBeLessThanOrEqual(4 * 1024);
    expect(
      readCapabilitySession({
        sessionId,
        profileId: "gateway-a",
        principal: "user:alice",
        now: 1,
      }),
    ).toEqual({
      elicitation: { form: {} },
      futureSdkExtension: { payload: "x".repeat(2_900) },
    });

    expect(
      encodeCapabilitySession({
        profileId: "gateway-a",
        principal: "user:alice",
        capabilities: {
          elicitation: { form: {} },
          futureSdkExtension: { payload: "x".repeat(4_000) },
        },
        now: 0,
      }),
    ).toBeUndefined();
  });
});

describe("remembered client capabilities", () => {
  test("keeps extension capabilities intact while they fit the cache budget", () => {
    const key = clientCapabilityKey({
      profileId: "gateway-extensions",
      tokenId: "token-extensions",
      userAgent: "extension-sdk",
    });
    const capabilities = {
      elicitation: { form: {} },
      futureSdkExtension: { arbitrary: ["value", { nested: true }] },
    };

    clientCapabilityStore.remember({ key, capabilities });

    expect(clientCapabilityStore.lookup({ key })).toEqual(capabilities);
  });

  test("falls back to a verified session hint after User-Agent churn evicts the local entry", () => {
    const profileId = "gateway-capacity";
    const tokenId = "token-capacity";
    const principal = "token:token-capacity";
    const capabilities = { elicitation: { form: {} } };
    const key = clientCapabilityKey({
      profileId,
      tokenId,
      userAgent: "initial-client",
    });
    const sessionId = encodeCapabilitySession({
      profileId,
      principal,
      capabilities,
    });
    if (!sessionId) throw new Error("expected a session id");
    clientCapabilityStore.remember({ key, capabilities });

    // QuickLRU keeps at most two generations, so twice the configured entry
    // limit plus one distinct clients guarantees the original entry is gone.
    for (let index = 0; index <= 2_000; index++) {
      clientCapabilityStore.remember({
        key: clientCapabilityKey({
          profileId,
          tokenId,
          userAgent: `churned-client-${index}`,
        }),
        capabilities: { futureSdkExtension: { index } },
      });
    }

    expect(clientCapabilityStore.lookup({ key })).toBeUndefined();
    expect(readCapabilitySession({ sessionId, profileId, principal })).toEqual(
      capabilities,
    );
    expect(
      readCapabilitySession({
        sessionId,
        profileId,
        principal: "token:another-caller",
      }),
    ).toBeUndefined();
  });

  test("does not retain a capability declaration that exceeds the byte budget", () => {
    const key = clientCapabilityKey({
      profileId: "gateway-budget",
      tokenId: "token-budget",
      userAgent: "oversized-sdk",
    });

    clientCapabilityStore.remember({
      key,
      capabilities: {
        futureSdkExtension: { payload: "x".repeat(2 * 1024 * 1024) },
      },
    });

    // The caller can still use a verified session hint; an oversized local
    // declaration must be indistinguishable from an ordinary cache miss.
    expect(clientCapabilityStore.lookup({ key })).toBeUndefined();
  });
});
