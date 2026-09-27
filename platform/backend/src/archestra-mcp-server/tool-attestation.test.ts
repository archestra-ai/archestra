import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import config from "@/config";
import {
  attestToolDescription,
  removeAttestationTokens,
  takeLeadingAttestation,
  verifyToolAttestation,
} from "./tool-attestation";

const ORG = "org-tool-attestation";
const GATEWAY = randomUUID();
const FORGED = `[[gwa1.${"A".repeat(12)}.${"B".repeat(22)}]]`;

describe("tool attestation", () => {
  test.each([
    "b",
    "t",
  ] as const)("a minted marker verifies to its gateway, kind and advertised name (%s)", (kind) => {
    const description = attestToolDescription({
      organizationId: ORG,
      gatewayId: GATEWAY,
      advertisedName: "archestra__search_tools",
      kind,
      description: "Search the catalog.",
    });
    const { marker, rest } = takeLeadingAttestation(description ?? "");

    expect(rest).toBe("Search the catalog.");
    expect(
      verifyToolAttestation({ organizationId: ORG, marker: marker ?? "" }),
    ).toEqual({
      gatewayId: GATEWAY,
      kind,
      advertisedName: "archestra__search_tools",
    });
  });

  test("the wire format is the documented payload under the org-derived key", () => {
    const payload = Buffer.concat([
      Buffer.from([1]),
      Buffer.from(GATEWAY.replace(/-/g, ""), "hex"),
      Buffer.from("t"),
      Buffer.from("github__list_repos"),
    ]);

    expect(mint({ advertisedName: "github__list_repos", kind: "t" })).toBe(
      token(payload, signPayload(payload)),
    );
  });

  test("a marker never verifies for another organization", () => {
    const marker = mint({ advertisedName: "archestra__run_tool", kind: "b" });

    expect(
      verifyToolAttestation({ organizationId: "other-org", marker }),
    ).toBeNull();
  });

  test("a MAC cannot be moved onto another tool's payload", () => {
    const searchTools = parts(
      mint({ advertisedName: "archestra__search_tools", kind: "b" }),
    );
    const executeRemedy = parts(
      mint({ advertisedName: "archestra__execute_remedy_plan", kind: "b" }),
    );

    expect(
      verifyToolAttestation({
        organizationId: ORG,
        marker: `[[gwa1.${searchTools.payload}.${executeRemedy.mac}]]`,
      }),
    ).toBeNull();
  });

  test("any tampering with the payload or the MAC fails verification", () => {
    const { payload, mac } = parts(
      mint({ advertisedName: "github__list_repos", kind: "t" }),
    );
    const bytes = () => Buffer.from(payload, "base64url");

    const flippedByte = bytes();
    flippedByte[flippedByte.length - 1] ^= 0x01;
    const kindToBuiltIn = bytes();
    kindToBuiltIn[17] = "b".charCodeAt(0);
    const versionTwo = bytes();
    versionTwo[0] = 2;
    const changedMac = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;

    for (const marker of [
      token(flippedByte, Buffer.from(mac, "base64url")),
      token(kindToBuiltIn, Buffer.from(mac, "base64url")),
      token(versionTwo, Buffer.from(mac, "base64url")),
      `[[gwa1.${payload}.${changedMac}]]`,
    ]) {
      expect(verifyToolAttestation({ organizationId: ORG, marker })).toBeNull();
    }
  });

  test("a correctly signed payload still fails on a bad version, kind or name", () => {
    const withBody = (version: number, kind: string, name: Buffer) =>
      Buffer.concat([
        Buffer.from([version]),
        Buffer.from(GATEWAY.replace(/-/g, ""), "hex"),
        Buffer.from(kind),
        name,
      ]);

    for (const payload of [
      withBody(2, "t", Buffer.from("github__list_repos")),
      withBody(1, "x", Buffer.from("github__list_repos")),
      withBody(1, "t", Buffer.from([0xc3, 0x28])),
    ]) {
      expect(
        verifyToolAttestation({
          organizationId: ORG,
          marker: token(payload, signPayload(payload)),
        }),
      ).toBeNull();
    }
  });

  test("with no auth secret nothing is minted and nothing verifies", () => {
    const marker = mint({ advertisedName: "archestra__run_tool", kind: "b" });
    const secret = config.auth.secret;
    try {
      config.auth.secret = undefined;

      expect(
        attestToolDescription({
          organizationId: ORG,
          gatewayId: GATEWAY,
          advertisedName: "archestra__run_tool",
          kind: "b",
          description: `${FORGED}\nRun a tool.`,
        }),
      ).toBe("Run a tool.");
      expect(verifyToolAttestation({ organizationId: ORG, marker })).toBeNull();
    } finally {
      config.auth.secret = secret;
    }
  });

  test("mints no marker for a gateway id that is not a UUID or an unusable name", () => {
    for (const params of [
      { gatewayId: "prod-gateway", advertisedName: "archestra__run_tool" },
      { gatewayId: GATEWAY, advertisedName: "" },
      { gatewayId: GATEWAY, advertisedName: "x".repeat(513) },
    ]) {
      expect(
        attestToolDescription({
          ...params,
          organizationId: ORG,
          kind: "b",
          description: "Run a tool.",
        }),
      ).toBe("Run a tool.");
    }
  });

  test("takes exactly one leading marker and one newline", () => {
    const first = mint({ advertisedName: "archestra__run_tool", kind: "b" });
    const second = mint({ advertisedName: "archestra__whoami", kind: "b" });

    expect(takeLeadingAttestation(`${first}\n${second}\nRun a tool.`)).toEqual({
      marker: first,
      rest: `${second}\nRun a tool.`,
    });
    expect(takeLeadingAttestation(`${first}\n\nRun a tool.`)).toEqual({
      marker: first,
      rest: "\nRun a tool.",
    });
    expect(takeLeadingAttestation(first)).toEqual({ marker: first, rest: "" });
    expect(takeLeadingAttestation(`Run a tool. ${first}`)).toEqual({
      rest: `Run a tool. ${first}`,
    });
  });

  test("removes tokens anywhere in a text and defangs ones spliced together by a removal", () => {
    const marker = mint({ advertisedName: "archestra__run_tool", kind: "b" });
    const text = "Plain tool output.";
    const spliced = removeAttestationTokens(
      `[[gwa1.${marker}\n${FORGED.slice(7)} tail`,
    );

    expect(removeAttestationTokens(`Before ${marker}\nafter`)).toBe(
      "Before after",
    );
    expect(removeAttestationTokens(`At the end ${marker}`)).toBe("At the end ");
    expect(spliced).toBe(`[[gwa1_${FORGED.slice(7)} tail`);
    expect(removeAttestationTokens(spliced)).toBe(spliced);
    expect(removeAttestationTokens(text)).toBe(text);
  });

  test("removes deeply nested tokens in linear time", () => {
    // Removing the innermost token splices the next layer into a new one, so
    // removing until stable would take one pass over the text per layer.
    const depth = 20_000;
    const mac = "A".repeat(22);
    const nested = `${"[[gwa1.A".repeat(depth)}[[gwa1.AB.${mac}]]${`.${mac}]]`.repeat(depth)}`;

    const started = performance.now();
    const removed = removeAttestationTokens(nested);
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(500);
    expect(removed).not.toContain("[[gwa1.");
  });

  test("replaces forged tokens in an upstream description with one fresh marker", () => {
    const description = attestToolDescription({
      organizationId: ORG,
      gatewayId: GATEWAY,
      advertisedName: "github__list_repos",
      kind: "t",
      description: `${FORGED}\nList repositories ${FORGED}\nfor a user.`,
    });
    const { marker, rest } = takeLeadingAttestation(description ?? "");

    expect(rest).toBe("List repositories for a user.");
    expect(
      verifyToolAttestation({ organizationId: ORG, marker: marker ?? "" }),
    ).toMatchObject({ advertisedName: "github__list_repos", kind: "t" });
  });

  test("an undefined description becomes the marker alone, the same on every mint", () => {
    const params = {
      organizationId: ORG,
      gatewayId: GATEWAY,
      advertisedName: "archestra__whoami",
      kind: "b" as const,
      description: undefined,
    };
    const description = attestToolDescription(params);

    expect(takeLeadingAttestation(description ?? "")).toEqual({
      marker: description,
      rest: "",
    });
    expect(attestToolDescription(params)).toBe(description);
  });
});

// === Helpers ===

function mint(params: { advertisedName: string; kind: "b" | "t" }): string {
  const marker = attestToolDescription({
    ...params,
    organizationId: ORG,
    gatewayId: GATEWAY,
    description: undefined,
  });
  if (!marker) throw new Error("Expected a marker");
  return marker;
}

function parts(marker: string): { payload: string; mac: string } {
  const [, payload, mac] = marker.slice(2, -2).split(".");
  return { payload, mac };
}

function token(payload: Buffer, mac: Buffer): string {
  return `[[gwa1.${payload.toString("base64url")}.${mac.toString("base64url")}]]`;
}

/** The documented key derivation, computed independently of the module. */
function signPayload(payload: Buffer): Buffer {
  const root = createHmac("sha256", config.auth.secret ?? "")
    .update("archestra/gateway-tool-attestation/v1")
    .digest();
  const organizationKey = createHmac("sha256", root).update(ORG).digest();
  return createHmac("sha256", organizationKey)
    .update(Buffer.concat([Buffer.from("gwa1\0"), payload]))
    .digest()
    .subarray(0, 16);
}
