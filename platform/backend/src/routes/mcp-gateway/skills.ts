import { TimeInMs } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import logger from "@/logging";
import { SkillModel } from "@/models";
import {
  resolveExposedSkill,
  resolveExposedSkills,
} from "@/services/agent-skill-resolution";
import {
  findPublishedSkillFile,
  renderSkillManifest,
  resolveSkillPublicationArtifacts,
  type SkillPublicationArtifacts,
} from "@/services/skill-publication";
import { SKILL_MANIFEST_FILENAME } from "@/skills/parser";
import {
  buildSkillManifestUri,
  buildSkillUri,
  parseSkillUri,
  type SkillUriScope,
} from "@/skills/skill-uri";
import {
  hasPublishableFilePathSet,
  isPublishableSkillFilePath,
} from "@/skills/validation";
import type { PublishableSkill } from "@/types";
import { buildPrivateListCacheHint } from "./protocol";

/**
 * MCP Skills extension (`io.modelcontextprotocol/skills`) at the gateway.
 *
 * Publishes Archestra's own skills as `skill://` resources per SEP-2640. Which
 * skills a given gateway publishes is decided entirely by
 * services/agent-skill-resolution — this module only renders what that returns
 * onto the wire.
 *
 * Hand-rolled at the route, like the Tasks extension, rather than going through
 * the SDK: `skills/list` and `skills/get` are extension methods the SDK has no
 * handler slot for. Reads are the exception — `resources/read` is an ordinary
 * SDK request whose handler accepts any URI, so the `skill://` branch lives
 * there (see `serveSkillResource`, called from utils.ts) instead of here.
 *
 * The published bytes and their digests come from services/skill-publication,
 * which reads them off the skill's own rows (written with the content they
 * cover) — this module never hashes anything itself.
 */

const SKILL_METHODS = new Set([
  "skills/list",
  "skills/get",
  "resources/directory/read",
]);

const DIRECTORY_MIME_TYPE = "inode/directory";
const DEFAULT_PAGE_SIZE = 50;

/** Withheld-skill warnings repeat on every listing; log once an hour. */
const withheldWarnThrottle = new LRUCacheManager<true>({
  maxSize: 1_000,
  defaultTtl: TimeInMs.Hour,
});

export function isSkillMethod(body: unknown): boolean {
  return (
    isRecord(body) &&
    typeof body.method === "string" &&
    SKILL_METHODS.has(body.method) &&
    // Requests only. A notification (no id) must get no response, so it is
    // not this surface's to answer: it falls through to the SDK transport,
    // whose notification path replies 202 with no body.
    "id" in body
  );
}

