/**
 * MRTR request-state security.
 *
 * `requestState` travels through the client, so the spec treats it as
 * attacker-controlled and requires integrity protection plus rejection of state
 * that fails it. These pin the three replay bounds the spec asks for —
 * principal, expiry, and originating request — because a hole in any one of
 * them is a cross-user or cross-call authorisation bug, not a protocol nit.
 */

import { describe, expect, test } from "@/test";
import {
  buildInputRequiredResult,
  clientSupportsInputRequest,
  deriveStatePrincipal,
  encodeRequestState,
  extractMrtrParams,
  REQUEST_STATE_TTL_MS,
  supportsInputRequired,
  verifyRequestState,
} from "./mcp-gateway.mrtr";

const PRINCIPAL = "user:alice";
const METHOD = "tools/call";
const PARAMS = { name: "send_message", arguments: { channel: "#general" } };

function mint(
  overrides: Partial<Parameters<typeof encodeRequestState>[0]> = {},
) {
  return encodeRequestState({
    principal: PRINCIPAL,
    method: METHOD,
    requestParams: PARAMS,
    keys: ["github_login"],
    ...overrides,
  });
}

function verify(
  state: string,
  overrides: Partial<Parameters<typeof verifyRequestState>[0]> = {},
) {
  return verifyRequestState({
    state,
    principal: PRINCIPAL,
    method: METHOD,
    requestParams: PARAMS,
    ...overrides,
  });
}

describe("requestState round trip", () => {
  test("state minted for a request verifies on the matching retry", () => {
    const result = verify(mint());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected verification to succeed");
    expect(result.payload.principal).toBe(PRINCIPAL);
    expect(result.payload.keys).toEqual(["github_login"]);
  });

  test("the retry may carry MRTR fields the original did not", () => {
    // The retry necessarily adds inputResponses and requestState. If those
    // counted toward the request digest, no retry could ever verify.
    const state = mint();

    const result = verify(state, {
      requestParams: {
        ...PARAMS,
        inputResponses: { github_login: { action: "accept" } },
        requestState: state,
      },
    });

    expect(result.ok).toBe(true);
  });

  test("parameter key order does not change the binding", () => {
    const result = verify(mint(), {
      requestParams: {
        arguments: { channel: "#general" },
        name: "send_message",
      },
    });

    expect(result.ok).toBe(true);
  });
});

