import { parseFullToolName } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import {
  type GitAccess,
  gitClient,
  resolveGitCredentialAccess,
} from "@/git-hosts/git-access";
import { GitHostError } from "@/git-hosts/git-host-client";
import { fetchAsGithubApp } from "@/integrations/github/app-auth";
import logger from "@/logging";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import ToolModel from "@/models/tool";
import {
  expandRepositoryIncludes,
  isRepositoryInclude,
  isServerRulesFile,
  MAX_REPOSITORY_FILES,
  repositoryFileHash,
  repositoryIncludePaths,
  SERVER_RULES_FOLDER,
  SERVER_RULES_INCLUDE,
  serverCatchAllPrefixes,
  serverFilesDeclareAnnotators,
  withoutRepositoryIncludes,
} from "@/openappa/policy-text";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";
import { githubFetch } from "@/services/openappa-github";
import {
  resolveGithubPatToken,
  resolveGithubSkillAppCredentials,
} from "@/skills/github-app-token";
import {
  GITHUB_DOT_COM_SOURCE,
  githubSkillSourceFromApiUrl,
} from "@/skills/github-source";
import { ApiError } from "@/types";
import { mapWithConcurrency } from "@/utils/concurrency";

/**
 * What one job may do in the policy repository: the permissions its GitHub
 * App token carries, by GitHub's permission names.
 */
export type GithubJobPermissions = Partial<
  Record<
    "contents" | "pull_requests" | "checks" | "administration",
    "read" | "write"
  >
>;

/**
 * A GitHub App installation that was not granted what a job asks for, or does
 * not cover the policy repository: the job reports it rather than failing.
 */
export class MissingGithubPermission extends ApiError {
  constructor(
    readonly repo: string,
    readonly permissions: GithubJobPermissions,
  ) {
    super(
      403,
      `The GitHub App cannot act on ${repo} with ${describePermissions(permissions)}. Add the missing permissions in the App's settings on GitHub and accept the change on its installation, or install the App on the repository.`,
    );
  }
}

/** Permissions as GitHub's App settings name them, e.g. "Checks (write)". */
function describePermissions(permissions: GithubJobPermissions): string {
  const names: Record<keyof GithubJobPermissions, string> = {
    contents: "Contents",
    pull_requests: "Pull requests",
    checks: "Checks",
    administration: "Administration",
  };
  return Object.entries(permissions)
    .map(
      ([name, level]) =>
        `${names[name as keyof GithubJobPermissions]} (${level === "write" ? "read and write" : "read"})`,
    )
    .join(" and ");
}

/**
 * The token and GitHub origins for an OpenAPPA policy source. A GitHub App
 * carries its own API URL, so GitHub Enterprise Server works like github.com;
 * personal access tokens and public reads are github.com only.
 *
 * Given a job's `permissions` and the source's repository, a GitHub App's
 * token is minted for that job alone: the policy repository and those
 * permissions, for under an hour, so a job never holds more than it does. A
 * personal access token cannot be narrowed and is returned as it is.
 */
export async function resolveOpenAppaGithubAccess(
  source: {
    organizationId: string;
    githubPatId: string | null;
    githubAppConfigId: string | null;
    repo?: string | null;
  },
  permissions?: GithubJobPermissions,
): Promise<OpenAppaGithubAccess> {
  if (source.githubAppConfigId && permissions && source.repo)
    return jobAccess({
      organizationId: source.organizationId,
      githubAppConfigId: source.githubAppConfigId,
      repo: source.repo,
      permissions,
    });
  if (source.githubAppConfigId) {
    const { githubToken, githubSource } =
      await resolveGithubSkillAppCredentials({
        organizationId: source.organizationId,
        githubAppConfigId: source.githubAppConfigId,
      });
    return {
      token: githubToken,
      api: githubSource.apiBaseUrl,
      web: githubSource.webOrigin,
    };
  }
  const origins = {
    api: GITHUB_DOT_COM_SOURCE.apiBaseUrl,
    web: GITHUB_DOT_COM_SOURCE.webOrigin,
  };
  if (source.githubPatId)
    return {
      token: await resolveGithubPatToken({
        organizationId: source.organizationId,
        githubPatId: source.githubPatId,
      }),
      ...origins,
    };
  return { token: undefined, ...origins };
}

/** Job tokens by App, installation, repository and permissions. */
const jobTokens = new LRUCacheManager<{ token: string; expiresAt: number }>({
  maxSize: 256,
  defaultTtl: 50 * 60_000,
});