/** Serve skills/list, skills/get, and resources/directory/read. */
export async function handleSkillMethod(params: {
  body: unknown;
  agentId: string;
}): Promise<
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } }
> {
  const { body, agentId } = params;
  const method = isRecord(body) ? body.method : undefined;
  const bodyParams = isRecord(body) && isRecord(body.params) ? body.params : {};

  switch (method) {
    case "skills/list":
      return await handleList({ agentId, bodyParams });
    case "skills/get":
      return await handleGet({ agentId, bodyParams });
    case "resources/directory/read":
      return await handleDirectoryRead({ agentId, bodyParams });
    default:
      return {
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

/**
 * Serve a `skill://` URI as an ordinary `resources/read` result, or return null
 * if the URI is not a skill this gateway publishes.
 *
 * Null is a verdict, not a routing hint: the read handler reserves the whole
 * skill://archestra namespace and answers null with not-found, never by
 * proxying upstream — otherwise a connected server could serve its own bytes
 * under the platform's prefix. An unexposed skill and an unknown URI are
 * indistinguishable from outside: a `skill://` URI names a skill, it does not
 * grant access to one.
 */
export async function serveSkillResource(params: {
  uri: string;
  agentId: string;
}): Promise<{
  contents: Array<Record<string, unknown>>;
} | null> {
  const parsed = parseSkillUri(params.uri);
  if (!parsed) return null;

  const skill = await resolveExposedSkill({
    agentId: params.agentId,
    name: parsed.name,
    authorId: parsed.authorId,
  });
  if (!skill) return null;

  const artifacts = await loadArtifacts(skill);
  if (!isServable(skill, artifacts)) return null;

  if (parsed.filePath === SKILL_MANIFEST_FILENAME) {
    // The only place a skill body is read: the resolution path projects
    // `content` away because nothing else on this surface renders one. Composed
    // from this read alone, never from `artifacts` — those were resolved off a
    // snapshot taken before it, and pairing a blob from one moment with a body
    // from another serves bytes no digest of this skill has ever covered.
    const source = await SkillModel.findManifestSourceById(skill.id);
    if (!source) return null;
    return {
      contents: [
        {
          uri: params.uri,
          mimeType: "text/markdown",
          text: renderSkillManifest(source),
        },
      ],
    };
  }

  const file = await findPublishedSkillFile({
    skillId: skill.id,
    path: parsed.filePath,
  });
  if (!file) return null;

  return {
    contents: [
      {
        uri: params.uri,
        mimeType: guessMimeType(file.path),
        // Binary assets are stored base64 and go back as a blob; the digest
        // covers the decoded bytes either way.
        ...(file.encoding === "base64"
          ? { blob: file.content }
          : { text: file.content }),
      },
    ],
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

async function handleList(params: {
  agentId: string;
  bodyParams: Record<string, unknown>;
}): Promise<
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } }
> {
  const cursor = decodeCursor(params.bodyParams.cursor);
  if (cursor.verdict === "invalid") {
    return { error: { code: -32602, message: "Invalid cursor" } };
  }

  // The page comes back already settled: everything a window could turn out to
  // be entirely made of — excluded skills, skills with unnameable file paths,
  // rows still missing their publication artifacts — is filtered inside the
  // query the LIMIT sits on, so a page is full of skills that will render.
  // Withholding after the window was cut is what used to answer
  // empty-with-a-cursor, and plenty of clients stop on an empty page.
  const exposure = await resolveExposedSkills({
    agentId: params.agentId,
    afterId: cursor.verdict === "resume" ? cursor.afterId : undefined,
    limit: DEFAULT_PAGE_SIZE,
  });
  if (!exposure) {
    return { error: { code: -32602, message: "Unknown agent" } };
  }

  const artifacts = await resolveSkillPublicationArtifacts(exposure.skills);
  // `buildSkillEntry` can still return null, but now only for a row deleted or
  // invalidated between the two reads — a race that resolves itself on the next
  // page (the backfill tick re-digests an invalidated row), never a systematic
  // property of the catalog.
  const entries = exposure.skills
    .map((skill) => buildSkillEntry(skill, artifacts.get(skill.id)))
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  const lastScanned = exposure.skills.at(-1);

  return {
    result: {
      skills: entries,
      ...(exposure.hasMore && lastScanned
        ? { nextCursor: encodeCursor(lastScanned.id) }
        : {}),
      ...buildPrivateListCacheHint(),
    },
  };
}

async function handleGet(params: {
  agentId: string;
  bodyParams: Record<string, unknown>;
}): Promise<
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } }
> {
  const uri = params.bodyParams.uri;
  if (typeof uri !== "string") {
    return { error: { code: -32602, message: "uri must be a string" } };
  }

  const parsed = parseSkillUri(uri);
  const skill =
    parsed && parsed.filePath === SKILL_MANIFEST_FILENAME
      ? await resolveExposedSkill({
          agentId: params.agentId,
          name: parsed.name,
          authorId: parsed.authorId,
        })
      : null;
  // An unexposed skill and a nonexistent one answer identically, so the
  // response cannot be used to probe what other gateways publish.
  if (!skill) {
    return { error: { code: -32602, message: `Unknown skill: ${uri}` } };
  }

  const entry = buildSkillEntry(skill, await loadArtifacts(skill));
  if (!entry) {
    return { error: { code: -32602, message: `Unknown skill: ${uri}` } };
  }

  return { result: { skill: entry } };
}

/**
 * List a directory inside a skill.
 *
 * Nothing stores directories: a version's files are a flat list of paths, and
 * `SKILL.md` is not among them at all (it lives on the version row). So the
 * listing is synthesized — direct children come out as files, deeper paths
 * collapse into one synthetic `inode/directory` entry each, and the root
 * additionally carries a synthetic `SKILL.md`.
 */
async function handleDirectoryRead(params: {
  agentId: string;
  bodyParams: Record<string, unknown>;
}): Promise<
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } }
> {
  const uri = params.bodyParams.uri;
  if (typeof uri !== "string") {
    return { error: { code: -32602, message: "uri must be a string" } };
  }

  const parsed = parseSkillUri(uri);
  const skill = parsed
    ? await resolveExposedSkill({
        agentId: params.agentId,
        name: parsed.name,
        authorId: parsed.authorId,
      })
    : null;
  if (!skill || !parsed) {
    return { error: { code: -32602, message: `Unknown directory: ${uri}` } };
  }

  const artifacts = await loadArtifacts(skill);
  if (!isServable(skill, artifacts)) {
    return { error: { code: -32602, message: `Unknown directory: ${uri}` } };
  }

  const prefix = parsed.filePath ? `${parsed.filePath}/` : "";
  const isRoot = prefix === "";

  const files: Array<Record<string, unknown>> = [];
  const directories = new Set<string>();

  for (const file of artifacts.files) {
    if (!file.path.startsWith(prefix)) continue;
    const remainder = file.path.slice(prefix.length);
    const separator = remainder.indexOf("/");

    if (separator === -1) {
      files.push({
        uri: buildSkillFileUri(skill, file.path),
        name: remainder,
        mimeType: guessMimeType(file.path),
      });
    } else {
      directories.add(remainder.slice(0, separator));
    }
  }

  // A path that matched nothing is not a directory. The root always exists —
  // every skill has a SKILL.md — so it is exempt.
  if (!isRoot && files.length === 0 && directories.size === 0) {
    return { error: { code: -32602, message: `Unknown directory: ${uri}` } };
  }

  const manifestChild = isRoot
    ? [
        {
          uri: buildSkillFileUri(skill, SKILL_MANIFEST_FILENAME),
          name: SKILL_MANIFEST_FILENAME,
          mimeType: "text/markdown",
        },
      ]
    : [];

  const directoryChildren = [...directories].sort().map((name) => ({
    uri: buildSkillFileUri(skill, `${prefix}${name}`),
    name,
    mimeType: DIRECTORY_MIME_TYPE,
  }));

  return {
    result: {
      resources: [...manifestChild, ...files, ...directoryChildren],
      ...buildPrivateListCacheHint(),
    },
  };
}

