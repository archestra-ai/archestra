import config from "@/config";
import {
  isLoopbackAddress,
  isPrivateOrLoopbackHostname,
} from "@/utils/network";

/**
 * Why an outbound URL was refused.
 *
 * Callers turn these into their own user-facing errors — an OIDC discovery
 * endpoint and an A2A webhook fail for the same reasons but should say so in
 * their own words.
 */
export type OutboundUrlRejection =
  | "not_a_url"
  | "scheme_not_https"
  | "private_or_loopback_host";

type OutboundUrlValidation =
  | { ok: true; url: URL }
  | { ok: false; reason: OutboundUrlRejection };

/**
 * Validate a URL the platform is about to fetch on a caller's behalf.
 *
 * Any endpoint supplied by an API caller and then dialed by the server is an
 * SSRF vector: without this check a caller can point us at cluster-internal
 * services, cloud metadata endpoints, or localhost and read the response (or
 * simply cause the request). The rules are:
 *
 *  - it must parse as an absolute URL;
 *  - it must use https, so credentials we attach are not sent in clear text;
 *  - its host must not be a private or loopback address.
 *
 * Local development and e2e runs legitimately point at `http://localhost`, so
 * outside production the scheme requirement is dropped and LOOPBACK hosts are
 * allowed. The relaxation stops at loopback deliberately: a developer needs
 * `localhost`, but nothing legitimate needs a dev box to reach
 * `169.254.169.254` or a cluster-internal RFC1918 address, and those are the
 * targets an SSRF is actually after. Production allows neither.
 *
 * Note this is a syntactic check: it does not resolve DNS, so a hostname that
 * resolves to a private address still passes. Egress policy is the backstop
 * for that; this stops the obvious and much more common cases.
 */
export function validateOutboundUrl(rawUrl: string): OutboundUrlValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }

  const allowLocalTargets =
    !config.production || config.test.enableE2eTestEndpoints;

  if (
    url.protocol !== "https:" &&
    !(allowLocalTargets && url.protocol === "http:")
  ) {
    return { ok: false, reason: "scheme_not_https" };
  }

  if (
    isPrivateOrLoopbackHostname(url.hostname) &&
    !(allowLocalTargets && isLoopbackHost(url.hostname))
  ) {
    return { ok: false, reason: "private_or_loopback_host" };
  }

  return { ok: true, url };
}

/** localhost / *.localhost / 127.0.0.0.0/8 / ::1 — the dev-only exception. */
function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    isLoopbackAddress(normalized)
  );
}