/** A token minted is reused while it has this long left. */
const JOB_TOKEN_MARGIN_MS = 5 * 60_000;

async function jobAccess(params: {
  organizationId: string;
  githubAppConfigId: string;
  repo: string;
  permissions: GithubJobPermissions;
}): Promise<OpenAppaGithubAccess> {
  const { organizationId, repo } = params;
  const definition = await RuntimeCredentialDefinitionModel.findById({
    id: params.githubAppConfigId,
    organizationId,
  });
  if (
    definition?.kind !== "github_app" ||
    !definition.appId ||
    !definition.installationId
  )
    throw new ApiError(404, "GitHub App credential not found");
  const api = (
    definition.githubUrl ?? GITHUB_DOT_COM_SOURCE.apiBaseUrl
  ).replace(/\/+$/, "");
  const web = githubSkillSourceFromApiUrl(api).webOrigin;
  const permissions = Object.fromEntries(
    Object.entries(params.permissions).sort(([a], [b]) => a.localeCompare(b)),
  ) as GithubJobPermissions;
  const key = [
    definition.id,
    definition.installationId,
    repo.toLowerCase(),
    JSON.stringify(permissions),
  ].join("\u0000");
  const cached = jobTokens.get(key);
  if (cached && cached.expiresAt - Date.now() > JOB_TOKEN_MARGIN_MS)
    return { token: cached.token, api, web };
  const privateKey = await RuntimeCredentialConnectionModel.resolveValue({
    organizationId,
    credentialId: definition.key,
    scope: "organization",
  });
  if (!privateKey)
    throw new ApiError(400, "GitHub App credential has no private key");
  let minted: { token?: unknown; expires_at?: unknown };
  try {
    minted = await fetchAsGithubApp({
      githubUrl: api,
      appId: definition.appId,
      privateKey,
      path: `/app/installations/${encodeURIComponent(definition.installationId)}/access_tokens`,
      method: "POST",
      // A repository of the installation's own account, by name.
      body: { repositories: [repo.slice(repo.indexOf("/") + 1)], permissions },
    });
  } catch (error) {
    // GitHub answers 422 for a permission the installation was not granted,
    // or a repository it does not cover.
    if (error instanceof ApiError && /HTTP 422\b/.test(error.message))
      throw new MissingGithubPermission(repo, permissions);
    throw error;
  }
  const expiresAt =
    typeof minted.expires_at === "string" ? Date.parse(minted.expires_at) : NaN;
  if (typeof minted.token !== "string" || Number.isNaN(expiresAt))
    throw new ApiError(502, "GitHub returned an invalid installation token");
  jobTokens.set(
    key,
    { token: minted.token, expiresAt },
    Math.max(0, expiresAt - Date.now() - JOB_TOKEN_MARGIN_MS),
  );
  return { token: minted.token, api, web };
}

/** GitHub App logins (`<slug>[bot]`) by credential, for a day: they do not change. */
const appLogins = new LRUCacheManager<string>({
  maxSize: 256,
  defaultTtl: 24 * 60 * 60_000,
});

/**
 * The GitHub login a source's App acts as, `<slug>[bot]`: the committer of
 * every commit the App makes, which GitHub signs. Null for a source that
 * reads with a personal access token or no credential.
 */
export async function githubAppLogin(source: {
  organizationId: string;
  githubAppConfigId: string | null;
}): Promise<string | null> {
  if (!source.githubAppConfigId) return null;
  const cached = appLogins.get(source.githubAppConfigId);
  if (cached) return cached;
  const definition = await RuntimeCredentialDefinitionModel.findById({
    id: source.githubAppConfigId,
    organizationId: source.organizationId,
  });
  if (definition?.kind !== "github_app" || !definition.appId)
    throw new ApiError(404, "GitHub App credential not found");
  const privateKey = await RuntimeCredentialConnectionModel.resolveValue({
    organizationId: source.organizationId,
    credentialId: definition.key,
    scope: "organization",
  });
  if (!privateKey)
    throw new ApiError(400, "GitHub App credential has no private key");
  const app = await fetchAsGithubApp<{ slug?: unknown }>({
    githubUrl: (
      definition.githubUrl ?? GITHUB_DOT_COM_SOURCE.apiBaseUrl
    ).replace(/\/+$/, ""),
    appId: definition.appId,
    privateKey,
    path: "/app",
  });
  if (typeof app.slug !== "string" || !app.slug)
    throw new ApiError(502, "GitHub did not name the App");
  const login = `${app.slug}[bot]`;
  appLogins.set(source.githubAppConfigId, login);
  return login;
}

