import type { TrustedImageRegistries } from "@/types";

const DOCKER_DEFAULT_HOST = "docker.io";
const DOCKER_OFFICIAL_NAMESPACE = "library";

/**
 * True when `image` is served by one of the `registries` entries.
 *
 * Both the image reference and each entry are normalized to a lowercase
 * `host/repository` form — implicit `docker.io` host, `library/` namespace for
 * official images, host ports preserved, tag and digest stripped. An image
 * matches an entry when the normalized image equals the entry or extends it at a
 * path-segment boundary (so `ghcr.io/acme` trusts `ghcr.io/acme/foo` but not
 * `ghcr.io/acme-evil`). A host-only entry (e.g. `ghcr.io`) trusts any repository
 * on that host.
 *
 * NULL/empty `registries` returns false: callers treat "no list configured" as
 * "no restriction" before calling this, so this answers only "is the image in
 * this non-empty trusted list".
 */
export function imageMatchesTrustedRegistries(
  image: string,
  registries: TrustedImageRegistries | null | undefined,
): boolean {
  if (!registries || registries.length === 0) return false;

  const normalizedImage = normalizeImageReference(image);
  if (!normalizedImage) return false;

  for (const entry of registries) {
    const normalizedEntry = normalizeRegistryEntry(entry);
    if (!normalizedEntry) continue;
    if (
      normalizedImage === normalizedEntry ||
      normalizedImage.startsWith(`${normalizedEntry}/`)
    ) {
      return true;
    }
  }
  return false;
}

// === Internal helpers ===

/** Normalize a full image reference to lowercase `host/repository`. */
function normalizeImageReference(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutDigest = trimmed.split("@")[0];
  const segments = withoutDigest.split("/");

  if (segments.length === 1) {
    // A bare name is always an official docker.io image (docker.io/library/<x>).
    const name = stripTag(segments[0]);
    if (!name) return null;
    return `${DOCKER_DEFAULT_HOST}/${DOCKER_OFFICIAL_NAMESPACE}/${name}`.toLowerCase();
  }
  return normalizeMultiSegment(withoutDigest, segments).toLowerCase();
}

/**
 * Normalize a trusted-registry entry to lowercase. Differs from an image only
 * for single-segment input: a lone host (`ghcr.io`, `localhost:5000`) is a
 * host-only entry, while a bare name is an official docker.io image.
 */
function normalizeRegistryEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutDigest = trimmed.split("@")[0];
  const segments = withoutDigest.split("/");

  if (segments.length === 1) {
    const only = segments[0];
    // A lone host (`ghcr.io`, `localhost:5000`, the k8s-internal `registry:5000`)
    // is a host-only entry; a bare name is an official docker.io image.
    if (isHostSegment(only)) return canonicalizeHost(only);
    const name = stripTag(only);
    if (!name) return null;
    return `${DOCKER_DEFAULT_HOST}/${DOCKER_OFFICIAL_NAMESPACE}/${name}`.toLowerCase();
  }
  return normalizeMultiSegment(withoutDigest, segments).toLowerCase();
}

/**
 * Normalize a multi-segment reference. The leading `/` resolves the host:port
 * vs repo:tag ambiguity, so the first segment is a host when it has a dot, a
 * port colon, or is `localhost`; otherwise it is a docker.io namespace.
 */
function normalizeMultiSegment(
  withoutDigest: string,
  segments: string[],
): string {
  const path = stripTagFromLastSegment(withoutDigest);
  if (isHostSegment(segments[0])) {
    const host = canonicalizeHost(segments[0]);
    return `${host}${path.slice(segments[0].length)}`;
  }
  return `${DOCKER_DEFAULT_HOST}/${path}`;
}

/** Lowercase a host and fold the Docker Hub endpoint aliases onto docker.io. */
function canonicalizeHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower === "index.docker.io" || lower === "registry-1.docker.io") {
    return DOCKER_DEFAULT_HOST;
  }
  return lower;
}

/** Drop a `:tag` suffix from a single repository segment. */
function stripTag(segment: string): string {
  const colon = segment.indexOf(":");
  return colon === -1 ? segment : segment.slice(0, colon);
}

/** Drop the `:tag` from the final path segment, leaving any host:port intact. */
function stripTagFromLastSegment(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const head = path.slice(0, lastSlash + 1);
  const last = path.slice(lastSlash + 1);
  return `${head}${stripTag(last)}`;
}

/** A host segment: has a dot, a port colon, or is localhost. */
function isHostSegment(segment: string): boolean {
  return (
    segment.includes(".") || segment.includes(":") || segment === "localhost"
  );
}
