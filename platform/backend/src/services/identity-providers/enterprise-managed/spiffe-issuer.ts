// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { randomUUID } from "node:crypto";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  SignJWT,
} from "jose";
import config from "@/config";
import { LRUCacheManager } from "@/in-memory-lru-cache";
import logger from "@/logging";
import { SpiffeSigningKeyModel } from "@/models";
import { SPIFFE_ISSUER_PATH, SPIFFE_JWKS_PATH } from "@/routes/route-paths";
import { secretManager } from "@/secrets-manager";
import type { SpiffeSigningKey } from "@/types/spiffe-signing-key";

// Read by the singleton below at import time, so declared before it.
const SIGNING_ALGORITHM = "ES256";
/** How long a JWT-SVID lives. Short, as SPIFFE recommends for JWT-SVIDs. */
const SVID_LIFETIME_SECONDS = 5 * 60;
/** How long a key signs before a new one replaces it. */
const KEY_ROTATION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long a replaced key stays published. Far longer than any SVID it signed
 * lives, so verifiers that cache the key set keep verifying through rotation.
 */
const RETIRED_KEY_PUBLISHED_MS = 24 * 60 * 60 * 1000;
const SIGNING_KEY_CACHE_MS = 5 * 60 * 1000;
const PUBLISHED_KEYS_CACHE_MS = 60 * 1000;
/**
 * How long a new key waits before it signs: past every replica's key set
 * cache and the key set's HTTP `max-age`, both a minute.
 */
const KEY_ACTIVATION_MS = 5 * 60 * 1000;
const MAX_KEYS_READ = 10;

/** The SPIFFE ID an agent acts as: `spiffe://<trust domain>/agent/<id>`. */
export function spiffeIdForAgent(agentId: string): string {
  return `spiffe://${config.agentIdentity.spiffeTrustDomain}/agent/${agentId}`;
}

/**
 * The SPIFFE ID the platform itself acts as when no agent is calling, such as
 * when it lists an MCP server's tools: `spiffe://<trust domain>/platform`.
 */
export function platformSpiffeId(): string {
  return `spiffe://${config.agentIdentity.spiffeTrustDomain}/platform`;
}

/**
 * Archestra as the issuer of its agents' JWT-SVIDs (SPIFFE JWT-SVID standard).
 *
 * Archestra makes tool calls for its agents itself, so it vouches for them:
 * each agent's SVID names its SPIFFE ID in `sub` and is signed with a key
 * Archestra keeps. Verifiers trust that key through the issuer's OIDC
 * discovery document and key set, or through the SPIFFE trust bundle, the
 * way they would trust SPIRE's OIDC discovery provider or bundle endpoint.
 */
class SpiffeIssuer {
  private signingKeyCache = new LRUCacheManager<SigningKey>({
    maxSize: 1,
    defaultTtl: SIGNING_KEY_CACHE_MS,
  });
  private publishedKeysCache = new LRUCacheManager<JWK[]>({
    maxSize: 1,
    defaultTtl: PUBLISHED_KEYS_CACHE_MS,
  });
  private minting: Promise<void> | null = null;

  /** The issuer identifier, `iss` in every SVID. */
  get issuer(): string {
    return `${config.frontendBaseUrl}${SPIFFE_ISSUER_PATH}`;
  }

  /** A JWT-SVID for one SPIFFE ID, valid for five minutes. */
  async mintJwtSvid(params: {
    spiffeId: string;
    audience: string;
  }): Promise<string> {
    // It vouches only for its own agents and itself.
    if (
      params.spiffeId !== platformSpiffeId() &&
      !params.spiffeId.startsWith(spiffeIdForAgent(""))
    ) {
      throw new Error(
        "JWT-SVIDs are issued only for this deployment's own SPIFFE IDs",
      );
    }
    const signingKey = await this.getSigningKey();
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({
        alg: SIGNING_ALGORITHM,
        kid: signingKey.kid,
        typ: "JWT",
      })
      .setIssuer(this.issuer)
      .setSubject(params.spiffeId)
      .setAudience(params.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + SVID_LIFETIME_SECONDS)
      .setJti(randomUUID())
      .sign(signingKey.privateKey);
  }

  /** The OIDC discovery document verifiers find the key set through. */
  discoveryDocument() {
    return {
      issuer: this.issuer,
      jwks_uri: `${config.frontendBaseUrl}${SPIFFE_JWKS_PATH}`,
      id_token_signing_alg_values_supported: [SIGNING_ALGORITHM],
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
    };
  }

  /** The issuer's key set, as OIDC verifiers read it (`use: "sig"`). */
  async jwks(): Promise<{ keys: JWK[] }> {
    const keys = await this.getPublishedKeys();
    return { keys: keys.map((key) => ({ ...key, use: "sig" })) };
  }