/** The GitLab host and token behind a source's GitLab token. */
export async function resolveOpenAppaGitlabAccess(source: {
  organizationId: string;
  gitlabTokenId: string;
}): Promise<GitAccess> {
  const access = await resolveGitCredentialAccess({
    organizationId: source.organizationId,
    credentialId: source.gitlabTokenId,
  });
  if (access.host.provider !== "gitlab")
    throw new ApiError(400, "The policy source's credential is not for GitLab");
  return access;
}

type OpenAppaGithubAccess = {
  token: string | undefined;
  /** API base, e.g. https://api.github.com or https://github.example.com/api/v3. */
  api: string;
  /** Web origin, e.g. https://github.com. */
  web: string;
};

// =============================================================================
// Repository includes: the policy repository's files appa.toml includes
// =============================================================================

/** The largest included file read, the same limit as the policy file's. */
const FILE_MAX_BYTES = 1024 * 1024;

/** The repository a policy source reads, and the credential it reads with. */
export type RepositorySource = {
  organizationId: string;
  repo: string;
  /** The policy file's path: include entries are relative to its folder. */
  path: string | null;
  githubPatId: string | null;
  githubAppConfigId: string | null;
  gitlabTokenId: string | null;
};

/** A root with its repository includes folded in, or why they could not be. */
export type ExpandedRoot = {
  content: string;
  errors: string[];
  /**
   * Each included file and the hash of the bytes folded in, in include order,
   * with the tools its `<prefix>__*` rules covered when it has one: a server
   * that gains a tool composes again.
   */
  included: Array<{ path: string; sha256: string; tools?: string[] }>;
};

/**
 * The bytes of the repository files a root includes. They are read at the
 * commit Git sync accepted and kept in memory by that commit: the bytes under
 * one commit never change, so a cached file is never stale, and nothing is
 * stored in the database.
 */
class OpenAppaRepositoryIncludes {
  /** File texts by blob id, which names the bytes themselves. */
  private readonly cache = new LRUCacheManager<string>({
    maxSize: 1024,
    maxBytes: 64 * 1024 * 1024,
    sizeOf: (text) => text.length,
    defaultTtl: 0,
  });
  /** The files directly in one folder at one commit, by name. */
  private readonly listings = new LRUCacheManager<Map<string, string>>({
    maxSize: 512,
    defaultTtl: 0,
  });
  /**
   * A read that failed, for a minute: every composition that cannot read the
   * repository is refused anyway, so it is not asked again on each call.
   */
  private readonly failures = new LRUCacheManager<string>({
    maxSize: 256,
    defaultTtl: 60_000,
  });

  /** Whether an `include` entry names a file in the policy repository. */
  isRepositoryFile(entry: string): boolean {
    return isRepositoryInclude(entry);
  }

  /** The root without its repository includes. */
  withoutFiles(content: string): string {
    return withoutRepositoryIncludes(content);
  }

  /**
   * Fold the repository files `content` includes into it. A file given in
   * `files` is used as given, which is how a preview checks a proposed file,
   * also a server's first one under `mcp/*.toml`; every other file is read at
   * the accepted commit.
   */
  async expand(params: {
    organizationId: string;
    content: string;
    files?: ReadonlyMap<string, string>;
  }): Promise<ExpandedRoot> {
    const paths = repositoryIncludePaths(params.content);
    if (paths.length === 0)
      return { content: params.content, errors: [], included: [] };
    const files = new Map(params.files ?? []);
    const missing = [...new Set(paths)].filter((path) => !files.has(path));
    if (missing.length > 0) {
      try {
        const accepted = await this.readAccepted({
          organizationId: params.organizationId,
          paths: missing,
        });
        // A given file stays as given, also among every server's files.
        for (const [path, text] of accepted)
          if (!files.has(path)) files.set(path, text);
      } catch (error) {
        if (error instanceof ApiError)
          return {
            content: params.content,
            errors: [error.message],
            included: [],
          };
        throw error;
      }
    }
    return fold({
      content: params.content,
      files,
      serverTools: await serverToolsFor(params.organizationId, files),
      batteryHelpers: await batteryHelpersFor({ ...params, files }),
    });
  }

