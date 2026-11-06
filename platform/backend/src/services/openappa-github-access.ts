import { parseFullToolName } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import {
  type GitAccess,
  gitClient,
  resolveGitCredentialAccess,
} from "@/git-hosts/git-access";
import { GitHostError } from "@/git-hosts/git-host-client";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
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
  withoutRepositoryIncludes,
} from "@/openappa/policy-text";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";
import {
  resolveGithubPatToken,
  resolveGithubSkillAppCredentials,
} from "@/skills/github-app-token";
import { GITHUB_DOT_COM_SOURCE } from "@/skills/github-source";
import { ApiError } from "@/types";
import { mapWithConcurrency } from "@/utils/concurrency";

/**
 * The token and GitHub origins for an OpenAPPA policy source. A GitHub App
 * carries its own API URL, so GitHub Enterprise Server works like github.com;
 * personal access tokens and public reads are github.com only.
 */
export async function resolveOpenAppaGithubAccess(source: {
  organizationId: string;
  githubPatId: string | null;
  githubAppConfigId: string | null;
}): Promise<OpenAppaGithubAccess> {
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
  /** The `.toml` files directly in one folder at one commit, by name. */
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
        const key = cacheKey(source, commit, folder);
        let names = this.listings.get(key);
        if (!names) {
          names = await (await open()).list(
            commit,
            repositoryPath(source, folder),
          );
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
  /** The `.toml` files directly in `folder` ("" for the top), by name, with their blob ids. */
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
              if (
                item.type === "blob" &&
                item.id &&
                item.name?.endsWith(".toml")
              )
                names.set(item.name, item.id);
            url = nextPage(response.headers.get("link"));
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
  const { token, api } = await resolveOpenAppaGithubAccess(source);
  const get = async (url: string, accept: string, what: string) => {
    try {
      return await fetch(url, {
        headers: {
          Accept: accept,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
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
      const items = (await response.json()) as unknown;
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
        if (item.type === "file" && item.sha && item.name?.endsWith(".toml"))
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

/** The `rel="next"` URL of a Link header, or null on the last page. */
function nextPage(link: string | null): string | null {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
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
