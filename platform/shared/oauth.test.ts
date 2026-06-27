import { describe, expect, it } from "vitest";

import { OAUTH_ENDPOINTS, OAUTH_ISSUER_ROOT_ALIASES } from "./oauth";

describe("OAUTH_ISSUER_ROOT_ALIASES", () => {
  it("aliases the conventional issuer-relative root paths", () => {
    const roots = OAUTH_ISSUER_ROOT_ALIASES.map((alias) => alias.root);
    // The paths a non-discovering client falls back to: RFC 6749 §3.1/§3.2 and
    // RFC 7591 §3. jwks is excluded — it is only ever read from `jwks_uri`.
    expect(roots).toEqual(["/authorize", "/token", "/register"]);
  });

  it("maps each alias to the canonical endpoint the metadata advertises", () => {
    // Drift guard: an alias must point at exactly the path the authorization
    // server metadata advertises, otherwise a non-discovering client lands on a
    // different handler than a discovering one.
    const byRoot = Object.fromEntries(
      OAUTH_ISSUER_ROOT_ALIASES.map((alias) => [alias.root, alias.canonical]),
    );
    expect(byRoot["/authorize"]).toBe(OAUTH_ENDPOINTS.authorize);
    expect(byRoot["/token"]).toBe(OAUTH_ENDPOINTS.token);
    expect(byRoot["/register"]).toBe(OAUTH_ENDPOINTS.register);
  });

  it("only aliases real OAuth endpoints", () => {
    const canonicalPaths = new Set<string>(Object.values(OAUTH_ENDPOINTS));
    for (const { canonical } of OAUTH_ISSUER_ROOT_ALIASES) {
      expect(canonicalPaths.has(canonical)).toBe(true);
    }
  });
});