/**
 * Render one skill as a SEP-2640 entry, or null when a stored file path is one
 * no `skill://` URI can name.
 *
 * Withholding the whole skill is the correct failure there: an entry listing a
 * resource no host can fetch and verify is, to a conforming host, tampering
 * with the skill — so a legacy path that only an edit can fix takes the skill
 * off the surface rather than publishing something unverifiable.
 */
function buildSkillEntry(
  skill: PublishableSkill,
  artifacts: SkillPublicationArtifacts | undefined,
): Record<string, unknown> | null {
  if (!isServable(skill, artifacts)) return null;

  const manifestUri = buildSkillManifestUri(skillUriParts(skill));

  return {
    uri: manifestUri,
    // Read back from the published bytes, not rebuilt from the row, so the
    // entry and the manifest it addresses always describe the same fields.
    frontmatter: artifacts.frontmatter,
    // `resources` must enumerate the skill completely — SKILL.md included —
    // because a host treats a read of anything unlisted as a verification
    // failure.
    resources: [
      { uri: manifestUri, digest: artifacts.digest },
      ...artifacts.files.map((file) => ({
        uri: buildSkillFileUri(skill, file.path),
        digest: file.digest,
      })),
    ],
  };
}

async function loadArtifacts(
  skill: PublishableSkill,
): Promise<SkillPublicationArtifacts | undefined> {
  const artifacts = await resolveSkillPublicationArtifacts([skill]);
  return artifacts.get(skill.id);
}

/**
 * Whether a skill is fit to serve: it still exists, its URI parts are
 * expressible at all, and every stored file path is expressible as a
 * `skill://` URI that round-trips.
 */
function isServable(
  skill: PublishableSkill,
  artifacts: SkillPublicationArtifacts | undefined,
): artifacts is SkillPublicationArtifacts {
  if (!artifacts) return false;
  // A personal skill with no author (the user row was deleted before the
  // publication gates excluded orphans) cannot be named: the author id is a
  // URI segment, and `buildSkillUri` throws without one. The resolution gates
  // never fetch such a row; this guard exists so that if one ever slips
  // through, it withholds a single skill instead of failing the whole
  // response.
  if (skill.scope === "personal" && !skill.authorId) {
    if (!withheldWarnThrottle.get(skill.id)) {
      withheldWarnThrottle.set(skill.id, true);
      logger.warn(
        { skillId: skill.id, skillName: skill.name },
        "Skill withheld from MCP listing: a personal skill has no author, so no skill:// URI can name it",
      );
    }
    return false;
  }
  return hasPublishablePaths(
    skill,
    artifacts.files.map((file) => file.path),
  );
}

