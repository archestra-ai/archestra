import { createHash } from "node:crypto";
import { LRUCacheManager } from "@/in-memory-lru-cache";

/**
 * A minimal OCI distribution client that answers one question: which digest
 * does this image reference's tag point at in its registry right now.
 *
 * It sends the same Accept set a container runtime pulls with (OCI index and
 * manifest, Docker manifest list and manifest), so the digest it reads is the
 * one a node resolves on pull — the index digest for multi-arch images. A
 * HEAD is tried first (Docker Hub does not count it against pull rate
 * limits); a GET is the fallback for registries that reject HEAD or omit the
 * `Docker-Content-Digest` header, hashing the body when the header is absent.
 *
 * Authentication follows the registry's challenge: a Bearer challenge is
 * answered at its token realm (anonymously, or with Basic credentials taken
 * from the supplied docker config documents), a Basic challenge with the
 * credentials directly. Tokens are cached in memory for their lifetime.
 */
class ContainerRegistryClient {
  private readonly authorizations = new LRUCacheManager<string>({
    maxSize: 500,
  });

  async getTagDigest(params: {
    image: string;
    /** `.dockerconfigjson` / `.dockercfg` documents to take credentials from. */
    dockerConfigs?: readonly string[];
  }): Promise<string> {
    const reference = parseImageReference(params.image);
    const credential = findCredential(
      reference.registry,
      params.dockerConfigs ?? [],
    );
    const url = `https://${reference.apiHost}/v2/${reference.repository}/manifests/${encodeURIComponent(reference.tag)}`;
    const authKey = `${reference.apiHost}|${reference.repository}|${credential?.username ?? ""}`;

    const head = await this.requestManifest({
      url,
      method: "HEAD",
      authKey,
      credential,
      repository: reference.repository,
    });
    const headDigest = head.ok
      ? head.headers.get("docker-content-digest")
      : null;
    if (headDigest) return normalizeDigest(headDigest);
    if (!head.ok && head.status !== 405 && head.status !== 501) {
      throw registryError(head.status, params.image);
    }

    const get = await this.requestManifest({
      url,
      method: "GET",
      authKey,
      credential,
      repository: reference.repository,
    });
    if (!get.ok) throw registryError(get.status, params.image);
    const getDigest = get.headers.get("docker-content-digest");
    if (getDigest) return normalizeDigest(getDigest);
    const body = Buffer.from(await get.arrayBuffer());
    return `sha256:${createHash("sha256").update(body).digest("hex")}`;
  }

  // ===
  // Private helpers
  // ===

  /** One manifest request, re-sent once after answering a 401 challenge. */
  private async requestManifest(params: {
    url: string;
    method: "HEAD" | "GET";
    authKey: string;
    credential: RegistryCredential | undefined;
    repository: string;
  }): Promise<Response> {
    const cached = this.authorizations.get(params.authKey);
    const response = await send(params.url, {
      method: params.method,
      authorization: cached,
    });
    if (response.status !== 401) return response;

    await response.body?.cancel();
    const authorization = await this.authorize({
      challenge: response.headers.get("www-authenticate"),
      credential: params.credential,
      repository: params.repository,
      authKey: params.authKey,
    });
    return send(params.url, { method: params.method, authorization });
  }

  private async authorize(params: {
    challenge: string | null;
    credential: RegistryCredential | undefined;
    repository: string;
    authKey: string;
  }): Promise<string> {
    const challenge = parseChallenge(params.challenge);
    const basic = params.credential
      ? `Basic ${Buffer.from(`${params.credential.username}:${params.credential.password}`).toString("base64")}`
      : undefined;

    if (challenge?.scheme === "basic") {
      if (!basic) {
        throw new ContainerRegistryError(
          "registry requires credentials and none are configured",
          401,
        );
      }
      this.authorizations.set(params.authKey, basic, BASIC_AUTH_TTL_MS);
      return basic;
    }
    if (challenge?.scheme !== "bearer" || !challenge.params.realm) {
      throw new ContainerRegistryError(
        "registry sent an unsupported authentication challenge",
        401,
      );
    }

    let realm: URL;
    try {
      realm = new URL(challenge.params.realm);
    } catch {
      throw new ContainerRegistryError("registry token realm is not a URL");
    }
    // Credentials only ever travel over TLS.
    if (realm.protocol !== "https:") {
      throw new ContainerRegistryError("registry token realm is not HTTPS");
    }
    if (challenge.params.service) {
      realm.searchParams.set("service", challenge.params.service);
    }
    realm.searchParams.set(
      "scope",
      challenge.params.scope ?? `repository:${params.repository}:pull`,
    );

    const response = await send(realm.toString(), {
      method: "GET",
      authorization: basic,
      accept: "application/json",
    });
    if (!response.ok) {
      throw new ContainerRegistryError(
        `registry token request failed with HTTP ${response.status}`,
        response.status,
      );
    }
    const body = (await response.json().catch(() => null)) as {
      token?: unknown;
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    const token =
      typeof body?.token === "string"
        ? body.token
        : typeof body?.access_token === "string"
          ? body.access_token
          : undefined;
    if (!token) {
      throw new ContainerRegistryError("registry token response had no token");
    }
    const expiresInSeconds =
      typeof body?.expires_in === "number" && body.expires_in > 0
        ? body.expires_in
        : DEFAULT_TOKEN_LIFETIME_SECONDS;
    const authorization = `Bearer ${token}`;
    this.authorizations.set(
      params.authKey,
      authorization,
      Math.max(expiresInSeconds - TOKEN_EXPIRY_MARGIN_SECONDS, 1) * 1000,
    );
    return authorization;
  }
}

export const containerRegistryClient = new ContainerRegistryClient();

// ===
// Internal helpers
// ===

/**
 * Thrown when a registry cannot answer which digest a tag points at:
 * unreachable, refused credentials, rate-limited (429), or an unexpected
 * response. `status` is the HTTP status when there was one.
 */
class ContainerRegistryError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ContainerRegistryError";
    this.status = status;
  }
}

