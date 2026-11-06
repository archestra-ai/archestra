import { randomUUID } from "node:crypto";
import { isBuiltInCatalogId, slugifyMcpServerName } from "@archestra/shared";
import logger from "@/logging";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import ToolModel from "@/models/tool";
import UserModel from "@/models/user";
import { catalogToolPrefixes } from "@/openappa/batteries";
import {
  asRecord,
  governsServerTool,
  includedFileErrors,
  includesServerRules,
  parsePolicyToml,
  SERVER_RULES_INCLUDE,
  serverRulesPath,
} from "@/openappa/policy-text";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { policyDiff } from "@/services/guardrails-policy-proposal";
import {
  githubFetch,
  githubJson,
  githubPolicyChangeErrors,
} from "@/services/openappa-github";
import {
  openappaRepositoryIncludes,
  repositoryPath,
  resolveOpenAppaGithubAccess,
  resolveOpenAppaGitlabAccess,
} from "@/services/openappa-github-access";
import { hasOwnFile } from "@/services/openappa-github-sync";
import { openappaGitlab } from "@/services/openappa-gitlab";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";

/**
 * An MCP server's own Guardrails rules, kept in its file in the Git sync
 * repository (`mcp/<tool prefix>.toml`) and included by `appa.toml`, by name
 * or with every server's through `mcp/*.toml`.
 *
 * Archestra decides only who may propose a change: whoever may edit the
 * server in the MCP registry, by the same rule as the registry's own edit.
 * Every change is a pull request (a merge request on GitLab) on the policy
 * repository; whether and when it applies is the repository's review to
 * decide, and Git sync applies it once merged. Nothing is stored here.
 */

/** Pull request branches this deployment opens for a server's rules. */
const BRANCH_PREFIX = "archestra/openappa-server-";

/** Whether a branch is one this deployment opened for this server's rules. */
function isServerBranch(prefix: string, branch: string): boolean {
  const start = `${BRANCH_PREFIX}${prefix}-`;
  return (
    branch.startsWith(start) && /^[0-9a-f]{8}$/.test(branch.slice(start.length))
  );
}

type Caller = { organizationId: string; userId: string };

/** What a caller reads about one server's rules. */
export async function getServerRules(params: Caller & { catalogId: string }) {
  const server = await serverFor(params);
  const [root, source] = await Promise.all([
    guardrailsPolicyService.get(params.organizationId),
    OpenAppaGithubSyncModel.find(params.organizationId),
  ]);
  const included = includesServerRules(root.content, server.path);
  const accepted = await acceptedFile({
    organizationId: params.organizationId,
    path: server.path,
  });
  return {
    mcpServer: {
      id: server.id,
      name: server.name,
      toolPrefix: server.prefix,
    },
    canEdit: server.canEdit,
    path: server.path,
    included,
    content: accepted,
    repository: repositoryView(source),
    tools: server.tools,
    // The organization's own rules for these tools come first, so they win.
    rootRules: rootToolRules(root.content)
      .filter((rule) => governsServerTool(server.prefix, rule))
      .map((rule) => rule.name),
    organizationHelpers: organizationHelpers(root.content),
    instruction: !repositoryView(source)
      ? "Git sync is not set up, so server rules cannot be proposed. Tell the user an administrator sets it up under Settings → Guardrails."
      : !server.canEdit
        ? "The user may read these rules but not propose a change: that takes edit access to this MCP server in the MCP registry."
        : "To change these rules, write the whole file, preview it with preview_guardrails_server_rules_change, explain it, and propose it with propose_guardrails_server_rules_change once the user agrees.",
    expectedCommit: source?.sourceCommit ?? null,
  };
}

/** Check a proposed file for one server; saves and opens nothing. */
export async function previewServerRulesChange(
  params: Caller & {
    catalogId: string;
    content: string;
    expectedCommit: string;
  },
) {
  const change = await checkedChange(params);
  return { stage: "preview" as const, ...change.view };
}

