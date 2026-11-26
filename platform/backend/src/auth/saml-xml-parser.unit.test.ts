import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

/**
 * SAML login verifies the IdP's signature through
 * @better-auth/sso → samlify → xml-crypto, and xml-crypto parses with
 * `new DOMParser().parseFromString(xml)` — no mimeType. @xmldom/xmldom 0.9
 * throws on that, and the failure surfaces only as "Invalid SAML response" on
 * every SAML sign-in. The workspace pins xmldom to 0.9 globally, so this
 * guards the per-consumer exceptions in pnpm-workspace.yaml.
 */
function resolveFrom(fromPath: string, id: string): string {
  return createRequire(fromPath).resolve(id);
}

function loadDomParser(consumer: "samlify" | "xml-crypto") {
  const sso = resolveFrom(import.meta.url, "@better-auth/sso");
  const samlify = resolveFrom(sso, "samlify");
  const owner =
    consumer === "samlify" ? samlify : resolveFrom(samlify, "xml-crypto");
  const xmldomPath = resolveFrom(owner, "@xmldom/xmldom");
  return createRequire(owner)(xmldomPath) as {
    DOMParser: new () => { parseFromString(xml: string): unknown };
  };
}

describe("SAML XML parser dependencies", () => {
  test.each([
    "samlify",
    "xml-crypto",
  ] as const)("%s's xmldom parses XML without a mimeType", (consumer) => {
    const { DOMParser } = loadDomParser(consumer);
    expect(() =>
      new DOMParser().parseFromString("<saml:Response/>"),
    ).not.toThrow();
  });
});