  /**
   * The trust bundle of the trust domain, in the SPIFFE bundle format: the
   * same keys, marked for JWT-SVIDs, for SPIFFE federation.
   */
  async trustBundle(): Promise<{
    keys: JWK[];
    spiffe_refresh_hint: number;
  }> {
    const keys = await this.getPublishedKeys();
    return {
      keys: keys.map((key) => ({ ...key, use: "jwt-svid" })),
      spiffe_refresh_hint: PUBLISHED_KEYS_CACHE_MS / 1000,
    };
  }

  /** Drops cached keys, so the next call reads them again. */
  clearCache(): void {
    this.signingKeyCache.clear();
    this.publishedKeysCache.clear();
  }

  /**
   * The newest key, and every key it replaced within the last day. A key set
   * is never empty: the first read mints the first key, so a verifier set up
   * before any SVID was issued already knows the key the first one uses.
   */
  private async getPublishedKeys(): Promise<JWK[]> {
    const cached = this.publishedKeysCache.get(PUBLISHED_KEYS_CACHE_KEY);
    if (cached) return cached;
    await this.getSigningKey();
    const rows = await SpiffeSigningKeyModel.findNewest(MAX_KEYS_READ);
    const published = rows.filter(
      (_row, index) =>
        index === 0 ||
        rows[index - 1].createdAt.getTime() >
          Date.now() - RETIRED_KEY_PUBLISHED_MS,
    );
    const keys = published.map((row) => ({
      ...row.publicJwk,
      kid: row.id,
      alg: SIGNING_ALGORITHM,
    }));
    this.publishedKeysCache.set(PUBLISHED_KEYS_CACHE_KEY, keys);
    return keys;
  }

  /**
   * The key to sign with: the newest that every replica already publishes.
   * A new key waits out the key set cache before it signs, so a verifier
   * never meets a key ID a replica's cached key set lacks; until then its
   * predecessor signs. The first key signs at once: no key set was cached
   * without it. A key is minted when there is none or the newest is thirty
   * days old.
   */
  private async getSigningKey(): Promise<SigningKey> {
    const cached = this.signingKeyCache.get(SIGNING_KEY_CACHE_KEY);
    if (cached) return cached;
    let rows = await SpiffeSigningKeyModel.findNewest(2);
    if (needsNewKey(rows[0])) {
      // One mint at a time in this process; the model's lock covers replicas.
      this.minting ??= this.mintKey().finally(() => {
        this.minting = null;
      });
      await this.minting;
      rows = await SpiffeSigningKeyModel.findNewest(2);
    }
    const row =
      rows.find(
        (candidate) =>
          candidate.createdAt.getTime() <= Date.now() - KEY_ACTIVATION_MS,
      ) ?? rows[rows.length - 1];
    if (!row) {
      throw new Error("No SPIFFE signing key could be read");
    }
    const signingKey = await this.loadSigningKey(row);
    this.signingKeyCache.set(SIGNING_KEY_CACHE_KEY, signingKey);
    return signingKey;
  }

  /**
   * Adds a new key unless another replica added one first. The private half
   * is stored before the lock is taken, outside the transaction holding it,
   * and deleted again when the key is not needed.
   */
  private async mintKey(): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair(SIGNING_ALGORITHM, {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(publicJwk);
    // The database store, whatever the configured one: the key is derived
    // material Archestra mints and must always be able to read.
    const secret = await secretManager().createSecret(
      { privateJwk: await exportJWK(privateKey) },
      `spiffe-signing-key-${kid}`,
      true,
    );
    const added = await SpiffeSigningKeyModel.createIfNeeded({
      needsKey: needsNewKey,
      key: {
        id: kid,
        publicJwk,
        privateKeySecretId: secret.id,
        // The clock rotation and publication are measured against.
        createdAt: new Date(),
      },
    });
    if (!added) {
      await secretManager().deleteSecret(secret.id);
      return;
    }
    this.publishedKeysCache.clear();
    logger.info({ kid }, "Minted a SPIFFE JWT-SVID signing key");
  }

  private async loadSigningKey(row: SpiffeSigningKey): Promise<SigningKey> {
    const secret = await secretManager().getSecret(row.privateKeySecretId);
    const privateJwk = secret?.secret.privateJwk;
    if (!privateJwk || typeof privateJwk !== "object") {
      throw new Error(
        `The private half of SPIFFE signing key ${row.id} is missing`,
      );
    }
    return {
      kid: row.id,
      privateKey: await importJWK(privateJwk as JWK, SIGNING_ALGORITHM),
    };
  }
}

export const spiffeIssuer = new SpiffeIssuer();

// === Internal helpers

function needsNewKey(newest: SpiffeSigningKey | undefined): boolean {
  return !newest || newest.createdAt.getTime() <= Date.now() - KEY_ROTATION_MS;
}

type SigningKey = {
  kid: string;
  privateKey: Awaited<ReturnType<typeof importJWK>>;
};

const SIGNING_KEY_CACHE_KEY = "signing-key";
const PUBLISHED_KEYS_CACHE_KEY = "published-keys";
