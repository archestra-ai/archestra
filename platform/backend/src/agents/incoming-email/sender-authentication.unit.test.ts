import { describe, expect, test } from "vitest";
import { verifySenderAuthentication } from "./sender-authentication";

const FROM = "alice@contoso.com";

function authResults(value: string) {
  return { name: "Authentication-Results", value };
}

describe("verifySenderAuthentication", () => {
  test("accepts dmarc=pass for the From domain", () => {
    const result = verifySenderAuthentication({
      fromAddress: FROM,
      headers: [
        authResults(
          "spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=bounces.example.net; dkim=pass (signature was verified) header.d=contoso.com;dmarc=pass action=none header.from=contoso.com;compauth=pass reason=100",
        ),
      ],
    });
    expect(result).toEqual({ authenticated: true, reason: "dmarc=pass" });
  });

  test("accepts dkim=pass for the From domain without DMARC", () => {
    const result = verifySenderAuthentication({
      fromAddress: FROM,
      headers: [
        authResults(
          "spf=none smtp.mailfrom=other.example; dkim=pass (signature was verified) header.d=contoso.com;dmarc=none action=none header.from=contoso.com",
        ),
      ],
    });
    expect(result.authenticated).toBe(true);
  });

  test("accepts spf=pass for the From domain without DMARC", () => {
    const result = verifySenderAuthentication({
      fromAddress: "Alice@Contoso.com",
      headers: [
        authResults(
          "spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=Contoso.com; dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=contoso.com",
        ),
      ],
    });
    expect(result.authenticated).toBe(true);
  });

  test("rejects spf/dkim passes for a different domain", () => {
    const result = verifySenderAuthentication({
      fromAddress: FROM,
      headers: [
        authResults(
          "spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=other.example; dkim=pass (signature was verified) header.d=other.example;dmarc=fail action=none header.from=contoso.com;compauth=fail reason=000",
        ),
      ],
    });
    expect(result.authenticated).toBe(false);
  });

  test("rejects dmarc=pass reported for a different From domain", () => {
    const result = verifySenderAuthentication({
      fromAddress: FROM,
      headers: [
        authResults("dmarc=pass action=none header.from=other.example"),
      ],
    });
    expect(result.authenticated).toBe(false);
  });

  test("rejects failing authentication", () => {
    const result = verifySenderAuthentication({
      fromAddress: FROM,
      headers: [
        authResults(
          "spf=fail (sender IP is 192.0.2.1) smtp.mailfrom=contoso.com; dkim=fail (body hash did not verify) header.d=contoso.com;dmarc=fail action=oreject header.from=contoso.com",
        ),
      ],
    });
    expect(result.authenticated).toBe(false);
  });

  test("rejects when there are no headers", () => {
    expect(
      verifySenderAuthentication({ fromAddress: FROM, headers: undefined }),
    ).toEqual({
      authenticated: false,
      reason: "no Authentication-Results header",
    });
    expect(
      verifySenderAuthentication({ fromAddress: FROM, headers: [] })
        .authenticated,
    ).toBe(false);
  });

  test("only trusts the topmost Authentication-Results header", () => {
    const result = verifySenderAuthentication({
      fromAddress: FROM,
      headers: [
        { name: "Received", value: "from mail.example by exchange" },
        authResults(
          "spf=softfail (sender IP is 192.0.2.1) smtp.mailfrom=contoso.com; dkim=none (message not signed) header.d=none;dmarc=fail action=none header.from=contoso.com",
        ),
        { name: "Received", value: "from sender by mail.example" },
        authResults(
          "mx.example; spf=pass smtp.mailfrom=contoso.com; dkim=pass header.d=contoso.com; dmarc=pass header.from=contoso.com",
        ),
      ],
    });
    expect(result.authenticated).toBe(false);
  });

  test("accepts mail Exchange marked as internal to the organization", () => {
    const result = verifySenderAuthentication({
      fromAddress: FROM,
      headers: [
        { name: "X-MS-Exchange-Organization-AuthAs", value: "Internal" },
        {
          name: "X-MS-Exchange-Organization-AuthSource",
          value: "BN0PR01MB0000.namprd01.prod.outlook.com",
        },
      ],
    });
    expect(result).toEqual({
      authenticated: true,
      reason: "sent from inside the organization",
    });
  });

  test("does not treat anonymous or cross-tenant internal mail as internal", () => {
    const result = verifySenderAuthentication({
      fromAddress: FROM,
      headers: [
        { name: "X-MS-Exchange-Organization-AuthAs", value: "Anonymous" },
        { name: "X-MS-Exchange-CrossTenant-AuthAs", value: "Internal" },
      ],
    });
    expect(result.authenticated).toBe(false);
  });

  test("rejects a sender address without a domain", () => {
    const result = verifySenderAuthentication({
      fromAddress: "unknown",
      headers: [
        { name: "X-MS-Exchange-Organization-AuthAs", value: "Internal" },
      ],
    });
    expect(result.authenticated).toBe(false);
  });

  test("skips an authserv-id and comments containing semicolons", () => {
    const result = verifySenderAuthentication({
      fromAddress: FROM,
      headers: [
        authResults(
          "mx.example; spf=pass (sender IP is 192.0.2.1; header.from=evil.example) smtp.mailfrom=Contoso.com",
        ),
      ],
    });
    expect(result).toEqual({
      authenticated: true,
      reason: "spf=pass aligned with From",
    });
  });

  test("does not let a comment stand in for a property", () => {
    const result = verifySenderAuthentication({
      fromAddress: FROM,
      headers: [
        authResults(
          "dmarc=pass (header.from=contoso.com) action=none header.from=evil.example",
        ),
      ],
    });
    expect(result.authenticated).toBe(false);
  });
});
