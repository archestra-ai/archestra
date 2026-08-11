import { SKILL_MANIFEST_FILENAME } from "./parser";

/**
 * The `skill://` URI space Archestra publishes its skills under (SEP-2640).
 *
 *     skill://archestra/shared/<name>/<file>
 *     skill://archestra/personal/<authorId>/<name>/<file>
 *
 * The spec requires the last path segment before the file to equal the skill's
 * frontmatter `name`, so a client can read the name straight off the URI
 * without fetching the manifest. Everything before it is a free-form
 * organizational prefix, which is where the scope discriminator goes.
 *
 * Scope is in the path because a name is only unique within its visibility:
 * personal skills are unique per `(org, author, name)` and shared (team/org)
 * ones per `(org, name)`, so a user can hold a personal `refunds` *and* see an
 * org `refunds`. The author segment disambiguates the personal side. Note the
 * disclosure this carries: an author who publishes a personal skill on a
 * shared gateway exposes their user id in the URI to everyone holding that
 * gateway's token — publication is the author's own act, but the id travels
 * with the skill.
 *
 * @see https://agentskills.io/specification
 */

export type SkillUriScope = "personal" | "shared";

interface ParsedSkillUri {
  scope: SkillUriScope;
  /** Set only for `personal` URIs — the owning author's user id. */
  authorId: string | null;
  name: string;
  /**
   * Path within the skill directory: `SKILL.md`, a supporting file's path, or
   * `""` for the skill root directory itself.
   */
  filePath: string;
}

/** Build the URI of one file inside a skill (`SKILL.md` for the manifest). */
export function buildSkillUri(params: {
  scope: SkillUriScope;
  authorId: string | null;
  name: string;
  filePath: string;
}): string {
  const root = buildSkillRootUri(params);
  return params.filePath ? `${root}/${encodePath(params.filePath)}` : root;
}

/** The URI of a skill's `SKILL.md` — the identity SEP-2640 addresses it by. */
export function buildSkillManifestUri(params: {
  scope: SkillUriScope;
  authorId: string | null;
  name: string;
}): string {
  return `${buildSkillRootUri(params)}/${SKILL_MANIFEST_FILENAME}`;
}

/**
 * Whether a URI lies inside the platform's reserved skill authority.
 *
 * Broader than parseability on purpose: the gateway reserves the whole
 * authority, so a malformed URI under it (`skill://archestra/%zz`) must be
 * answered not-found by the platform, never forwarded upstream where a
 * connected server could serve bytes under this prefix.
 *
 * The authority is parsed, not prefix-matched. RFC 3986 makes scheme and host
 * case-insensitive, and the authority has further spellings that carry nothing
 * a normalizing client preserves: empty userinfo (`skill://@archestra/...`,
 * `skill://:@archestra/...`), an empty port (`skill://archestra:/...`), a
 * trailing-dot host, and percent-encoded unreserved characters
 * (`skill://arch%65stra/...`, which §6.2.2.2 says to decode) all reduce to
 * `skill://archestra/...`. A prefix compare answered false for every one of
 * them, and false is the answer that hands the read to whichever connected
 * server advertised that URI — letting it serve attacker-controlled skill
 * instructions under the platform's own trusted prefix. So the host is
 * compared with userinfo, port and a trailing dot removed and its escapes
 * decoded, and each of those spellings is reserved. None of them is canonical,
 * so none parses: they are answered not-found by the platform rather than
 * served or forwarded.
 *
 * The path keeps its case — names and file paths are matched exactly.
 */
export function isPlatformSkillUri(uri: string): boolean {
  return skillUriHost(uri) === PLATFORM_SKILL_HOST;
}

/**
 * Parse a `skill://` URI, or return null if it is not one of ours.
 *
 * Returning null rather than throwing keeps the caller's shape simple: a
 * gateway `resources/read` sees URIs for every scheme it proxies, and a
 * non-skill URI is ordinary traffic, not an error.
 *
 * Only the canonical spelling resolves. Segment parsing is many-to-one — it
 * percent-decodes each segment and drops empty ones — so `.../scripts%2Frun.py`,
 * `.../shared//refunds//SKILL.md` and `.../SKILL%2Emd` all address files a
 * canonical URI already addresses, and serving one would answer a read with a
 * `uri` that `skills/list` never advertised. A conforming host treats a read of
 * anything it was not listed as a verification failure, so a URI that does not
 * rebuild to itself is refused rather than canonicalized — which removes the
 * mismatch by construction. It costs no confidentiality: a non-canonical
 * spelling is answered exactly like an unexposed or nonexistent skill, so it is
 * no more of a probing oracle than any other unknown URI.
 */