type RegistryCredential = { username: string; password: string };

type ImageReference = {
  /** Canonical registry name (`docker.io` for Docker Hub). */
  registry: string;
  /** Host the distribution API is served from. */
  apiHost: string;
  repository: string;
  tag: string;
};

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const DOCKER_HUB = "docker.io";
const DOCKER_HUB_API_HOST = "registry-1.docker.io";
const DOCKER_HUB_ALIASES = new Set([
  DOCKER_HUB,
  "index.docker.io",
  DOCKER_HUB_API_HOST,
  "registry.hub.docker.com",
]);
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 60;
const TOKEN_EXPIRY_MARGIN_SECONDS = 10;
const BASIC_AUTH_TTL_MS = 60 * 60 * 1000;

function parseImageReference(image: string): ImageReference {
  let rest = image.trim();
  if (rest.includes("@")) {
    throw new ContainerRegistryError(`"${image}" is pinned to a digest`);
  }

  let registry = DOCKER_HUB;
  const firstSlash = rest.indexOf("/");
  if (firstSlash !== -1) {
    const first = rest.slice(0, firstSlash);
    if (first.includes(".") || first.includes(":") || first === "localhost") {
      registry = first.toLowerCase();
      rest = rest.slice(firstSlash + 1);
    }
  }

  let tag = "latest";
  const tagStart = rest.lastIndexOf(":");
  if (tagStart > rest.lastIndexOf("/")) {
    tag = rest.slice(tagStart + 1);
    rest = rest.slice(0, tagStart);
  }

  if (DOCKER_HUB_ALIASES.has(registry)) {
    registry = DOCKER_HUB;
    if (!rest.includes("/")) rest = `library/${rest}`;
  }
  if (!rest || !tag) {
    throw new ContainerRegistryError(`"${image}" is not an image reference`);
  }

  return {
    registry,
    apiHost: registry === DOCKER_HUB ? DOCKER_HUB_API_HOST : registry,
    repository: rest,
    tag,
  };
}

/**
 * The credential a docker config grants for `registry`. Keys may carry a
 * scheme or path (`https://index.docker.io/v1/`), so both sides are reduced
 * to a bare host, with Docker Hub's aliases folded into `docker.io`.
 */
function findCredential(
  registry: string,
  dockerConfigs: readonly string[],
): RegistryCredential | undefined {
  for (const raw of dockerConfigs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const document = parsed as Record<string, unknown>;
    // `.dockerconfigjson` nests entries under `auths`; legacy `.dockercfg`
    // is the entry map itself.
    const auths = (
      document.auths && typeof document.auths === "object"
        ? document.auths
        : document
    ) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(auths)) {
      if (registryHostOf(key) !== registry) continue;
      const credential = credentialOf(entry);
      if (credential) return credential;
    }
  }
  return undefined;
}

function registryHostOf(key: string): string {
  const host = key
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .split("/")[0]
    .toLowerCase();
  return DOCKER_HUB_ALIASES.has(host) ? DOCKER_HUB : host;
}

function credentialOf(entry: unknown): RegistryCredential | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const { username, password, auth } = entry as Record<string, unknown>;
  if (typeof username === "string" && typeof password === "string") {
    return { username, password };
  }
  if (typeof auth === "string") {
    const decoded = Buffer.from(auth, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator > 0) {
      return {
        username: decoded.slice(0, separator),
        password: decoded.slice(separator + 1),
      };
    }
  }
  return undefined;
}

/** `Bearer realm="…",service="…",scope="…"` → scheme + params. */
function parseChallenge(
  header: string | null,
): { scheme: string; params: Record<string, string> } | undefined {
  const match = header?.trim().match(/^(\S+)\s*(.*)$/);
  if (!match) return undefined;
  const params: Record<string, string> = {};
  for (const [, key, value] of match[2].matchAll(/(\w+)="([^"]*)"/g)) {
    params[key.toLowerCase()] = value;
  }
  return { scheme: match[1].toLowerCase(), params };
}

async function send(
  url: string,
  options: {
    method: "HEAD" | "GET";
    authorization: string | undefined;
    accept?: string;
  },
): Promise<Response> {
  try {
    return await fetch(url, {
      method: options.method,
      headers: {
        Accept: options.accept ?? MANIFEST_ACCEPT,
        ...(options.authorization
          ? { Authorization: options.authorization }
          : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ContainerRegistryError(
      `registry request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function registryError(status: number, image: string): ContainerRegistryError {
  const reason =
    status === 429
      ? "rate-limited the request"
      : status === 401 || status === 403
        ? "refused the credentials"
        : status === 404
          ? "has no such image or tag"
          : `answered HTTP ${status}`;
  return new ContainerRegistryError(
    `registry for "${image}" ${reason}`,
    status,
  );
}

function normalizeDigest(digest: string): string {
  return digest.trim().toLowerCase();
}