/** Open a pull request with one server's proposed file. */
export async function proposeServerRulesChange(
  params: Caller & {
    catalogId: string;
    content: string;
    expectedCommit: string;
    summary: string;
  },
) {
  const change = await checkedChange(params);
  if (!change.view.valid)
    throw new ApiError(400, change.view.errors.join("\n"));
  if (!change.rootChanged && change.view.before === params.content)
    throw new ApiError(400, "The proposed rules have no changes");
  const requester = await UserModel.getById(params.userId);
  const title = `Guardrails rules for ${change.server.name}`;
  const body = [
    params.summary.trim(),
    "",
    `Requested in Archestra by ${requester?.name ?? "a user"}${requester?.email ? ` (${requester.email})` : ""}, who may edit the MCP server ${change.server.name} in the MCP registry.`,
    `This changes \`${change.server.path}\`${change.rootChanged ? `, and adds \`${SERVER_RULES_INCLUDE}\` to \`${change.source.path}\`'s include list, so every MCP server's own rules file applies from then on` : ""}. It applies once merged and pulled by Git sync.`,
  ].join("\n");
  const files = [
    {
      path: repositoryPath(change.source, change.server.path),
      content: params.content,
    },
    ...(change.rootChanged
      ? [{ path: change.source.path, content: change.rootAfter }]
      : []),
  ];
  const head = `${BRANCH_PREFIX}${change.server.prefix}-${randomUUID().slice(0, 8)}`;
  const opened = change.source.gitlabTokenId
    ? await openGitlabRequest({ ...change, title, body, files, head })
    : await openGithubPull({ ...change, title, body, files, head });
  return {
    stage: "proposed" as const,
    delivery: "pull_request" as const,
    ...opened,
    repo: change.source.repo,
    ...change.view,
    instruction:
      "Give the user the link. A reviewer of the policy repository merges it; Git sync then applies it. Check its state with get_guardrails_server_rules_change_status.",
  };
}

/** Whether a server's rules pull request is merged, and applied here yet. */
export async function getServerRulesChangeStatus(
  params: Caller & { catalogId: string; number: number },
) {
  const server = await serverFor(params);
  const source = await requireSource(params.organizationId);
  if (source.gitlabTokenId) {
    const access = await resolveOpenAppaGitlabAccess({
      organizationId: params.organizationId,
      gitlabTokenId: source.gitlabTokenId,
    });
    const request = await openappaGitlab.changeStatus({
      access,
      repo: source.repo,
      iid: params.number,
    });
    if (!isServerBranch(server.prefix, request.sourceBranch))
      throw new ApiError(
        404,
        "No rules change for this server has that number",
      );
    const merged = request.state === "merged" && !!request.mergedCommit;
    // Applied once the accepted commit contains what the merge put there.
    const applied =
      merged &&
      (await openappaGitlab.contains({
        access,
        repo: source.repo,
        commit: source.sourceCommit,
        ancestor: request.mergedCommit as string,
      }));
    // A pull applies what is merged; queue one rather than wait for the schedule.
    if (merged && !applied)
      await OpenAppaGithubSyncModel.enqueue(params.organizationId);
    return {
      number: request.iid,
      url: request.webUrl,
      state: request.state,
      applied: merged ? applied : false,
    };
  }
  const { token, api } = await githubWriter(source);
  const base = `${api}/repos/${source.repo}`;
  const pull = await github<{
    number: number;
    html_url: string;
    state: string;
    merged?: boolean;
    merge_commit_sha?: string | null;
    head?: { ref?: string };
  }>({ token, url: `${base}/pulls/${params.number}` });
  if (!isServerBranch(server.prefix, pull.head?.ref ?? ""))
    throw new ApiError(404, "No rules change for this server has that number");
  const merged = pull.merged === true && !!pull.merge_commit_sha;
  // Applied once the accepted commit contains the merge.
  const applied =
    merged &&
    (source.sourceCommit === pull.merge_commit_sha ||
      ["ahead", "identical"].includes(
        (
          await github<{ status?: string }>({
            token,
            url: `${base}/compare/${pull.merge_commit_sha}...${source.sourceCommit}`,
          })
        ).status ?? "",
      ));
  // A pull applies what is merged; queue one rather than wait for the schedule.
  if (merged && !applied)
    await OpenAppaGithubSyncModel.enqueue(params.organizationId);
  return {
    number: pull.number,
    url: pull.html_url,
    state: merged ? "merged" : pull.state === "open" ? "open" : "closed",
    applied: merged ? applied : false,
  };
}

// ===

/** One server as its rules see it, and whether the caller may change them. */
async function serverFor(params: Caller & { catalogId: string }) {
  const { organizationId, userId, catalogId } = params;
  const catalog = await InternalMcpCatalogModel.findById(catalogId, {
    organizationId,
    userId,
    expandSecrets: false,
  });
  if (!catalog)
    throw new ApiError(404, "MCP server not found or you don't have access");
  if (isBuiltInCatalogId(catalog.id))
    throw new ApiError(
      400,
      "The built-in tools are governed by the organization's own policy, not by a server's rules",
    );
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  await ResourcePermissions.require({
    organizationId,
    userId,
    resource: "mcpRegistry",
    scope: catalog.id,
    action: "read",
  });
  // The registry's own edit rule: whoever may edit the server may propose its rules.
  const canEdit = await ResourcePermissions.allows({
    organizationId,
    userId,
    resource: "mcpRegistry",
    scope: catalog.id,
    action: "update",
  });
  // SPDX-SnippetEnd
  const tools = (await ToolModel.getToolNamesByCatalogIds([catalog.id]))
    .map((tool) => tool.name)
    .sort();
  if (tools.length === 0)
    throw new ApiError(
      409,
      `${catalog.name} has no tools yet. Connect it first, so its rules have tools to name.`,
    );
  // The file is named by the server's own slug, and only when every one of
  // its tools carries that prefix and no other server's tool does: a server
  // must not reach another's file, or the built-in tools, through its name.
  const prefix = slugifyMcpServerName(catalog.name);
  const owners = await catalogToolPrefixes(organizationId, {
    targets: [prefix],
    catalogIds: [catalog.id],
  });
  if (!hasOwnFile(catalog, owners))
    throw new ApiError(
      409,
      `${catalog.name}'s tools do not all carry its own name prefix, ${prefix}__, or another server's tools carry it too, so it has no rules file of its own`,
    );
  return {
    id: catalog.id,
    name: catalog.name,
    prefix,
    path: serverRulesPath(prefix),
    canEdit,
    tools,
  };
}

/** The checks a preview and a proposal share, and what the change would do. */
async function checkedChange(
  params: Caller & {
    catalogId: string;
    content: string;
    expectedCommit: string;
  },
) {
  const server = await serverFor(params);
  if (!server.canEdit)
    throw new ApiError(
      403,
      `You may propose ${server.name}'s Guardrails rules only if you may edit it in the MCP registry`,
    );
  const source = await requireSource(params.organizationId);
  if (source.sourceCommit !== params.expectedCommit)
    throw new ApiError(
      409,
      "The policy repository moved on since these rules were read. Read them again.",
    );
  // The same check Git sync makes on every commit, scope included.
  const shape = includedFileErrors(server.path, params.content);
  if (shape.length > 0) throw new ApiError(400, shape.join("\n"));
  const root = await guardrailsPolicyService.get(params.organizationId);
  // A root that folds in no server's file gets them all at once: one review
  // of `appa.toml`, and no server's later file needs another.
  const rootChanged = !includesServerRules(root.content, server.path);
  const rootAfter = rootChanged
    ? await withInclude(root.content, SERVER_RULES_INCLUDE)
    : root.content;
  const before =
    (await acceptedFile({
      organizationId: params.organizationId,
      path: server.path,
    })) ?? "";
  const validation = await guardrailsPolicyService.validate(rootAfter, {
    organizationId: params.organizationId,
    previous: root.content,
    files: new Map([[server.path, params.content]]),
  });
  return {
    server,
    source,
    rootAfter,
    rootChanged,
    view: {
      mcpServer: { id: server.id, name: server.name },
      path: server.path,
      before,
      after: params.content,
      ...policyDiff({ before, after: params.content, path: server.path }),
      ...(rootChanged
        ? {
            rootChange: policyDiff({
              before: root.content,
              after: rootAfter,
              path: source.path,
            }).diff,
          }
        : {}),
      ...validation,
    },
  };
}