  /**
   * Fold in the files of one commit, read with `read`: a path the commit does
   * not hold refuses the fold, rather than being read anywhere else.
   */
  async foldAt(params: {
    organizationId: string;
    content: string;
    files: ReadonlyMap<string, string>;
  }): Promise<ExpandedRoot> {
    return fold({
      content: params.content,
      files: params.files,
      serverTools: await serverToolsFor(params.organizationId, params.files),
      batteryHelpers: await batteryHelpersFor(params),
    });
  }

  /** Files at the commit Git sync accepted; a path not there is left out. */
  async readAccepted(params: {
    organizationId: string;
    paths: readonly string[];
  }): Promise<Map<string, string>> {
    const source = await OpenAppaGithubSyncModel.find(params.organizationId);
    if (!source?.repo || !source.sourceCommit)
      throw new ApiError(
        409,
        `include: ${JSON.stringify(params.paths[0])} is a file in the policy repository, and Git sync has accepted no repository commit. Connect Git sync, or remove the include.`,
      );
    return this.read({
      source: { ...source, repo: source.repo },
      commit: source.sourceCommit,
      paths: params.paths,
    });
  }

  /**
   * Files at `commit` in the source's repository, by include entry; an entry
   * the commit holds no file for is left out, and `mcp/*.toml` reads every
   * server rules file there. Each folder is listed once per commit, and a
   * file's text is kept by its blob id: a commit that changed one server's
   * file reads that file alone.
   */
  async read(params: {
    source: RepositorySource;
    commit: string;
    paths: readonly string[];
  }): Promise<Map<string, string>> {
    const { source, commit } = params;
    const failureKey = cacheKey(source, commit);
    const failed = this.failures.get(failureKey);
    if (failed !== undefined) throw new ApiError(502, failed);
    let reader: RepositoryReader | undefined;
    const open = async () => {
      reader ??= await repositoryReader(source);
      return reader;
    };
    try {
      const listed = async (folder: string) => {
        // Keyed by the folder in the repository: entries relative to another
        // policy folder name other folders.
        const inRepository = repositoryPath(source, folder);
        const key = cacheKey(source, commit, inRepository);
        let names = this.listings.get(key);
        if (!names) {
          names = await (await open()).list(commit, inRepository);
          this.listings.set(key, names);
        }
        return names;
      };
      // Each file the entries name, by include entry, with its blob id.
      const wanted = new Map<string, string>();
      for (const entry of params.paths) {
        if (entry === SERVER_RULES_INCLUDE) {
          const names = await listed(SERVER_RULES_FOLDER);
          if (names.size > MAX_REPOSITORY_FILES)
            throw new ApiError(
              400,
              `${SERVER_RULES_FOLDER}/ holds ${names.size} files; at most ${MAX_REPOSITORY_FILES} server rules files are read`,
            );
          for (const [name, blob] of names) {
            const path = `${SERVER_RULES_FOLDER}/${name}`;
            if (isServerRulesFile(path)) wanted.set(path, blob);
          }
          continue;
        }
        const slash = entry.lastIndexOf("/");
        const blob = (await listed(slash < 0 ? "" : entry.slice(0, slash))).get(
          entry.slice(slash + 1),
        );
        if (blob) wanted.set(entry, blob);
      }
      const files = new Map<string, string>();
      const misses: Array<[string, string]> = [];
      for (const [path, blob] of wanted) {
        const cached = this.cache.get(blobKey(source, blob));
        if (cached === undefined) misses.push([path, blob]);
        else files.set(path, cached);
      }
      if (misses.length === 0) return files;
      const { text } = await open();
      const settled = await mapWithConcurrency(misses, 8, ([path]) =>
        text(commit, repositoryPath(source, path)),
      );
      for (const [index, result] of settled.entries()) {
        if (result.status === "rejected") throw result.reason;
        const [path, blob] = misses[index] as [string, string];
        // Listed at this commit, so a file that cannot be read is an error,
        // never a file to leave out.
        if (result.value === null)
          throw new ApiError(
            400,
            `${path} could not be read at ${commit.slice(0, 7)}: it is over the 1 MiB limit or no longer there`,
          );
        this.cache.set(blobKey(source, blob), result.value);
        files.set(path, result.value);
      }
      return files;
    } catch (error) {
      if (error instanceof ApiError && error.statusCode >= 500)
        this.failures.set(failureKey, error.message);
      throw error;
    }
  }
}