/**
 * Whether every one of a skill's stored file paths can be named by a
 * `skill://` URI that round-trips.
 *
 * Rows written before path validation existed can fail this. `skills/list`
 * reaches the same verdict in SQL and never offers such a skill here, so what
 * remains is the by-key surface — a client that addresses the skill directly.
 * That is also where the warning is worth emitting: it names a skill someone
 * tried to reach, rather than repeating the whole catalog's backlog on every
 * listing. It stays throttled because such a skill can stay in this state
 * indefinitely and a client retries.
 */
function hasPublishablePaths(
  skill: PublishableSkill,
  paths: string[],
): boolean {
  const unpublishablePath = paths.find(
    (path) => !isPublishableSkillFilePath(path),
  );
  if (!unpublishablePath && hasPublishableFilePathSet(paths)) return true;

  if (!withheldWarnThrottle.get(skill.id)) {
    withheldWarnThrottle.set(skill.id, true);
    logger.warn(
      {
        skillId: skill.id,
        skillName: skill.name,
        // Absent when the paths are individually fine but collide as a set —
        // one is a directory the other sits in, which is a property of the
        // pair rather than of any single path.
        unpublishablePath,
      },
      "Skill withheld from MCP listing: a stored file path cannot be named by a skill:// URI, or one path is a directory another sits in; rename the file to publish it",
    );
  }
  return false;
}

function skillUriParts(skill: PublishableSkill): {
  scope: SkillUriScope;
  authorId: string | null;
  name: string;
} {
  return {
    scope: skill.scope === "personal" ? "personal" : "shared",
    authorId: skill.authorId,
    name: skill.name,
  };
}

function buildSkillFileUri(skill: PublishableSkill, filePath: string): string {
  return buildSkillUri({ ...skillUriParts(skill), filePath });
}

/**
 * The cursor is the last id emitted, and nothing else.
 *
 * Keyset paging needs no guard against the set changing underneath it: an id is
 * a position in the ordering rather than an offset into a materialized list, so
 * a skill created, deleted or excluded between pages shifts nothing. It used to
 * carry a fingerprint of the whole exposed set precisely because that set WAS
 * materialized per page — which is the read this surface no longer does.
 *
 * Encoded rather than sent raw so it stays opaque: a client that reconstructs
 * a cursor by hand pins a format that is free to change.
 */
function encodeCursor(afterId: string): string {
  return Buffer.from(JSON.stringify({ afterId }), "utf8").toString("base64url");
}

/**
 * Absent, resumable, or invalid — three verdicts, not two, because MCP
 * pagination distinguishes them: no cursor starts a listing, and a cursor
 * this surface could never have issued answers `-32602` rather than silently
 * restarting from page one, which a client mid-listing would read as the
 * catalog beginning again.
 *
 * Reads only `afterId`, ignoring any other field — so a cursor issued before
 * the fingerprint was dropped still resumes rather than erroring a listing
 * mid-flight.
 *
 * The id must be a UUID, not merely a string: it lands in `"skills"."id" > $1`
 * against a `uuid` column, so any other spelling makes Postgres raise `invalid
 * input syntax for type uuid` from inside the listing query. A cursor is
 * client-held and therefore client-editable, so that is a reachable input —
 * and one no cursor this surface issued can contain, hence the same invalid
 * verdict the decode failures get. A well-formed cursor whose skill has since
 * vanished stays valid: keyset paging reads the id as a position in the
 * ordering, not a row that must still exist.
 */
function decodeCursor(
  raw: unknown,
):
  | { verdict: "absent" }
  | { verdict: "resume"; afterId: string }
  | { verdict: "invalid" } {
  if (raw === undefined) return { verdict: "absent" };
  if (typeof raw !== "string") return { verdict: "invalid" };
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      isRecord(parsed) &&
      typeof parsed.afterId === "string" &&
      UUID_PATTERN.test(parsed.afterId)
    ) {
      return { verdict: "resume", afterId: parsed.afterId };
    }
  } catch {
    // Undecodable — falls through to the invalid verdict below.
  }
  return { verdict: "invalid" };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function guessMimeType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

const MIME_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  mdx: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  py: "text/x-python",
  js: "text/javascript",
  ts: "text/typescript",
  sh: "application/x-sh",
  csv: "text/csv",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays are excluded: `params: []` is not a params object, and treating one
  // as such would silently read every field as undefined.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
