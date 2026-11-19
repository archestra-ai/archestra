// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  type JSONWebKeySet,
  jwtVerify,
} from "jose";
import { vi } from "vitest";
import config from "@/config";
import { SpiffeSigningKeyModel } from "@/models";
import {
  SPIFFE_BUNDLE_PATH,
  SPIFFE_DISCOVERY_PATH,
  SPIFFE_JWKS_PATH,
} from "@/routes/route-paths";
import {
  spiffeIdForAgent,
  spiffeIssuer,
} from "@/services/identity-providers/enterprise-managed/spiffe-issuer";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import spiffeRoutes from "./spiffe.routes";

const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIENCE = "https://idp.example.com/realms/acme";

describe("SPIFFE issuer routes", () => {
  const ctx = useRouteTestApp(spiffeRoutes);

  beforeEach(() => {
    spiffeIssuer.clearCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("publishes a discovery document and keys that verify the agents' SVIDs", async () => {
    const discovery = await ctx.app.inject({
      method: "GET",
      url: SPIFFE_DISCOVERY_PATH,
    });
    expect(discovery.statusCode).toBe(200);
    const issuer = `${config.frontendBaseUrl}/api/agent-identity/spiffe`;
    expect(discovery.json()).toMatchObject({
      issuer,
      jwks_uri: `${config.frontendBaseUrl}${SPIFFE_JWKS_PATH}`,
    });

    const spiffeId = spiffeIdForAgent("agent-1");
    const svid = await spiffeIssuer.mintJwtSvid({
      spiffeId,
      audience: AUDIENCE,
    });
    const { payload, protectedHeader } = await jwtVerify(
      svid,
      createLocalJWKSet(await getKeySet(SPIFFE_JWKS_PATH)),
      { issuer, audience: AUDIENCE },
    );

    expect(spiffeId).toBe(
      `spiffe://${config.agentIdentity.spiffeTrustDomain}/agent/agent-1`,
    );
    expect(payload.sub).toBe(spiffeId);
    expect(protectedHeader.alg).toBe("ES256");
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
  });

  test("serves the same keys as a SPIFFE trust bundle", async () => {
    const jwks = await getKeySet(SPIFFE_JWKS_PATH);
    const response = await ctx.app.inject({
      method: "GET",
      url: SPIFFE_BUNDLE_PATH,
    });

    const bundle = response.json();
    expect(bundle.spiffe_refresh_hint).toBeGreaterThan(0);
    expect(bundle.keys.map((key: { kid: string }) => key.kid)).toEqual(
      jwks.keys.map((key) => key.kid),
    );
    expect(
      bundle.keys.every((key: { use: string }) => key.use === "jwt-svid"),
    ).toBe(true);
    expect(jwks.keys.every((key) => key.use === "sig")).toBe(true);
  });

  test("rotates the signing key after thirty days, signs with it once every replica publishes it, and keeps the replaced key published for a day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const firstKid = await signingKid();

    vi.setSystemTime(start + 31 * DAY_MS);
    spiffeIssuer.clearCache();
    expect(await signingKid()).toBe(firstKid);
    const [secondKid, ...rest] = await publishedKids();
    expect(rest).toEqual([firstKid]);
    expect(secondKid).not.toBe(firstKid);

    vi.setSystemTime(start + 31 * DAY_MS + 6 * 60 * 1000);
    spiffeIssuer.clearCache();
    expect(await signingKid()).toBe(secondKid);

    vi.setSystemTime(start + 33 * DAY_MS);
    spiffeIssuer.clearCache();
    expect(await signingKid()).toBe(secondKid);
    expect(await publishedKids()).toEqual([secondKid]);
  });

  test("mints one key however many first requests arrive at once", async () => {
    const keySets = await Promise.all(
      Array.from({ length: 5 }, async () => {
        spiffeIssuer.clearCache();
        return getKeySet(SPIFFE_JWKS_PATH);
      }),
    );

    expect(await SpiffeSigningKeyModel.findNewest(10)).toHaveLength(1);
    expect(new Set(keySets.map((keySet) => keySet.keys[0]?.kid)).size).toBe(1);
  });

  async function getKeySet(url: string): Promise<JSONWebKeySet> {
    const response = await ctx.app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function signingKid(): Promise<string | undefined> {
    const svid = await spiffeIssuer.mintJwtSvid({
      spiffeId: spiffeIdForAgent("agent-1"),
      audience: AUDIENCE,
    });
    return decodeProtectedHeader(svid).kid;
  }

  async function publishedKids(): Promise<Array<string | undefined>> {
    return (await getKeySet(SPIFFE_JWKS_PATH)).keys.map((key) => key.kid);
  }
});