/** Where an include entry sits in the repository: beside the policy file. */
export function repositoryPath(
  source: Pick<RepositorySource, "path">,
  entry: string,
): string {
  const slash = source.path?.lastIndexOf("/") ?? -1;
  if (slash <= 0) return entry;
  const folder = source.path?.slice(0, slash) ?? "";
  return entry ? `${folder}/${entry}` : folder;
}

export const openappaRepositoryIncludes = new OpenAppaRepositoryIncludes();

function fold(params: {
  content: string;
  files: ReadonlyMap<string, string>;
  serverTools?: ReadonlyMap<string, readonly string[]>;
  batteryHelpers?: ReadonlyMap<string, string>;
}): ExpandedRoot {
  const { paths, covered, ...expanded } = expandRepositoryIncludes(params);
  return {
    ...expanded,
    included: paths.map((path) => {
      const tools = covered.get(path);
      return {
        path,
        sha256: repositoryFileHash(params.files.get(path) as string),
        ...(tools ? { tools } : {}),
      };
    }),
  };
}

/**
 * The annotators the batteries `content` includes declare, by name, when a
 * server file among `files` declares an annotator; nothing is read otherwise.
 */
async function batteryHelpersFor(params: {
  organizationId: string;
  content: string;
  files: ReadonlyMap<string, string>;
}): Promise<Map<string, string> | undefined> {
  if (!serverFilesDeclareAnnotators(params.files)) return undefined;
  // Loaded when used: the declarations fold repository files through here.
  const { openappaDeclarations } = await import("@/openappa/declarations");
  return openappaDeclarations.batteryHelpers(params);
}

/**
 * The current tools of each server whose file has a `<prefix>__*` rule, by
 * prefix; nothing is read when no file has one.
 */
async function serverToolsFor(
  organizationId: string,
  files: ReadonlyMap<string, string>,
): Promise<Map<string, string[]> | undefined> {
  const prefixes = serverCatchAllPrefixes(files);
  if (prefixes.length === 0) return undefined;
  const tools = await ToolModel.getToolNamesByPrefixes({
    scopeCatalogIds:
      await InternalMcpCatalogModel.findIdsVisibleToOrganization(
        organizationId,
      ),
    prefixes,
    catalogIds: [],
  });
  const byPrefix = new Map<string, string[]>();
  for (const { name } of tools) {
    // A tool whose own name holds the separator belongs to a longer prefix.
    const server = parseFullToolName(name).serverName;
    if (server && prefixes.includes(server))
      byPrefix.set(server, [...(byPrefix.get(server) ?? []), name]);
  }
  return byPrefix;
}

/** One commit's key, or one folder's at that commit. */
function cacheKey(source: RepositorySource, commit: string, folder?: string) {
  return [source.organizationId, source.repo, commit, folder ?? "\u0001"].join(
    "\u0000",
  );
}

function blobKey(source: RepositorySource, blob: string) {
  return [source.organizationId, source.repo, blob].join("\u0000");
}

/** Reads one repository at a commit, with the source's credential. */
type RepositoryReader = {
  /** The files directly in `folder` ("" for the top), by name, with their blob ids. */
  list(commit: string, folder: string): Promise<Map<string, string>>;
  /** One file's text; null when the commit has no such file. */
  text(commit: string, path: string): Promise<string | null>;
};