export function parseSkillUri(uri: string): ParsedSkillUri | null {
  const parsed = parseSkillUriSegments(uri);
  if (!parsed) return null;
  return buildSkillUri(parsed) === uri ? parsed : null;
}

// ===== Internal =====

/** Host, lowercased, of every skill URI this platform publishes. */
const PLATFORM_SKILL_HOST = "archestra";

const SKILL_URI_SCHEME = "skill://";

/** Scheme + registry prefix shared by every skill this platform publishes. */
const SKILL_URI_PREFIX = `${SKILL_URI_SCHEME}${PLATFORM_SKILL_HOST}`;

/**
 * The host of a `skill://` URI, normalized for comparison, or null for any
 * other scheme.
 *
 * Userinfo, port and a trailing dot are stripped, and percent escapes decoded,
 * before the compare because a client that normalizes the URI does the same,
 * which would turn a spelling we called someone else's into a read under our
 * own authority.
 */
function skillUriHost(uri: string): string | null {
  if (
    uri.slice(0, SKILL_URI_SCHEME.length).toLowerCase() !== SKILL_URI_SCHEME
  ) {
    return null;
  }

  const rest = uri.slice(SKILL_URI_SCHEME.length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);

  // `lastIndexOf` rather than `indexOf`: userinfo may itself contain an `@`,
  // and the host is whatever follows the final one.
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  const portStart = hostAndPort.indexOf(":");
  const rawHost =
    portStart === -1 ? hostAndPort : hostAndPort.slice(0, portStart);

  // Decoded only now, after the splits above: those are structural, and a URI
  // is divided on its literal delimiters before its components are decoded.
  // Decoding first would let a `%2F` or `%40` invent a boundary that is not in
  // the URI — the traversal bug the path parser guards against, in reverse.
  //
  // Decoded before the trailing dot is stripped, because `.` is unreserved and
  // so `archestra%2E` is a spelling a normalizer collapses onto `archestra.`,
  // which then collapses again onto `archestra`.
  //
  // Malformed encoding keeps the raw spelling rather than throwing: `%zz`
  // decodes to nothing and is nobody's authority, so an unequal compare is
  // already the right verdict for it.
  let host: string;
  try {
    host = decodeURIComponent(rawHost);
  } catch {
    host = rawHost;
  }

  return (host.endsWith(".") ? host.slice(0, -1) : host).toLowerCase();
}

/** Split a canonical-shaped skill URI into its parts, ignoring canonicality. */
function parseSkillUriSegments(uri: string): ParsedSkillUri | null {
  if (!uri.startsWith(`${SKILL_URI_PREFIX}/`)) return null;

  const segments: string[] = [];
  for (const raw of uri
    .slice(`${SKILL_URI_PREFIX}/`.length)
    .split("/")
    .filter((segment) => segment.length > 0)) {
    const decoded = decodeSegment(raw);
    if (decoded === null) return null;
    segments.push(decoded);
  }

  const [scope, ...rest] = segments;

  if (scope === "shared") {
    const [name, ...filePath] = rest;
    if (!name) return null;
    return {
      scope: "shared",
      authorId: null,
      name,
      filePath: filePath.join("/"),
    };
  }

  if (scope === "personal") {
    const [authorId, name, ...filePath] = rest;
    if (!authorId || !name) return null;
    return {
      scope: "personal",
      authorId,
      name,
      filePath: filePath.join("/"),
    };
  }

  return null;
}

/** The skill's root directory URI — its file URIs minus the file path. */
function buildSkillRootUri(params: {
  scope: SkillUriScope;
  authorId: string | null;
  name: string;
}): string {
  if (params.scope === "personal") {
    if (!params.authorId) {
      throw new Error("personal skill URIs require an authorId");
    }
    return `${SKILL_URI_PREFIX}/personal/${encodeURIComponent(params.authorId)}/${encodeURIComponent(params.name)}`;
  }
  return `${SKILL_URI_PREFIX}/shared/${encodeURIComponent(params.name)}`;
}

/** Encode a skill-relative path segment-by-segment, the mirror of parsing. */
function encodePath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

/**
 * Decode one URI segment, or return null when the URI cannot name anything we
 * store: malformed percent-encoding (`%zz`, a bare `%`) throws inside
 * `decodeURIComponent`, and a null byte can never appear in a stored name or
 * path (Postgres text rejects it), so letting one through would turn the
 * lookup itself into an internal error.
 */
function decodeSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return decoded.includes("\u0000") ? null : decoded;
}