/** The root's own `[[policy.tool]]` entries, `server` qualifier included. */
function rootToolRules(root: string): Array<Record<string, unknown>> {
  const tools = asRecord(parsePolicyToml(root)?.policy)?.tool;
  return (Array.isArray(tools) ? tools : []).flatMap((entry) => {
    const rule = asRecord(entry);
    return rule ? [rule] : [];
  });
}

/**
 * The organization's authorities and sanitizers, which a server's rules use
 * but never declare: a rule reaches an authority through an attention mark
 * it permits (`requires = { attention = [...] }`), or by its tags, and a
 * sanitizer by its tags. A `tool_output` sanitizer also needs the tool under
 * `[policy.deployment] confined_results`. Names, tags and permits only; the
 * rest of the policy stays with those who may read it.
 */
function organizationHelpers(root: string) {
  const policy = asRecord(parsePolicyToml(root)?.policy) ?? {};
  const helpers = (kind: string) =>
    (Array.isArray(policy[kind]) ? policy[kind] : []).flatMap((entry) => {
      const helper = asRecord(entry);
      return helper && typeof helper.name === "string"
        ? [
            {
              name: helper.name,
              ...(helper.on !== undefined ? { on: helper.on } : {}),
              tags: Array.isArray(helper.tags) ? helper.tags : [],
              permits: helper.permits ?? {},
            },
          ]
        : [];
    });
  return {
    authorities: helpers("authority"),
    sanitizers: helpers("sanitizer"),
  };
}

