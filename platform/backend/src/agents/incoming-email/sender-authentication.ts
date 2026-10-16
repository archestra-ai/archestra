import type { EmailHeader } from "@/types";

/**
 * Decides whether the `From` address of a message received by Exchange Online
 * can be trusted, using only headers Exchange stamps on receipt.
 *
 * A message is authenticated when either:
 * - Exchange marked it as sent from inside the organization
 *   (`X-MS-Exchange-Organization-AuthAs: Internal`). Exchange removes
 *   `X-MS-Exchange-Organization-*` headers from mail that arrives from
 *   untrusted sources (header firewall), so a sender cannot supply this one.
 * - The topmost `Authentication-Results` header (the one Exchange prepends on
 *   receipt) reports `dmarc=pass` for the From domain, or `spf=pass` /
 *   `dkim=pass` for exactly the From domain. Lower `Authentication-Results`
 *   headers were added before the message reached Exchange and are ignored.
 */
export function verifySenderAuthentication(params: {
  headers: EmailHeader[] | undefined;
  fromAddress: string;
}): SenderAuthenticationResult {
  const headers = params.headers ?? [];
  const fromDomain = getDomain(params.fromAddress);
  if (!fromDomain) {
    return { authenticated: false, reason: "sender address has no domain" };
  }

  const authAs = findFirstHeader(headers, ORGANIZATION_AUTH_AS_HEADER);
  if (authAs?.trim().toLowerCase() === "internal") {
    return { authenticated: true, reason: "sent from inside the organization" };
  }

  const authResults = findFirstHeader(headers, AUTHENTICATION_RESULTS_HEADER);
  if (!authResults) {
    return {
      authenticated: false,
      reason: "no Authentication-Results header",
    };
  }

  const results = parseAuthenticationResults(authResults);
  const passesFor = (method: string, property: string) =>
    results.some(
      (result) =>
        result.method === method &&
        result.result === "pass" &&
        result.properties[property] === fromDomain,
    );

  if (passesFor("dmarc", "header.from")) {
    return { authenticated: true, reason: "dmarc=pass" };
  }
  if (passesFor("dkim", "header.d")) {
    return { authenticated: true, reason: "dkim=pass aligned with From" };
  }
  if (passesFor("spf", "smtp.mailfrom")) {
    return { authenticated: true, reason: "spf=pass aligned with From" };
  }

  return {
    authenticated: false,
    reason: "no passing DMARC, or SPF/DKIM aligned with the From domain",
  };
}

/**
 * Parses an `Authentication-Results` value (RFC 8601) into method results.
 * Comments in parentheses are dropped; a leading authserv-id is skipped.
 * Values are lowercased.
 */
function parseAuthenticationResults(
  value: string,
): AuthenticationMethodResult[] {
  const withoutComments = value.replace(/\([^)]*\)/g, " ").toLowerCase();

  return withoutComments.split(";").flatMap((segment) => {
    const [first, ...rest] = segment.trim().split(/\s+/);
    const match = first?.match(/^([a-z0-9-]+)=([a-z0-9-]+)$/);
    if (!match) {
      return [];
    }

    const properties: Record<string, string> = {};
    for (const token of rest) {
      const separator = token.indexOf("=");
      if (separator > 0) {
        properties[token.slice(0, separator)] = token.slice(separator + 1);
      }
    }
    return [{ method: match[1], result: match[2], properties }];
  });
}

interface SenderAuthenticationResult {
  authenticated: boolean;
  /** Short explanation for logs and error messages */
  reason: string;
}

interface AuthenticationMethodResult {
  method: string;
  result: string;
  properties: Record<string, string>;
}

// ===
// Internal helpers
// ===

const ORGANIZATION_AUTH_AS_HEADER = "x-ms-exchange-organization-authas";
const AUTHENTICATION_RESULTS_HEADER = "authentication-results";

function findFirstHeader(
  headers: EmailHeader[],
  name: string,
): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name)?.value;
}

function getDomain(address: string): string | undefined {
  const at = address.lastIndexOf("@");
  if (at < 0) {
    return undefined;
  }
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain || undefined;
}