async function repositoryReader(
  source: RepositorySource,
): Promise<RepositoryReader> {
  if (source.gitlabTokenId) {
    const access = await resolveOpenAppaGitlabAccess({
      organizationId: source.organizationId,
      gitlabTokenId: source.gitlabTokenId,
    });
    const client = gitClient(access);
    return {
      list: (commit, folder) =>
        hostErrors(folder, async () => {
          const names = new Map<string, string>();
          let url: string | null =
            `${client.repoApi(source.repo)}/repository/tree?ref=${commit}&per_page=100&pagination=keyset${folder ? `&path=${encodeURIComponent(folder)}` : ""}`;
          for (let page = 0; url; page++) {
            if (page >= LISTING_PAGES)
              throw new ApiError(
                400,
                `${folder || "The repository's top folder"} holds too many files to read`,
              );
            const response = await client.request(url);
            // A folder the commit does not hold.
            if (response.status === 404) return names;
            if (!response.ok)
              throw new ApiError(
                502,
                `GitLab returned HTTP ${response.status} listing ${folder || "the policy repository"}. Check repository access.`,
              );
            for (const item of (await response.json()) as Array<{
              id?: string;
              name?: string;
              type?: string;
            }>)
              if (item.type === "blob" && item.id && item.name)
                names.set(item.name, item.id);
            url = nextPage(
              response.headers.get("link"),
              client.repoApi(source.repo),
            );
          }
          return names;
        }),
      text: (commit, path) =>
        hostErrors(path, async () => {
          const bytes = await client.readFile({
            repo: source.repo,
            ref: commit,
            path,
            maxBytes: FILE_MAX_BYTES,
          });
          return bytes ? utf8(path, bytes) : null;
        }),
    };
  }
  const { token, api } = await resolveOpenAppaGithubAccess(source, {
    contents: "read",
  });
  const get = async (
    url: string,
    accept: "application/vnd.github+json" | "application/vnd.github.raw+json",
    what: string,
  ) => {
    try {
      return await githubFetch({ url, token: token || undefined, accept });
    } catch (err) {
      logger.warn({ err }, "OpenAPPA could not reach GitHub");
      throw new ApiError(502, `Could not reach GitHub to read ${what}`);
    }
  };
  return {
    async list(commit, folder) {
      const what = folder || "the policy repository";
      const response = await get(
        `${api}/repos/${source.repo}/contents${folder ? `/${encodePath(folder)}` : ""}?ref=${commit}`,
        "application/vnd.github+json",
        what,
      );
      // A folder the commit does not hold.
      if (response.status === 404) return new Map();
      if (!response.ok)
        throw new ApiError(
          502,
          `GitHub returned HTTP ${response.status} listing ${what}. Check repository access.`,
        );
      const bytes = await readResponseBodyWithLimit(
        response,
        LISTING_MAX_BYTES,
      );
      if (!bytes)
        throw new ApiError(502, `GitHub's listing of ${what} is too large`);
      let items: unknown;
      try {
        items = JSON.parse(bytes.toString());
      } catch {
        throw new ApiError(
          502,
          `GitHub returned an invalid listing of ${what}`,
        );
      }
      // A file, not a folder: it holds no include.
      if (!Array.isArray(items)) return new Map();
      // GitHub lists at most 1,000 entries of a folder, so a full page may
      // leave files out.
      if (items.length >= GITHUB_LISTING_LIMIT)
        throw new ApiError(
          400,
          `${what} holds ${GITHUB_LISTING_LIMIT} entries or more, more than GitHub lists at once`,
        );
      const names = new Map<string, string>();
      for (const item of items as Array<{
        type?: string;
        name?: string;
        sha?: string;
      }>)
        if (item.type === "file" && item.sha && item.name)
          names.set(item.name, item.sha);
      return names;
    },
    async text(commit, path) {
      const response = await get(
        `${api}/repos/${source.repo}/contents/${encodePath(path)}?ref=${commit}`,
        "application/vnd.github.raw+json",
        path,
      );
      if (response.status === 404) return null;
      if (!response.ok)
        throw new ApiError(
          502,
          `GitHub returned HTTP ${response.status} for ${path}. Check repository access.`,
        );
      const bytes = await readResponseBodyWithLimit(response, FILE_MAX_BYTES);
      if (!bytes) throw new ApiError(400, `${path} exceeds the 1 MiB limit`);
      return utf8(path, bytes);
    },
  };
}

/** GitHub's most entries in one folder listing. */
const GITHUB_LISTING_LIMIT = 1000;

/** The most bytes one GitHub folder listing is read to, as other GitHub reads. */
const LISTING_MAX_BYTES = 2 * 1024 * 1024;

/** GitLab tree pages of 100 read for one folder. */
const LISTING_PAGES = 10;

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function utf8(path: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(400, `${path} is not UTF-8 text`);
  }
}

/**
 * The `rel="next"` URL of a GitLab Link header, or null on the last page. The
 * token goes with the request, so only a page on the API's own origin is read.
 */
function nextPage(link: string | null, api: string): string | null {
  const next = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  if (!next) return null;
  let origin: string | null = null;
  try {
    origin = new URL(next).origin;
  } catch {
    origin = null;
  }
  if (origin !== new URL(api).origin)
    throw new ApiError(502, "GitLab named a next page on another host");
  return next;
}

/** A host client's failure as the API error the fold reports. */
async function hostErrors<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GitHostError)
      throw new ApiError(
        502,
        `Could not read ${what || "the policy repository"}: ${error.message}`,
      );
    throw error;
  }
}