async function withInclude(root: string, entry: string): Promise<string> {
  const native = await import("@archestra/openappa-rs");
  const edited = await native.editOpenappaPolicy(root, [
    { kind: "addInclude", entry },
  ]);
  if (edited.content === undefined || edited.content === null)
    throw new ApiError(400, edited.errors.join("\n"));
  return edited.content;
}

/** The file at the accepted commit, or null when the repository has none. */
async function acceptedFile(params: {
  organizationId: string;
  path: string;
}): Promise<string | null> {
  try {
    const files = await openappaRepositoryIncludes.readAccepted({
      organizationId: params.organizationId,
      paths: [params.path],
    });
    return files.get(params.path) ?? null;
  } catch (error) {
    // No accepted commit yet: there is no file to read.
    if (error instanceof ApiError && error.statusCode === 409) return null;
    throw error;
  }
}

function repositoryView(
  source: Awaited<ReturnType<typeof OpenAppaGithubSyncModel.find>>,
) {
  return source?.interval && source.repo && source.path && source.sourceCommit
    ? {
        repo: source.repo,
        branch: source.ref,
        policyFile: source.path,
        commit: source.sourceCommit,
        provider: source.gitlabTokenId ? "gitlab" : "github",
      }
    : null;
}

async function requireSource(organizationId: string) {
  const source = await OpenAppaGithubSyncModel.find(organizationId);
  if (!source?.interval || !source.repo || !source.path || !source.sourceCommit)
    throw new ApiError(
      409,
      "Git sync is not set up, so server rules cannot be proposed. An administrator sets it up under Settings → Guardrails.",
    );
  return {
    ...source,
    repo: source.repo,
    path: source.path,
    sourceCommit: source.sourceCommit,
  };
}

type Source = Awaited<ReturnType<typeof requireSource>>;
type ChangedFile = { path: string; content: string };

async function openGitlabRequest(params: {
  source: Source;
  title: string;
  body: string;
  files: ChangedFile[];
  head: string;
}) {
  const { source } = params;
  const access = await resolveOpenAppaGitlabAccess({
    organizationId: source.organizationId,
    gitlabTokenId: source.gitlabTokenId as string,
  });
  const branch =
    source.ref ??
    (await openappaGitlab.defaultBranch({ access, repo: source.repo }));
  const request = await openappaGitlab.proposeChange({
    access,
    repo: source.repo,
    branch,
    baseSha: source.sourceCommit,
    title: params.title,
    summary: params.body,
    upsert: params.files,
    delete: [],
    head: params.head,
  });
  return { number: request.iid, url: request.webUrl };
}

