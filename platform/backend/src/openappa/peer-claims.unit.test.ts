import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  peerProofAuthorizes,
  signPeerProof,
  verifyPeerProof,
} from "./peer-claims";

const secret = "peer-proof-secret";

const claims: Parameters<typeof signPeerProof>[0] = {
  v: 1,
  organization_id: "org-1",
  caller_id: "user:alice",
  session_id: "user:alice|lead:worker",
  parent_id: "user:alice|lead",
  call_id: "toolu_read",
  action: "read_peer_message",
  message_id: "6f9619ff-8b86-4d11-b42d-00c04fc964ff",
};

describe("peer proofs", () => {
  test("a signed proof authorizes only that caller, action, and message", () => {
    const signed = signPeerProof(claims, secret);
    expect(signed).toBeDefined();
    const proof = verifyPeerProof(signed, secret);
    expect(proof).toEqual(claims);
    expect(
      peerProofAuthorizes({
        proof: proof ?? claims,
        organizationId: claims.organization_id,
        callerId: "user:alice",
        action: "read_peer_message",
        messageId: claims.message_id ?? undefined,
      }),
    ).toBe(true);
    expect(
      peerProofAuthorizes({
        proof: proof ?? claims,
        organizationId: claims.organization_id,
        callerId: "user:bob",
        action: "read_peer_message",
        messageId: claims.message_id ?? undefined,
      }),
    ).toBe(false);
    expect(
      peerProofAuthorizes({
        proof: proof ?? claims,
        organizationId: claims.organization_id,
        callerId: "user:alice",
        action: "list_peer_messages",
      }),
    ).toBe(false);
  });

  test("a remedy-shaped MAC does not verify as a peer proof", () => {
    const signed = signPeerProof(claims, secret);
    if (!signed) throw new Error("expected a proof");
    const remedyMac = createHmac("sha256", secret)
      .update(`${signed.protected}.${signed.payload}`)
      .digest("base64url");
    expect(
      verifyPeerProof({ ...signed, signature: remedyMac }, secret),
    ).toBeNull();
  });

  test("an altered payload or the wrong secret does not verify", () => {
    const signed = signPeerProof(claims, secret);
    expect(verifyPeerProof(signed, "other-secret")).toBeNull();
    if (!signed) throw new Error("expected a proof");
    expect(
      verifyPeerProof(
        { ...signed, payload: signed.payload.replace("alice", "bob") },
        secret,
      ),
    ).toBeNull();
  });
});
