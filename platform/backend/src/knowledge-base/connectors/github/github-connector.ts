import { Octokit } from "@octokit/rest";
import type pino from "pino";
import { LRUCacheManager } from "@/cache-manager";
import { resolveInstallationToken } from "@/integrations/github/app-auth";
import * as metrics from "@/observability/metrics";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  DocumentPermissions,
  GithubCheckpoint,
  GithubConfig,
  GroupMembershipYield,
  GroupMemberYield,
  PermissionSnapshotYield,
  PermissionSyncParams,
  ResolveMappedEmail,
} from "@/types";
import { GithubConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
  REQUEST_TIMEOUT_MS,
} from "../base-connector";
import { ConnectorIdentityCache } from "../identity-cache";

const BATCH_SIZE = 50;
/** Cap for the per-pass login → profile cache: sized so a normal org never evicts. */
const USER_PROFILE_CACHE_MAX_SIZE = 10_000;
/**
 * Requests left in the credential's hourly budget below which a permission pass
 * stops making OPTIONAL identity lookups (the per-login profile fetch).
 *
 * Resolving a login to an email is one rate-limited request per account, and a
 * token gets 5,000 an hour for EVERYTHING — including the content sync that
 * shares the credential. Without a floor, a pass over a few large repos spends
 * the whole budget on profile lookups and then every later request 403s, which
 * fails the mandatory calls too: `resolveRepoAudience` catches, returns an empty
 * audience, and the repo's entire corpus goes dark. Stopping the optional work
 * early costs the unresolved accounts their grants (fail-closed under-grant, the
 * same as a private email, and rescued by an admin member mapping) and leaves
 * the mandatory calls a budget to finish in.
 */
const RATE_LIMIT_RESERVE = 500;

/** A login whose profile we could not (or chose not to) fetch. */
const UNRESOLVED_PROFILE: { email: string | null; name: string | null } = {
  email: null,
  name: null,
};

export class GithubConnector extends BaseConnector {
  type = "github" as const;
  supportsPermissionSync = true;

