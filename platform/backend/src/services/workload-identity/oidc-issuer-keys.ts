// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import type { JSONWebKeySet } from "jose";
import type { Agent as UndiciAgent } from "undici";
import { LRUCacheManager } from "@/cache-manager";
import {
  createPinnedOutboundDispatcher,
  validateOutboundUrl,
} from "@/utils/outbound-url";

// Read by the singleton below at import time, so declared before it.
const MAX_CACHED_ISSUERS = 100;
const KEYS_TTL_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_REDIRECTS = 3;
const MAX_KEYS = 100;

/**
 * Why an issuer's signing keys could not be read. Recorded in the audit log,
 * so each names the step that failed and never the response body.
 */
export class OidcIssuerKeysError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "OidcIssuerKeysError";
  }
}

/**
 * The signing keys of OIDC issuers named in federated credentials, read from
 * the issuer's discovery document and JWKS.
 *
 * Every fetch is SSRF-hardened: https only, the host resolved once and refused
 * when any answer is private, loopback or link-local, the connection pinned to
 * that answer, redirects re-checked hop by hop, short timeouts, and a byte cap.
 * Callers only ever pass an issuer some trust policy names exactly, so a
 * token cannot point the server at a URL of its choosing.
 */
class OidcIssuerKeys {
  private cache = new LRUCacheManager<CachedKeys>({
    maxSize: MAX_CACHED_ISSUERS,
    defaultTtl: KEYS_TTL_MS,
  });

  /**
   * The issuer's key set. With `refresh`, a cached copy older than a minute
   * is fetched again: an unknown `kid` usually means the issuer rotated keys,
   * and the minute keeps forged `kid`s from making us hammer the issuer.
   */
  async getKeySet(
    issuer: string,
    options: { refresh?: boolean } = {},
  ): Promise<JSONWebKeySet> {
    const cached = this.cache.get(issuer);
    if (
      cached &&
      !(options.refresh && Date.now() - cached.fetchedAt > MIN_REFRESH_MS)
    )
      return cached.keys;

    const keys = await fetchIssuerKeys(issuer);
    this.cache.set(issuer, { keys, fetchedAt: Date.now() });
    return keys;
  }

  clear(): void {
    this.cache.clear();
  }
}

export const oidcIssuerKeys = new OidcIssuerKeys();

// === Internal helpers

type CachedKeys = { keys: JSONWebKeySet; fetchedAt: number };

async function fetchIssuerKeys(issuer: string): Promise<JSONWebKeySet> {
  const discoveryUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const discovery = await fetchJson(discoveryUrl, "discovery");
  if (!isRecord(discovery))
    throw new OidcIssuerKeysError("discovery document is not a JSON object");
  // OIDC Discovery 1.0 section 4.3: the document must name the issuer it was
  // fetched for, or its keys could vouch for another one.
  if (discovery.issuer !== issuer)
    throw new OidcIssuerKeysError(
      "discovery document names a different issuer",
    );
  if (typeof discovery.jwks_uri !== "string")
    throw new OidcIssuerKeysError("discovery document has no jwks_uri");

  const jwks = await fetchJson(discovery.jwks_uri, "jwks");
  if (!isRecord(jwks) || !Array.isArray(jwks.keys))
    throw new OidcIssuerKeysError("JWKS has no keys array");
  const keys = jwks.keys.filter(isRecord).slice(0, MAX_KEYS);
  if (keys.length === 0) throw new OidcIssuerKeysError("JWKS has no keys");
  return { keys } as JSONWebKeySet;
}

async function fetchJson(
  rawUrl: string,
  what: "discovery" | "jwks",
): Promise<unknown> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let url = rawUrl;
  for (let redirects = 0; ; redirects++) {
    const target = checkUrl(url, what);
    const pinned = await createPinnedOutboundDispatcher({
      hostname: target.hostname,
      allowLoopback: false,
    });
    if (!pinned.ok)
      throw new OidcIssuerKeysError(
        pinned.reason === "unresolved_host"
          ? `${what} host did not resolve`
          : `${what} host resolves to a private or loopback address`,
      );
    const dispatcher: UndiciAgent = pinned.dispatcher;
    try {
      let response: Response;
      try {
        response = await fetch(target, {
          headers: { Accept: "application/json" },
          redirect: "manual",
          signal,
          dispatcher,
        } as RequestInit);
      } catch (error) {
        throw new OidcIssuerKeysError(
          signal.aborted
            ? `${what} request timed out`
            : `${what} request failed${error instanceof Error ? `: ${error.name}` : ""}`,
        );
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        if (redirects >= MAX_REDIRECTS)
          throw new OidcIssuerKeysError(`${what} redirected too many times`);
        const location = response.headers.get("location");
        if (!location)
          throw new OidcIssuerKeysError(`${what} redirect has no location`);
        url = new URL(location, target).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new OidcIssuerKeysError(
          `${what} returned HTTP ${response.status}`,
        );
      }
      const text = await readBounded(response, what);
      try {
        return JSON.parse(text);
      } catch {
        throw new OidcIssuerKeysError(`${what} is not valid JSON`);
      }
    } finally {
      await dispatcher.destroy().catch(() => undefined);
    }
  }
}

function checkUrl(url: string, what: string): URL {
  const validation = validateOutboundUrl(url);
  // https without exception: validateOutboundUrl lets plain http to localhost
  // through in development, which an issuer never needs.
  if (!validation.ok || validation.url.protocol !== "https:")
    throw new OidcIssuerKeysError(
      `${what} URL must be a public https URL (${validation.ok ? "scheme_not_https" : validation.reason})`,
    );
  return validation.url;
}

async function readBounded(response: Response, what: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new OidcIssuerKeysError(`${what} response is too large`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new OidcIssuerKeysError(`${what} response is too large`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