describe("requestState rejection", () => {
  test("a tampered payload is rejected", () => {
    const state = mint();
    const [encoded, signature] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        principal: "user:mallory",
        method: METHOD,
        paramsDigest: "whatever",
        exp: Date.now() + 60_000,
        keys: [],
      }),
      "utf8",
    ).toString("base64url");
    void encoded;

    const result = verifyRequestState({
      state: `${forged}.${signature}`,
      principal: "user:mallory",
      method: METHOD,
      requestParams: PARAMS,
    });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("a state minted for another principal is rejected", () => {
    // Both callers may hold valid tokens for the same gateway; the binding is
    // what stops one redeeming the other's elicitation.
    const result = verify(mint(), { principal: "user:mallory" });

    expect(result).toEqual({ ok: false, reason: "principal_mismatch" });
  });

  test("a state minted for a different tool call is rejected", () => {
    const result = verify(mint(), {
      requestParams: { name: "delete_everything", arguments: {} },
    });

    expect(result).toEqual({ ok: false, reason: "request_mismatch" });
  });

  test("a state minted for a different method is rejected", () => {
    const result = verify(mint(), { method: "resources/read" });

    expect(result).toEqual({ ok: false, reason: "request_mismatch" });
  });

  test("an expired state is rejected", () => {
    const mintedAt = 1_000_000;
    const state = mint({ now: mintedAt });

    const result = verify(state, { now: mintedAt + REQUEST_STATE_TTL_MS + 1 });

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  test("a state is still redeemable just inside its window", () => {
    const mintedAt = 1_000_000;
    const state = mint({ now: mintedAt });

    const result = verify(state, { now: mintedAt + REQUEST_STATE_TTL_MS - 1 });

    expect(result.ok).toBe(true);
  });

  test("structurally invalid state is rejected rather than throwing", () => {
    for (const state of ["", ".", "nodot", "abc.", ".abc"]) {
      const result = verify(state);
      expect(result.ok).toBe(false);
    }
  });

  test("a signature over different content does not verify", () => {
    const other = mint({ requestParams: { name: "other", arguments: {} } });
    const [, otherSignature] = other.split(".");
    const [mineEncoded] = mint().split(".");

    const result = verify(`${mineEncoded}.${otherSignature}`);

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("deriveStatePrincipal", () => {
  test("prefers the individual user", () => {
    expect(
      deriveStatePrincipal({
        userId: "u1",
        tokenId: "t1",
        organizationId: "o1",
      }),
    ).toBe("user:u1");
  });

  test("falls back to the token for org and team tokens", () => {
    expect(deriveStatePrincipal({ tokenId: "t1", organizationId: "o1" })).toBe(
      "token:t1",
    );
  });

  test("distinct callers never collapse onto the same principal", () => {
    const a = deriveStatePrincipal({ userId: "u1" });
    const b = deriveStatePrincipal({ userId: "u2" });
    const c = deriveStatePrincipal({ tokenId: "u1" });

    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("InputRequiredResult", () => {
  test("carries the input_required result type", () => {
    const result = buildInputRequiredResult({
      inputRequests: {
        github_login: {
          method: "elicitation/create",
          params: { message: "Sign in" },
        },
      },
      requestState: "state",
    });

    expect(result.resultType).toBe("input_required");
    expect(result.inputRequests?.github_login.method).toBe(
      "elicitation/create",
    );
  });

  test("refuses a result a client could not act on", () => {
    // The spec requires at least one of the two fields.
    expect(() => buildInputRequiredResult({})).toThrow();
  });
});

describe("supported methods", () => {
  test("only the three methods the spec allows may ask for input", () => {
    expect(supportsInputRequired("tools/call")).toBe(true);
    expect(supportsInputRequired("prompts/get")).toBe(true);
    expect(supportsInputRequired("resources/read")).toBe(true);

    expect(supportsInputRequired("tools/list")).toBe(false);
    expect(supportsInputRequired("server/discover")).toBe(false);
    expect(supportsInputRequired(undefined)).toBe(false);
  });
});

describe("extractMrtrParams", () => {
  test("reads the fields the SDK request schema drops", () => {
    const extracted = extractMrtrParams({
      method: "tools/call",
      params: {
        name: "t",
        inputResponses: { k: { action: "accept" } },
        requestState: "abc.def",
      },
    });

    expect(extracted.requestState).toBe("abc.def");
    expect(extracted.inputResponses).toEqual({ k: { action: "accept" } });
  });

  test("ignores fields of the wrong shape", () => {
    const extracted = extractMrtrParams({
      params: { inputResponses: "not-an-object", requestState: 42 },
    });

    expect(extracted).toEqual({});
  });

  test("tolerates a body with no params", () => {
    expect(extractMrtrParams({ method: "tools/call" })).toEqual({});
    expect(extractMrtrParams(null)).toEqual({});
  });
});

describe("clientSupportsInputRequest", () => {
  test("permits a request the client declared", () => {
    expect(
      clientSupportsInputRequest({
        clientCapabilities: { elicitation: {} },
        request: { method: "elicitation/create" },
      }),
    ).toBe(true);
  });

  test("refuses a request the client never declared", () => {
    // The spec forbids asking a client for something it cannot do.
    expect(
      clientSupportsInputRequest({
        clientCapabilities: { sampling: {} },
        request: { method: "elicitation/create" },
      }),
    ).toBe(false);
  });

  test("absent capabilities permit nothing", () => {
    expect(
      clientSupportsInputRequest({
        clientCapabilities: undefined,
        request: { method: "elicitation/create" },
      }),
    ).toBe(false);
  });
});