  /**
   * Per-pass cache of GitHub login → public profile (email null when private).
   * Size-bounded LRU (no TTL — the instance is per-pass) so a huge org cannot
   * grow it without limit; eviction only costs a re-fetch.
   */
  private userProfileCache = new LRUCacheManager<{
    email: string | null;
    name: string | null;
  }>({ maxSize: USER_PROFILE_CACHE_MAX_SIZE, defaultTtl: 0 });
  /**
   * Cross-pass persistence behind `userProfileCache`: login → profile results
   * (including private-email negatives) survive the pass so the next run does
   * not re-probe every collaborator/member. Armed per permission pass.
   */
  private persistentProfileCache: ConnectorIdentityCache<{
    email: string | null;
    name: string | null;
  }> | null = null;
  /**
   * Admin member mappings (login → mapped email), armed per pass. Consulted
   * FIRST when materializing a direct collaborator grant, so a mapped account
   * whose GitHub email is private still lands on container audiences instead
   * of being dropped fail-closed. Group-derived access needs no
   * materialization — memberships carry the login and resolve the mapping at
   * query time.
   */
  private resolveMappedEmail: ResolveMappedEmail | null = null;
  /**
   * Requests left in the credential's hourly budget, as of the last response
   * this pass saw (`x-ratelimit-remaining`). Null until the first response.
   */
  private remainingRateLimit: number | null = null;
  /** Profile lookups this pass declined to make because of the reserve. */
  private identityLookupsSkipped = 0;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.validateConfigWithSchema({
      config,
      parser: parseGithubConfig,
      label: "GitHub",
      invalidConfigError:
        "Invalid GitHub configuration: githubUrl (string) and owner (string) are required",
      extraChecks: (parsed) => validateGithubConfig(parsed),
    });
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseGithubConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid GitHub configuration" };
    }

    return this.runConnectionTest({
      label: "GitHub",
      probe: async () => {
        const octokit = await createOctokit(
          parsed,
          params.credentials,
          this.log,
        );
        if (parsed.authMethod === "github_app") {
          await octokit.rest.apps.listReposAccessibleToInstallation({
            per_page: 1,
          });
          return;
        }
        await octokit.rest.users.getAuthenticated();
      },
    });
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseGithubConfig(params.config);
    if (!parsed) return null;

    // Repository file count cannot be estimated without fetching the full repo
    // tree, so skip estimation entirely when file syncing is enabled.
    if (parsed.includeRepositoryFiles) return null;

    this.log.debug(
      { owner: parsed.owner, repos: parsed.repos },
      "Estimating total items",
    );

    try {
      const octokit = await createOctokit(parsed, params.credentials, this.log);
      const repos = await getRepos(octokit, parsed);
      let total = 0;

      for (const repo of repos) {
        if (parsed.includeIssues !== false) {
          const result = await octokit.rest.search.issuesAndPullRequests({
            q: `repo:${repo.owner}/${repo.name} is:issue`,
            per_page: 1,
          });
          total += result.data.total_count;
        }

        if (parsed.includePullRequests !== false) {
          const result = await octokit.rest.search.issuesAndPullRequests({
            q: `repo:${repo.owner}/${repo.name} is:pr`,
            per_page: 1,
          });
          total += result.data.total_count;
        }

        await this.rateLimit();
      }

      return total;
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Failed to estimate total items",
      );
      return null;
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseGithubConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid GitHub configuration");
    }

    const checkpoint = (params.checkpoint as GithubCheckpoint | null) ?? {
      type: "github" as const,
    };
    const octokit = await createOctokit(parsed, params.credentials, this.log);
    const repos = await getRepos(octokit, parsed);

    this.log.debug(
      {
        baseUrl: parsed.githubUrl,
        owner: parsed.owner,
        repoCount: repos.length,
        includeIssues: parsed.includeIssues,
        includePullRequests: parsed.includePullRequests,
        checkpoint,
      },
      "Starting sync",
    );

    for (let repoIdx = 0; repoIdx < repos.length; repoIdx++) {
      const repo = repos[repoIdx];
      const isLastRepo = repoIdx === repos.length - 1;
      const hasRepositoryFiles = parsed.includeRepositoryFiles === true;

      if (parsed.includeIssues !== false) {
        yield* this.syncRepoItems({
          octokit,
          config: parsed,
          repo,
          checkpoint,
          kind: "issue",
          isLastGroup:
            isLastRepo &&
            parsed.includePullRequests === false &&
            !hasRepositoryFiles,
        });
      }

      if (parsed.includePullRequests !== false) {
        yield* this.syncRepoItems({
          octokit,
          config: parsed,
          repo,
          checkpoint,
          kind: "pr",
          isLastGroup: isLastRepo && !hasRepositoryFiles,
        });
      }

      if (hasRepositoryFiles) {
        yield* this.syncRepoFiles({
          octokit,
          config: parsed,
          repo,
          checkpoint,
          isLastGroup: isLastRepo,
        });
      }
    }
  }

  // ===== Private methods =====

  private async *syncRepoItems(params: {
    octokit: Octokit;
    config: GithubConfig;
    repo: GithubRepo;
    checkpoint: GithubCheckpoint;
    kind: "issue" | "pr";
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { octokit, config, repo, checkpoint, kind, isLastGroup } = params;
    let page = 1;
    let pageHasMore = true;

    this.log.debug(
      { repo: `${repo.owner}/${repo.name}`, kind },
      "Syncing repo items",
    );

    while (pageHasMore) {
      await this.rateLimit();

      let response: Awaited<ReturnType<typeof octokit.rest.issues.listForRepo>>;
      try {
        this.log.debug(
          { repo: `${repo.owner}/${repo.name}`, kind, page },
          "Fetching batch",
        );

        response = await octokit.rest.issues.listForRepo({
          owner: repo.owner,
          repo: repo.name,
          state: "all",
          per_page: BATCH_SIZE,
          page,
          sort: "updated",
          direction: "asc",
          ...(checkpoint.lastSyncedAt
            ? { since: checkpoint.lastSyncedAt }
            : {}),
        });
      } catch (err) {
        if (
          err instanceof Error &&
          "status" in err &&
          (err as Record<string, unknown>).status === 404
        ) {
          this.log.debug(
            { repo: `${repo.owner}/${repo.name}`, kind },
            "Repo not found or issues disabled, skipping",
          );
          break;
        }
        this.log.error(
          {
            repo: `${repo.owner}/${repo.name}`,
            kind,
            page,
            error: extractErrorMessage(err),
          },
          "Batch fetch failed",
        );
        throw err;
      }

      const items = response.data.filter((item) => {
        const isPr = !!item.pull_request;
        if (kind === "issue" && isPr) return false;
        if (kind === "pr" && !isPr) return false;
        return !shouldSkipItem(item, config.labelsToSkip);
      });

      const documents: ConnectorDocument[] = [];
      for (const item of items) {
        await this.rateLimit();
        const comments = await this.safeItemFetch({
          fetch: () => getItemComments(octokit, repo, item.number),
          fallback: [],
          itemId: item.number,
          resource: "comments",
        });
        documents.push(itemToDocument(item, comments, repo, kind));
      }

      pageHasMore = response.data.length >= BATCH_SIZE;
      page++;

      this.log.debug(
        {
          repo: `${repo.owner}/${repo.name}`,
          kind,
          itemCount: items.length,
          documentCount: documents.length,
          hasMore: pageHasMore || !isLastGroup,
        },
        "Batch fetched",
      );

      const lastItem = items.length > 0 ? items[items.length - 1] : null;

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: lastItem?.updated_at,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: pageHasMore || !isLastGroup,
      };
    }
  }
  private async *syncRepoFiles(params: {
    octokit: Octokit;
    config: GithubConfig;
    repo: GithubRepo;
    checkpoint: GithubCheckpoint;
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { octokit, config, repo, checkpoint, isLastGroup } = params;
    const repoFullName = `${repo.owner}/${repo.name}`;
    const indexedExtensions = getIndexedFileExtensions(config);

    this.log.info(
      { repo: repoFullName, indexedExtensions },
      "Starting repository file sync",
    );

    let treeSha: string;
    let branch: string;

    const branchCandidates = repo.defaultBranch
      ? [repo.defaultBranch]
      : FALLBACK_BRANCHES;

    const resolved = await resolveDefaultBranch(
      octokit,
      repo,
      branchCandidates,
      this.log,
    );

    if (!resolved) {
      this.log.error(
        { repo: repoFullName, triedBranches: branchCandidates },
        "Could not resolve default branch, skipping markdown sync",
      );
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    branch = resolved.branch;
    treeSha = resolved.sha;

    this.log.debug(
      { repo: repoFullName, branch, treeSha },
      "Fetching repository tree",
    );

    let treeItems: Array<{ path: string; sha: string }>;
    try {
      const treeResponse = await octokit.rest.git.getTree({
        owner: repo.owner,
        repo: repo.name,
        tree_sha: treeSha,
        recursive: "true",
      });
      const allItems = treeResponse.data.tree;
      treeItems = allItems
        .filter(
          (item) =>
            item.type === "blob" &&
            item.path &&
            isIndexedRepositoryFile(item.path, indexedExtensions) &&
            item.sha,
        )
        .map((item) => ({
          path: item.path as string,
          sha: item.sha as string,
        }));

      this.log.info(
        {
          repo: repoFullName,
          branch,
          totalTreeItems: allItems.length,
          fileCount: treeItems.length,
        },
        "Found repository files to index",
      );
    } catch (err) {
      this.log.error(
        {
          repo: repoFullName,
          branch,
          treeSha,
          error: extractErrorMessage(err),
        },
        "Failed to fetch repository tree, skipping file sync",
      );
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    if (treeItems.length === 0) {
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    for (let i = 0; i < treeItems.length; i += BATCH_SIZE) {
      const batch = treeItems.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(treeItems.length / BATCH_SIZE);
      const documents: ConnectorDocument[] = [];

      this.log.debug(
        {
          repo: repoFullName,
          branch,
          batch: batchNumber,
          totalBatches,
          batchSize: batch.length,
        },
        "Fetching repository file contents",
      );

      for (const file of batch) {
        await this.rateLimit();
        const content = await this.safeItemFetch({
          fetch: () => getFileContent(octokit, repo, file.path),
          fallback: null,
          itemId: file.path,
          resource: "file_content",
        });

        if (content !== null) {
          documents.push(
            repositoryFileToDocument(file.path, content, repo, branch),
          );
        }
      }

      const failures = this.flushFailures();
      const hasMoreFiles = i + BATCH_SIZE < treeItems.length;

      this.log.info(
        {
          repo: repoFullName,
          branch,
          batch: batchNumber,
          totalBatches,
          documentsIndexed: documents.length,
          failureCount: failures.length,
          hasMore: hasMoreFiles || !isLastGroup,
        },
        "Repository file batch completed",
      );

      yield {
        documents,
        failures,
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: hasMoreFiles || !isLastGroup,
      };
    }
  }

  // ===== Permission sync hooks =====

  /**
   * Repo-scoped snapshot. Each repo is one top-level container
   * `repo:<owner>/<name>` whose audience is resolved ONCE (private/public +
   * collaborators + teams); its already-ingested documents are assigned via
   * read-back — upstream calls are O(repos + collaborators), never O(docs).
   * The read-back mirrors our own corpus, so the pass's per-container
   * fail-close diff is naturally empty for GitHub (content-sync owns document
   * deletions); a repo that VANISHES upstream is caught by the pass's stale
   * container sweep instead.
   */
  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const config = parseGithubConfig(params.config);
    if (!config) {
      throw new Error("Invalid GitHub configuration for permission sync");
    }
    const octokit = await createOctokit(config, params.credentials, this.log);
    this.initPersistentProfileCache(
      config,
      params.credentials,
      params.refreshIdentities,
    );
    this.resolveMappedEmail = params.resolveMappedEmail ?? null;
    const repos = await getRepos(octokit, config);
    // Stable codepoint order so the resume cursor (a container key) is
    // monotonic under plain string comparison.
    const sorted = [...repos].sort((a, b) => {
      const left = githubRepoKey(a);
      const right = githubRepoKey(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });

    const scope = params.scope ? new Set(params.scope.containerKeys) : null;
    for (const repo of sorted) {
      const repoKey = githubRepoKey(repo);
      const containerKey = `repo:${repoKey}`;
      if (scope && !scope.has(containerKey)) continue;
      // Resume: containers strictly before the cursor are already done. The
      // cursor container is re-processed (idempotent — same audience).
      if (params.cursor && containerKey < params.cursor) continue;

      const audience = await this.resolveRepoAudience(octokit, repo);
      yield {
        kind: "container",
        containerKey,
        permissions: audience.permissions,
        audienceResolutionFailed: audience.resolutionFailed,
        cursor: containerKey,
      };

      let afterId: string | null = null;
      for (;;) {
        const { documents, nextAfterId } = await params.readIngestedDocuments({
          metadataFilter: { repo: repoKey },
          afterId,
          limit: GITHUB_READBACK_PAGE_SIZE,
        });
        for (const doc of documents) {
          yield {
            kind: "document",
            sourceId: doc.sourceId,
            containerKey,
            cursor: containerKey,
          };
        }
        if (documents.length < GITHUB_READBACK_PAGE_SIZE) break;
        afterId = nextAfterId;
      }
    }

    this.reportSkippedIdentityLookups();
  }

  /**
   * Local-adoption scoping for delta passes: a stored document is covered by
   * its repository's enumeration (content-sync writes `metadata.repo` =
   * `<owner>/<name>`, matching the container key). Scoping only — the repo
   * enumeration resolves the authoritative audience, so this can never
   * over-grant.
   */
  scopeKeyForDocument(metadata: Record<string, unknown>): string | null {
    const repo = metadata.repo;
    return typeof repo === "string" && repo.length > 0 ? `repo:${repo}` : null;
  }

  /**
   * Org teams → member emails, across every org that owns a synced repo. Group
   * ids are namespaced `<org>/<team-slug>` to match the tokens written on
   * documents (see resolveRepoAudience).
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseGithubConfig(params.config);
    if (!config) {
      throw new Error("Invalid GitHub configuration for permission sync");
    }
    const octokit = await createOctokit(config, params.credentials, this.log);
    this.initPersistentProfileCache(
      config,
      params.credentials,
      params.refreshIdentities,
    );
    const repos = await getRepos(octokit, config);
    const orgs = [...new Set(repos.map((repo) => repo.owner))].sort();

    for (const org of orgs) {
      for await (const team of this.paginate((page) =>
        octokit.rest.teams.list({ org, per_page: 100, page }),
      )) {
        const members: GroupMemberYield[] = [];
        for await (const member of this.paginate((page) =>
          octokit.rest.teams.listMembersInOrg({
            org,
            team_slug: team.slug,
            per_page: 100,
            page,
          }),
        )) {
          // Every member is recorded; GitHub only exposes an email the user
          // made public, so `email` is often null (fail-closed, but visible
          // to admins as unresolvable instead of silently dropped). The member
          // listing already carries the public email when there is one, so most
          // members cost no request of their own.
          const profile = await this.resolveUserProfile(octokit, member.login, {
            email: member.email,
            name: member.name,
          });
          members.push({
            accountId: member.login,
            displayName: profile.name,
            email: profile.email,
          });
        }
        yield {
          groupId: githubGroupId(org, team.slug),
          members,
          cursor: `${org}/${team.slug}`,
        };
      }
    }

    this.reportSkippedIdentityLookups();
  }

  private async resolveRepoAudience(
    octokit: Octokit,
    repo: GithubRepo,
  ): Promise<{ permissions: DocumentPermissions; resolutionFailed: boolean }> {
    try {
      await this.rateLimit();
      const meta = await octokit.rest.repos.get({
        owner: repo.owner,
        repo: repo.name,
      });
      this.noteRateLimit(meta.headers);
      const isPublic = !meta.data.private;

      const users: string[] = [];
      let dropped = 0;
      for await (const collaborator of this.paginate((page) =>
        octokit.rest.repos.listCollaborators({
          owner: repo.owner,
          repo: repo.name,
          per_page: 100,
          page,
        }),
      )) {
        // The public-profile email always wins (automatic matching takes
        // precedence); the mapping only rescues accounts whose email GitHub
        // keeps private. The collaborator listing already carries that public
        // email when there is one, so it costs no request of its own.
        const email =
          (
            await this.resolveUserProfile(octokit, collaborator.login, {
              email: collaborator.email,
              name: collaborator.name,
            })
          ).email ?? this.resolveMappedEmail?.(collaborator.login);
        if (email) users.push(email);
        else dropped++;
      }
      this.meterDroppedPrincipals(dropped);

      const groups: string[] = [];
      for await (const team of this.paginate((page) =>
        octokit.rest.repos.listTeams({
          owner: repo.owner,
          repo: repo.name,
          per_page: 100,
          page,
        }),
      )) {
        groups.push(githubGroupId(repo.owner, team.slug));
      }

      return {
        permissions: { isPublic, users, groups },
        resolutionFailed: false,
      };
    } catch (error) {
      // Same per-container failure isolation as Jira/Confluence: a transient
      // upstream error must not fail the whole pass. Partial results are
      // discarded — an empty audience fail-closes the repo (under-grant)
      // until the next successful pass, and the pass counts it so the repo
      // going dark does not read as "nobody has access to this repo".
      this.log.error(
        { repo: githubRepoKey(repo), error: extractErrorMessage(error) },
        "Could not read the repository's audience; every document in it is fail-closed for this pass",
      );
      return {
        permissions: { isPublic: false, users: [], groups: [] },
        resolutionFailed: true,
      };
    }
  }

  /**
   * Meter upstream principals dropped because their email could not be resolved
   * (private GitHub email). Fail-closed under-grant — surfaced so admins see the
   * coverage gap rather than silently narrowing an audience.
   */
  private meterDroppedPrincipals(count: number): void {
    if (count <= 0) return;
    this.log.debug(
      { count, connectorType: this.type },
      "Dropped GitHub principals with no resolvable email (fail-closed)",
    );
    metrics.rag.reportPermissionSyncDroppedPrincipals({
      connectorType: this.type,
      reason: "no_email",
      count,
    });
  }

  /**
   * Resolve a login to its public profile. GitHub only exposes an email when the
   * user has made it public — no token scope reveals a private one — so `email`
   * is null for most members (fail-closed, documented limitation).
   *
   * `known` is the email/name GitHub already put in the list response that named
   * this login. The collaborator and org-member schemas both carry them, and
   * they are the same public-profile values `GET /users/{login}` would return —
   * so when one is there, taking it turns a per-account request into no request
   * at all. This is the difference between O(collaborators) and O(1) requests
   * for a repo whose collaborators GitHub already told us about.
   */
  private async resolveUserProfile(
    octokit: Octokit,
    login: string,
    known?: { email?: string | null; name?: string | null },
  ): Promise<{ email: string | null; name: string | null }> {
    if (known?.email) {
      const profile = { email: known.email, name: known.name ?? null };
      this.userProfileCache.set(login, profile);
      await this.persistentProfileCache?.set(login, profile);
      return profile;
    }

    const cached = this.userProfileCache.get(login);
    if (cached !== undefined) return cached;
    const persisted = await this.persistentProfileCache?.get(login);
    if (persisted !== undefined) {
      this.userProfileCache.set(login, persisted);
      return persisted;
    }

    if (
      this.remainingRateLimit !== null &&
      this.remainingRateLimit <= RATE_LIMIT_RESERVE
    ) {
      // Out of budget for optional work. Remembered for the rest of THIS pass
      // only — never written to the cross-pass cache, which would persist a
      // fabricated "no email" for a day and lock the account out of its grants
      // long after the budget recovered.
      this.identityLookupsSkipped += 1;
      this.userProfileCache.set(login, UNRESOLVED_PROFILE);
      return UNRESOLVED_PROFILE;
    }

    let profile: { email: string | null; name: string | null } =
      UNRESOLVED_PROFILE;
    try {
      await this.rateLimit();
      const response = await octokit.rest.users.getByUsername({
        username: login,
      });
      this.noteRateLimit(response.headers);
      profile = {
        email: response.data.email ?? null,
        name: response.data.name ?? null,
      };
    } catch (error) {
      this.log.debug(
        { login, error: extractErrorMessage(error) },
        "Could not resolve GitHub user profile",
      );
    }
    this.userProfileCache.set(login, profile);
    await this.persistentProfileCache?.set(login, profile);
    return profile;
  }

  /**
   * Note the credential's remaining hourly budget, which GitHub returns on every
   * response, so `resolveUserProfile` can stop spending it on optional lookups
   * before the mandatory calls start failing (see RATE_LIMIT_RESERVE). Read off
   * the responses rather than an octokit request hook, so it needs nothing of
   * the client but the shape every REST call already returns. A response without
   * the header simply leaves the budget unknown, and an unknown budget never
   * skips anything.
   */
  private noteRateLimit(headers?: {
    "x-ratelimit-remaining"?: string | number;
  }): void {
    const remaining = Number(headers?.["x-ratelimit-remaining"]);
    if (Number.isFinite(remaining)) this.remainingRateLimit = remaining;
  }

  /** Report (and reset) the identity lookups the reserve made this pass skip. */
  private reportSkippedIdentityLookups(): void {
    if (this.identityLookupsSkipped === 0) return;
    const skipped = this.identityLookupsSkipped;
    this.identityLookupsSkipped = 0;
    this.log.warn(
      { skipped, remainingRateLimit: this.remainingRateLimit },
      "GitHub rate-limit budget hit the reserve; stopped resolving member emails for this pass (those members lose their grants until the next pass — map them manually on the Users tab if this persists)",
    );
    metrics.rag.reportPermissionSyncIdentityLookupsSkipped({
      connectorType: this.type,
      count: skipped,
    });
  }

  /** Arm the cross-pass profile cache for one permission pass. */
  private initPersistentProfileCache(
    config: GithubConfig,
    credentials: ConnectorCredentials,
    refresh?: boolean,
  ): void {
    this.persistentProfileCache = new ConnectorIdentityCache({
      namespace: "github-profile",
      host: resolveGithubApiUrl(config, credentials),
      credentials,
      refresh,
    });
  }

  /** Rate-limited generic pager over a 100-per-page GitHub list endpoint. */
  private async *paginate<T>(
    fetchPage: (page: number) => Promise<{
      data: T[];
      headers?: { "x-ratelimit-remaining"?: string | number };
    }>,
  ): AsyncGenerator<T> {
    let page = 1;
    for (;;) {
      await this.rateLimit();
      const response = await fetchPage(page);
      this.noteRateLimit(response.headers);
      const items = response.data;
      for (const item of items) yield item;
      if (items.length < 100) break;
      page++;
    }
  }
}

// ===== Module-level helpers =====

const GITHUB_READBACK_PAGE_SIZE = 200;

function githubItemSourceId(repoName: string, itemNumber: number): string {
  return `${repoName}#${itemNumber}`;
}

function githubFileSourceId(repoName: string, filePath: string): string {
  return `${repoName}#file:${filePath}`;
}

function githubRepoKey(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}

/**
 * Namespace a team by its org so team slugs never collide across orgs. Written
 * on documents and stored by syncGroups identically, so the group data-contract
 * byte-matches.
 */
function githubGroupId(org: string, teamSlug: string): string {
  return `${org}/${teamSlug}`;
}

async function createOctokit(
  config: GithubConfig,
  credentials: ConnectorCredentials,
  log: pino.Logger,
): Promise<Octokit> {
  const nativeFetch = globalThis.fetch;
  const auth = await resolveGithubAuthToken(config, credentials, nativeFetch);
  return new Octokit({
    auth,
    baseUrl: resolveGithubApiUrl(config, credentials).replace(/\/+$/, ""),
    log: {
      debug: (message: string) =>
        log.debug({ sdkMessage: message }, "SDK debug"),
      info: (message: string) => log.debug({ sdkMessage: message }, "SDK info"),
      warn: (message: string) =>
        log.warn({ sdkMessage: message }, "SDK warning"),
      error: (message: string) =>
        log.error({ sdkMessage: message }, "SDK error"),
    },
    request: {
      fetch: (url: string | URL | Request, init?: RequestInit) =>
        nativeFetch(url, {
          ...init,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
    },
  });
}

// the App config owns the host its installation token is minted against, so
// App-auth connectors must talk to that host regardless of config.githubUrl
function resolveGithubApiUrl(
  config: GithubConfig,
  credentials: ConnectorCredentials,
): string {
  if (config.authMethod === "github_app" && credentials.githubApp) {
    return credentials.githubApp.githubUrl;
  }
  return config.githubUrl;
}

async function resolveGithubAuthToken(
  config: GithubConfig,
  credentials: ConnectorCredentials,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (config.authMethod !== "github_app") {
    return credentials.apiToken;
  }

  const app = credentials.githubApp;
  if (!app) {
    throw new Error(
      "GitHub App credentials were not resolved for this connector",
    );
  }

  return resolveInstallationToken(
    {
      githubUrl: app.githubUrl,
      appId: app.appId,
      installationId: app.installationId,
      privateKey: credentials.apiToken,
    },
    fetchImpl,
  );
}

function parseGithubConfig(
  config: Record<string, unknown>,
): GithubConfig | null {
  const result = GithubConfigSchema.safeParse({ type: "github", ...config });
  return result.success ? result.data : null;
}

function validateGithubConfig(config: GithubConfig): string | null {
  if (!/^https?:\/\/.+/.test(config.githubUrl)) {
    return "githubUrl must be a valid HTTP(S) URL";
  }

  if (config.authMethod === "github_app" && !config.githubAppConfigId) {
    return "GitHub App authentication requires githubAppConfigId";
  }

  return null;
}

type GithubRepo = {
  owner: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string | null;
};

async function getRepos(
  octokit: Octokit,
  config: GithubConfig,
): Promise<GithubRepo[]> {
  if (config.repos && config.repos.length > 0) {
    const repos: GithubRepo[] = [];
    for (const entry of config.repos) {
      // A repo entry may be a bare name (belongs to config.owner) or a fully
      // qualified `owner/repo` slug — users routinely paste the latter, and it
      // is the only way to span multiple owners with a single owner field.
      // Pairing a slug with config.owner would build `/repos/{owner}/{owner/repo}`
      // which 404s and gets silently skipped, ingesting nothing.
      const { owner, name } = parseRepoEntry(entry, config.owner);
      let defaultBranch: string | null = null;
      try {
        const response = await octokit.rest.repos.get({ owner, repo: name });
        defaultBranch = response.data.default_branch;
      } catch {
        // If we can't fetch repo metadata, fall back to null (main→master fallback)
      }
      repos.push({
        owner,
        name,
        htmlUrl: `${config.githubUrl.replace(/\/api\/v3$/, "").replace(/\/+$/, "")}/${owner}/${name}`,
        defaultBranch,
      });
    }
    return repos;
  }

  const repos: GithubRepo[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    if (config.authMethod === "github_app") {
      const response =
        await octokit.rest.apps.listReposAccessibleToInstallation({
          per_page: 100,
          page,
        });

      for (const repo of response.data.repositories) {
        repos.push({
          owner: repo.owner?.login ?? config.owner,
          name: repo.name,
          htmlUrl: repo.html_url,
          defaultBranch: repo.default_branch ?? null,
        });
      }

      hasMore = response.data.repositories.length >= 100;
    } else {
      const response = await octokit.rest.repos.listForOrg({
        org: config.owner,
        per_page: 100,
        page,
        type: "all",
      });

      for (const repo of response.data) {
        repos.push({
          owner: config.owner,
          name: repo.name,
          htmlUrl: repo.html_url,
          defaultBranch: repo.default_branch ?? null,
        });
      }

      hasMore = response.data.length >= 100;
    }

    page++;
  }

  return repos;
}

/**
 * Split a configured repo entry into its owner and bare name. Accepts either a
 * bare `repo` (owned by `defaultOwner`) or a fully qualified `owner/repo` slug.
 * Only the first slash separates owner from name; GitHub repo names never
 * contain slashes, so anything after the first is folded back into the name and
 * left to fail loudly at the API rather than being silently mis-split.
 */
function parseRepoEntry(
  entry: string,
  defaultOwner: string,
): { owner: string; name: string } {
  const trimmed = entry.trim();
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return { owner: defaultOwner, name: trimmed };
  }
  return {
    owner: trimmed.slice(0, slash),
    name: trimmed.slice(slash + 1),
  };
}

const FALLBACK_BRANCHES = ["main", "master", "dev", "develop"];

async function resolveDefaultBranch(
  octokit: Octokit,
  repo: { owner: string; name: string },
  candidates: string[],
  log: pino.Logger,
): Promise<{ branch: string; sha: string } | null> {
  const repoFullName = `${repo.owner}/${repo.name}`;
  for (const candidate of candidates) {
    try {
      log.debug(
        { repo: repoFullName, branch: candidate },
        "Resolving branch ref",
      );
      const refResponse = await octokit.rest.git.getRef({
        owner: repo.owner,
        repo: repo.name,
        ref: `heads/${candidate}`,
      });
      log.debug(
        {
          repo: repoFullName,
          branch: candidate,
          sha: refResponse.data.object.sha,
        },
        "Resolved branch ref",
      );
      return { branch: candidate, sha: refResponse.data.object.sha };
    } catch (err) {
      log.info(
        {
          repo: repoFullName,
          branch: candidate,
          error: extractErrorMessage(err),
        },
        "Branch not found, trying next candidate",
      );
    }
  }
  return null;
}

async function getItemComments(
  octokit: Octokit,
  repo: { owner: string; name: string },
  issueNumber: number,
): Promise<Array<{ author: string; body: string; date: string }>> {
  const response = await octokit.rest.issues.listComments({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    per_page: 100,
  });

  return response.data.map((c) => ({
    author: c.user?.login ?? "unknown",
    body: c.body ?? "",
    date: c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : "",
  }));
}

// biome-ignore lint/suspicious/noExplicitAny: GitHub API response types
function shouldSkipItem(item: any, labelsToSkip?: string[]): boolean {
  if (!labelsToSkip || labelsToSkip.length === 0) return false;
  const itemLabels: string[] = (item.labels ?? []).map(
    // biome-ignore lint/suspicious/noExplicitAny: GitHub label shape
    (l: any) => (typeof l === "string" ? l : (l.name ?? "")),
  );
  return itemLabels.some((label) => labelsToSkip.includes(label));
}

const DEFAULT_REPOSITORY_FILE_EXTENSIONS = [".md", ".mdx", ".yaml", ".yml"];

function getIndexedFileExtensions(config: GithubConfig): string[] {
  const extensions =
    config.fileTypes && config.fileTypes.length > 0
      ? config.fileTypes
      : DEFAULT_REPOSITORY_FILE_EXTENSIONS;

  return extensions
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
}

function isIndexedRepositoryFile(path: string, extensions: string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

async function getFileContent(
  octokit: Octokit,
  repo: { owner: string; name: string },
  path: string,
): Promise<string> {
  const response = await octokit.rest.repos.getContent({
    owner: repo.owner,
    repo: repo.name,
    path,
  });

  const data = response.data;
  if (!("content" in data) || !data.content) {
    throw new Error(`No content returned for ${path}`);
  }

  return Buffer.from(data.content, "base64").toString("utf-8");
}

function repositoryFileToDocument(
  filePath: string,
  content: string,
  repo: { owner: string; name: string; htmlUrl: string },
  branch: string,
): ConnectorDocument {
  const fileName = filePath.split("/").pop() ?? filePath;
  return {
    id: githubFileSourceId(repo.name, filePath),
    title: `${fileName} (${repo.owner}/${repo.name})`,
    content,
    sourceUrl: `${repo.htmlUrl}/blob/${branch}/${filePath}`,
    metadata: {
      repo: `${repo.owner}/${repo.name}`,
      filePath,
      kind: "repository_file",
      fileKind: "repository_file",
    },
  };
}

function itemToDocument(
  // biome-ignore lint/suspicious/noExplicitAny: GitHub API response types
  item: any,
  comments: Array<{ author: string; body: string; date: string }>,
  repo: { owner: string; name: string; htmlUrl: string },
  kind: "issue" | "pr",
): ConnectorDocument {
  const prefix = kind === "pr" ? "Pull Request" : "Issue";
  const contentParts = [`# ${prefix}: ${item.title}`, "", item.body ?? ""];

  const nonEmptyComments = comments.filter((c) => c.body.trim());
  if (nonEmptyComments.length > 0) {
    contentParts.push("", "## Comments", "");
    for (const c of nonEmptyComments) {
      contentParts.push(`**${c.author}** (${c.date}): ${c.body}`);
    }
  }

  return {
    id: githubItemSourceId(repo.name, item.number),
    title: `${item.title} (${repo.owner}/${repo.name}#${item.number})`,
    content: contentParts.join("\n"),
    sourceUrl: item.html_url,
    metadata: {
      repo: `${repo.owner}/${repo.name}`,
      number: item.number,
      state: item.state,
      kind,
      labels: (item.labels ?? []).map(
        // biome-ignore lint/suspicious/noExplicitAny: GitHub label shape
        (l: any) => (typeof l === "string" ? l : (l.name ?? "")),
      ),
      author: item.user?.login,
    },
    updatedAt: item.updated_at ? new Date(item.updated_at) : undefined,
  };
}
