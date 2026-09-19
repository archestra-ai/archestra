import { describe, expect, test } from "@/test";
import {
  signOfferClaims,
  unsignedOfferClaims,
  verifyOfferClaims,
} from "./offer-claims";

const secret = "test-offer-signing-secret-32chars";

describe("offer claims", () => {
  test("round-trips a flattened JWS with unencoded payload", () => {
    const claims = unsignedOfferClaims({
      organizationId: "org",
      sessionId: "session",
      callerId: "user:owner",
      offerId: "a".repeat(64),
      tool: "Read",
    });
    const signed = signOfferClaims(claims, secret);
    expect(
      JSON.parse(Buffer.from(signed.protected, "base64url").toString()),
    ).toEqual({
      alg: "HS256",
      kid: "default",
      b64: false,
      crit: ["b64"],
    });
    expect(verifyOfferClaims(signed, secret)).toEqual(claims);
  });

  test("carries the dispatch tool a blocked call went through", () => {
    const dispatched = unsignedOfferClaims({
      organizationId: "org",
      sessionId: "session",
      offerId: "offer",
      tool: "archestra__whoami",
      dispatch: "my_gateway_archestra__run_tool",
    });
    expect(
      verifyOfferClaims(signOfferClaims(dispatched, secret), secret),
    ).toMatchObject({ dispatch: "my_gateway_archestra__run_tool" });

    // A direct call signs no dispatch member, so its payload is the one
    // offers signed before the member existed, and those still verify.
    const direct = signOfferClaims(
      unsignedOfferClaims({
        organizationId: "org",
        sessionId: "session",
        offerId: "offer",
      }),
      secret,
    );
    expect(JSON.parse(direct.payload)).not.toHaveProperty("dispatch");
    expect(verifyOfferClaims(direct, secret)).not.toBeNull();
  });

  test("rejects swapped payload, header, or secret", () => {
    const signed = signOfferClaims(
      unsignedOfferClaims({
        organizationId: "org",
        sessionId: "session",
        offerId: "offer",
      }),
      secret,
    );
    expect(
      verifyOfferClaims({ ...signed, payload: '{"offer_id":"other"}' }, secret),
    ).toBeNull();
    expect(verifyOfferClaims(signed, "other-secret")).toBeNull();
    expect(verifyOfferClaims(signed, "")).toBeNull();
    expect(
      verifyOfferClaims({ ...signed, protected: "e30" }, secret),
    ).toBeNull();
  });

  test("MAC input is independent of claim construction order", () => {
    const claims = unsignedOfferClaims({
      organizationId: "org",
      sessionId: "session",
      offerId: "offer",
    });
    const canonical = signOfferClaims(claims, secret).payload;
    const shuffled = signOfferClaims(
      {
        v: claims.v,
        spelling: claims.spelling,
        tool: claims.tool,
        session_id: claims.session_id,
        root: claims.root,
        parent_id: claims.parent_id,
        organization_id: claims.organization_id,
        offer_id: claims.offer_id,
        caller_id: claims.caller_id,
      },
      secret,
    ).payload;
    expect(shuffled).toBe(canonical);
  });
});