/**
 * One commit on a new branch from the accepted commit, then a pull request
 * into the source branch: the repository's review sees exactly the change.
 */
async function openGithubPull(params: {
  source: Source;
  title: string;
  body: string;
  files: ChangedFile[];
  head: string;
}) {
  const { source } = params;
  const { token, api } = await githubWriter(source);
  const base = `${api}/repos/${source.repo}`;
  const branch =
    source.ref ??
    (await github<{ default_branch: string }>({ token, url: base }))
      .default_branch;
  const commit = await github<{ tree?: { sha?: string } }>({
    token,
    url: `${base}/git/commits/${source.sourceCommit}`,
  });
  const tree = await github<{ sha: string }>({
    token,
    url: `${base}/git/trees`,
    method: "POST",
    body: {
      base_tree: checkedSha(commit.tree?.sha),
      tree: params.files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    },
  });
  const created = await github<{ sha: string }>({
    token,
    url: `${base}/git/commits`,
    method: "POST",
    body: {
      message: params.title,
      tree: checkedSha(tree.sha),
      parents: [source.sourceCommit],
    },
  });
  await github({
    token,
    url: `${base}/git/refs`,
    method: "POST",
    body: { ref: `refs/heads/${params.head}`, sha: checkedSha(created.sha) },
  });
  let answered = false;
  try {
    const pull = await githubJson<{ number: number; html_url: string }>({
      token,
      url: `${base}/pulls`,
      method: "POST",
      body: {
        title: params.title,
        body: params.body,
        head: params.head,
        base: branch,
      },
      errors: (response) => {
        answered = true;
        return githubPolicyChangeErrors(response);
      },
    });
    return { number: pull.number, url: pull.html_url };
  } catch (error) {
    // Without GitHub's answer the pull request may have opened all the same.
    const opened = answered
      ? null
      : await openPullFor({
          token,
          base,
          repo: source.repo,
          head: params.head,
        });
    if (opened) return opened;
    // A lookup that failed too leaves the branch: it may hold a pull request.
    if (opened === null) await deleteBranch({ token, base, head: params.head });
    throw error;
  }
}

/**
 * The open pull request from `head`, null when there is none, or undefined
 * when GitHub could not say.
 */
async function openPullFor(params: {
  token: string;
  base: string;
  repo: string;
  head: string;
}): Promise<{ number: number; url: string } | null | undefined> {
  const owner = params.repo.slice(0, params.repo.indexOf("/"));
  try {
    const pulls = await github<Array<{ number?: number; html_url?: string }>>({
      token: params.token,
      url: `${params.base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${params.head}`)}`,
    });
    const pull = pulls[0];
    return pull?.number && pull.html_url
      ? { number: pull.number, url: pull.html_url }
      : null;
  } catch (err) {
    logger.warn({ err }, "OpenAPPA could not look for a rules pull request");
    return undefined;
  }
}

/** Remove a rules branch whose pull request did not open; a failure is logged. */
async function deleteBranch(params: {
  token: string;
  base: string;
  head: string;
}) {
  const response = await githubFetch({
    url: `${params.base}/git/refs/heads/${params.head}`,
    token: params.token,
    method: "DELETE",
  }).catch(() => null);
  if (!response?.ok)
    logger.warn(
      { status: response?.status, head: params.head },
      "OpenAPPA could not delete a rules branch whose pull request did not open",
    );
}

async function githubWriter(source: Source) {
  const { token, api } = await resolveOpenAppaGithubAccess(source, {
    contents: "write",
    pull_requests: "write",
  });
  if (!token)
    throw new ApiError(
      409,
      "The policy repository is read without a credential, so no pull request can be opened. An administrator connects a GitHub App in Git sync.",
    );
  return { token, api };
}

function checkedSha(sha: unknown): string {
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha))
    throw new ApiError(502, "GitHub returned an invalid object");
  return sha;
}

async function github<T = unknown>(params: {
  token: string;
  url: string;
  method?: "GET" | "POST" | "PATCH";
  body?: object;
}): Promise<T> {
  return githubJson<T>({ ...params, errors: githubPolicyChangeErrors });
}
