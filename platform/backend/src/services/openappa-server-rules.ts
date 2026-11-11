import { randomUUID } from "node:crypto";
import { isBuiltInCatalogId, slugifyMcpServerName } from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
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
  includesServerRulesFolder,
  parsePolicyToml,
  serverRulesFolderOf,
  serverRulesInclude,
  serverRulesPath,
  withIncludeEntry,
  withRequester,
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
} from "@/services/openappa-github-access";
import {
  hasOwnFile,
  POLICY_CHECK_NAME,
  selfServiceActive,
  syncAppaGithubPolicy,
} from "@/services/openappa-github-sync";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";

/**
 * An MCP server's own Guardrails rules, kept in its file in the Git sync
 * repository's self-service folder (`mcp/<tool prefix>.toml` by default) and
 * included by `appa.toml`, by name or with every server's through
 * `<folder>/*.toml`.
 *
 * Archestra decides only who may propose a change: whoever may edit the
 * server in the MCP registry, by the same rule as the registry's own edit.
 * Every change is a pull request (a merge request on GitLab) on the policy
 * repository; whether and when it applies is the repository's review to
 * decide, and Git sync applies it once merged. Nothing is stored here.
 */

/** Pull request branches this deployment opens for a server's rules. */
const BRANCH_PREFIX = "archestra/openappa-server-";
/** The branch of the pull request that includes the self-service folder. */
const INCLUDE_BRANCH = "archestra/openappa-self-service";

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
  const [root, source] = await Promise.all([
    guardrailsPolicyService.get(params.organizationId),
    OpenAppaGithubSyncModel.find(params.organizationId),
  ]);
  const server = await serverFor(params, serverRulesFolderOf(source));
  // Off, there is nothing to read: the file is the organization's policy,
  // and the registry shows no action. The Keeper passes the reason on.
  if (source?.interval && source.repo && !selfServiceActive(source))
    throw new ApiError(409, SELF_SERVICE_OFF);
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
    // A server without a file yet starts from one that names every tool.
    ...(accepted === null
      ? {
          starter: starterServerRules(
            server,
            root.content,
            serverRulesInclude(serverRulesFolderOf(source)),
          ),
        }
      : {}),
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
        : accepted === null
          ? "This server has no rules file yet. Start from `starter`, which lists every tool with the organization's defaults; write the whole file, preview it with preview_guardrails_server_rules_change, explain it, and propose it with propose_guardrails_server_rules_change once the user agrees."
          : "To change these rules, write the whole file, preview it with preview_guardrails_server_rules_change, explain it, and propose it with propose_guardrails_server_rules_change once the user agrees.",
    expectedCommit: source?.sourceCommit ?? null,
  };
}

/** The most tools the starter file lists one by one. */
const STARTER_TOOLS = 60;

/**
 * The first version of a server's rules file: every tool named, with no
 * rule, so the first proposal decides about each one on purpose. A tool the
 * file writes no rule for keeps the organization's own defaults.
 */
function starterServerRules(
  server: { name: string; prefix: string; tools: string[] },
  root: string,
  include: string,
): string {
  const governed = new Set(
    rootToolRules(root)
      .filter((rule) => governsServerTool(server.prefix, rule))
      .map((rule) => rule.name),
  );
  const lines = [
    `# Guardrails rules for the MCP server ${server.name} (tools ${server.prefix}__*),`,
    "# kept by the people who may edit the server in the MCP registry. The",
    `# organization's appa.toml includes this file through ${include}.`,
    "# A rule appa.toml keeps for the same tool wins over one written here.",
    "",
    "[policy]",
    "version = 2",
    "",
    "# Each tool of the server. A tool with no rule here keeps the organization's",
    "# defaults. Write a rule for one by uncommenting its entry; a rule for",
    `# "${server.prefix}__*" covers every tool this file names no rule for,`,
    "# including tools the server gains later.",
  ];
  for (const tool of server.tools.slice(0, STARTER_TOOLS)) {
    lines.push(
      "",
      governed.has(tool)
        ? `# ${tool}: appa.toml keeps its own rule for this tool, which wins.`
        : `# ${tool}`,
      "# [[policy.tool]]",
      `# name = ${JSON.stringify(tool)}`,
      "# requires = {}",
      "# delta = {}",
    );
  }
  if (server.tools.length > STARTER_TOOLS)
    lines.push(
      "",
      `# ... and ${server.tools.length - STARTER_TOOLS} more tools, all ${server.prefix}__*.`,
    );
  return `${lines.join("\n")}\n`;
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
    `Requested in ${archestraMcpBranding.appName} by ${requester?.name ?? "a user"}${requester?.email ? ` (${requester.email})` : ""}, who may edit the MCP server ${change.server.name} in the MCP registry.`,
    `This changes \`${change.server.path}\`${change.rootChanged ? `, and adds \`${change.include}\` to \`${change.source.path}\`'s include list, so every MCP server's own rules file applies from then on` : ""}. It applies once merged and pulled by Git sync.`,
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
  // The commit names the person who asked, in a trailer GitHub's signature
  // for the App covers: the policy check reads it from there.
  const opened = await openGithubPull({
    ...change,
    title,
    message: requester ? withRequester(title, requester.email) : title,
    body,
    files,
    head,
  });
  return {
    stage: "proposed" as const,
    delivery: "pull_request" as const,
    ...opened,
    repo: change.source.repo,
    ...change.view,
    instruction: `Give the user the link. Once its ${POLICY_CHECK_NAME} check passes, the user merges it on GitHub themselves, or anyone with write access to the repository does; no other approval is needed. Git sync then applies it. Check its state with get_guardrails_server_rules_change_status.`,
  };
}

/** Whether a server's rules pull request is merged, and applied here yet. */
export async function getServerRulesChangeStatus(
  params: Caller & { catalogId: string; number: number },
) {
  const source = await requireSource(params.organizationId);
  const server = await serverFor(params, serverRulesFolderOf(source));
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
async function serverFor(
  params: Caller & { catalogId: string },
  /** The self-service folder its file lives in. */
  folder: string,
) {
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
    path: serverRulesPath(folder, prefix),
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
  const source = await requireSource(params.organizationId);
  const folder = serverRulesFolderOf(source);
  const include = serverRulesInclude(folder);
  const server = await serverFor(params, folder);
  if (!server.canEdit)
    throw new ApiError(
      403,
      `You may propose ${server.name}'s Guardrails rules only if you may edit it in the MCP registry`,
    );
  if (source.sourceCommit !== params.expectedCommit)
    throw new ApiError(
      409,
      "The policy repository moved on since these rules were read. Read them again.",
    );
  // The same check Git sync makes on every commit, scope included.
  const shape = includedFileErrors(server.path, params.content, folder);
  if (shape.length > 0) throw new ApiError(400, shape.join("\n"));
  const root = await guardrailsPolicyService.get(params.organizationId);
  // A root that folds in no server's file gets them all at once: one review
  // of `appa.toml`, and no server's later file needs another.
  const rootChanged = !includesServerRules(root.content, server.path);
  const rootAfter = rootChanged
    ? await withInclude(root.content, include)
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
    include,
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
  try {
    return await withIncludeEntry(root, entry);
  } catch (error) {
    throw new ApiError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

// =============================================================================
// The include that makes the servers' files apply
// =============================================================================

/**
 * Whether the policy file includes the self-service folder, which is what
 * makes each server's file apply: included, or the open pull request that
 * adds the line waits, or neither. Read from the repository, not the accepted
 * copy alone: an include merged but not pulled yet counts, and a pull request
 * left from an earlier folder does not.
 */
export async function selfServiceIncludeState(organizationId: string) {
  const source = await OpenAppaGithubSyncModel.find(organizationId);
  const folder = serverRulesFolderOf(source);
  const situation = await includeSituation({ organizationId, source, folder });
  return situation.state === "pull_open"
    ? { folder, state: situation.state, pull: situation.pull }
    : { folder, state: situation.state };
}

type IncludeSituation =
  | { state: "included" }
  | { state: "pull_open"; pull: { number: number; url: string } }
  | {
      state: "missing";
      /** Our open pull request for another folder, to close before a new one. */
      stale?: { number: number; url: string };
    };

/**
 * Where the folder's include stands, in this order: the accepted policy has
 * it; the synced branch has it, so a sync is queued and nothing is opened;
 * our pull request for it waits; our pull request waits for another folder;
 * nothing.
 */
async function includeSituation(params: {
  organizationId: string;
  source: Awaited<ReturnType<typeof OpenAppaGithubSyncModel.find>>;
  folder: string;
}): Promise<IncludeSituation> {
  const { organizationId, source, folder } = params;
  const root = await guardrailsPolicyService.get(organizationId);
  if (includesServerRulesFolder(root.content, folder))
    return { state: "included" };
  if (
    !source?.interval ||
    !source.repo ||
    !source.path ||
    !source.githubAppConfigId
  )
    return { state: "missing" };
  const repo = source.repo;
  const { token, api } = await githubWriter({
    ...source,
    repo,
    githubAppConfigId: source.githubAppConfigId,
  });
  const base = `${api}/repos/${repo}`;
  const branch =
    source.ref ??
    (await github<{ default_branch: string }>({ token, url: base }))
      .default_branch;
  const atBranch = await rootAt({
    token,
    base,
    path: source.path,
    ref: branch,
  });
  if (atBranch !== null && includesServerRulesFolder(atBranch, folder)) {
    // Merged, not pulled yet: the next pull brings it, so nothing to open.
    await OpenAppaGithubSyncModel.enqueue(organizationId);
    return { state: "included" };
  }
  const pull = await openPullFor({ token, base, repo, head: INCLUDE_BRANCH });
  if (!pull) return { state: "missing" };
  const atHead = pull.headSha
    ? await rootAt({ token, base, path: source.path, ref: pull.headSha })
    : null;
  return atHead !== null && includesServerRulesFolder(atHead, folder)
    ? { state: "pull_open", pull: { number: pull.number, url: pull.url } }
    : { state: "missing", stale: { number: pull.number, url: pull.url } };
}

/** The policy file's text at `ref`, or null when the ref has none. */
async function rootAt(params: {
  token: string;
  base: string;
  path: string;
  ref: string;
}): Promise<string | null> {
  const path = params.path.split("/").map(encodeURIComponent).join("/");
  const response = await githubFetch({
    url: `${params.base}/contents/${path}?ref=${encodeURIComponent(params.ref)}`,
    token: params.token,
    accept: "application/vnd.github.raw+json",
  }).catch(() => null);
  if (!response) return null;
  if (response.status === 404) return null;
  if (!response.ok)
    throw new ApiError(502, `GitHub returned HTTP ${response.status}`);
  return response.text();
}

/**
 * Open the pull request that adds `<folder>/*.toml` to the policy file's
 * include list, in the caller's name, when the file lacks it and no such
 * pull request waits. Returns what was opened, or null when nothing was:
 * an include already in place, or on its way, needs no pull request, and
 * one of ours left from an earlier folder is closed first.
 */
export async function ensureSelfServiceInclude(params: Caller) {
  // A source just saved has no accepted commit yet: pull it now rather than
  // wait for the schedule, so the pull request opens at once.
  const saved = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (saved?.interval && saved.repo && saved.path && !saved.sourceCommit)
    await syncAppaGithubPolicy(params.organizationId);
  const source = await requireSource(params.organizationId);
  const folder = serverRulesFolderOf(source);
  const entry = serverRulesInclude(folder);
  const situation = await includeSituation({
    organizationId: params.organizationId,
    source,
    folder,
  });
  if (situation.state !== "missing") return null;
  const root = await guardrailsPolicyService.get(params.organizationId);
  const { token, api } = await githubWriter(source);
  const base = `${api}/repos/${source.repo}`;
  if (situation.stale) {
    await github({
      token,
      url: `${base}/pulls/${situation.stale.number}`,
      method: "PATCH",
      body: {
        state: "closed",
        body: `Closed by ${archestraMcpBranding.appName}: the self-service folder is now \`${folder}/\`, and a new pull request includes it.`,
      },
    });
  }
  const after = await withInclude(root.content, entry);
  const requester = await UserModel.getById(params.userId);
  const title = `Include each MCP server's Guardrails rules file`;
  // Git keeps no empty folder: a README starts it, and says what goes there.
  const readme = repositoryPath(source, `${folder}/README.md`);
  const folderExists = await githubFetch({
    url: `${base}/contents/${repositoryPath(source, folder)}?ref=${source.sourceCommit}`,
    token,
  })
    .then((response) => response.ok)
    .catch(() => false);
  const body = [
    `Adds \`${entry}\` to \`${source.path}\`'s include list, so the rules file each MCP server keeps in \`${folder}/\` applies once merged and pulled by Git sync.${folderExists ? "" : ` Starts \`${folder}/\` with a README.`}`,
    "",
    `Requested in ${archestraMcpBranding.appName} by ${requester?.name ?? "an administrator"}${requester?.email ? ` (${requester.email})` : ""}, who turned MCP Guardrails Self-Service on.`,
  ].join("\n");
  // A branch left by an earlier, closed pull request would refuse the new ref.
  await deleteBranch({ token, base, head: INCLUDE_BRANCH });
  return openGithubPull({
    source,
    title,
    message: requester ? withRequester(title, requester.email) : title,
    body,
    files: [
      { path: source.path, content: after },
      ...(folderExists
        ? []
        : [
            {
              path: readme,
              content: serverRulesReadme(folder, source.path),
            },
          ]),
    ],
    head: INCLUDE_BRANCH,
  });
}

/** What the servers' folder is for, for whoever opens it on GitHub. */
function serverRulesReadme(folder: string, policyPath: string): string {
  const policyFile = policyPath.slice(policyPath.lastIndexOf("/") + 1);
  return [
    "# Guardrails rules per MCP server",
    "",
    `Each MCP server's Guardrails rules live here, one \`<tool prefix>.toml\` file per server, which \`${policyFile}\` includes through \`${folder}/*.toml\`. A file holds rules for its own server's tools only; a rule in \`${policyFile}\` for the same tool wins.`,
    "",
    `The people who may edit a server in the ${archestraMcpBranding.appName} MCP registry change its file through **Edit Guardrails rules** there, which opens a pull request. The ${archestraMcpBranding.appName} policy check on each pull request confirms the change.`,
    "",
  ].join("\n");
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

/** The refusal every server rules tool gives while self-service is off. */
const SELF_SERVICE_OFF =
  "MCP Guardrails Self-Service is off, so server rules cannot be read or proposed here. An administrator turns it on under Settings → Guardrails → Git sync.";

async function requireSource(organizationId: string) {
  const source = await OpenAppaGithubSyncModel.find(organizationId);
  if (!source?.interval || !source.repo || !source.path || !source.sourceCommit)
    throw new ApiError(
      409,
      "Git sync is not set up, so server rules cannot be proposed. An administrator sets it up under Settings → Guardrails.",
    );
  if (!selfServiceActive(source)) throw new ApiError(409, SELF_SERVICE_OFF);
  return {
    ...source,
    repo: source.repo,
    path: source.path,
    sourceCommit: source.sourceCommit,
  };
}

type Source = Awaited<ReturnType<typeof requireSource>>;
type ChangedFile = { path: string; content: string };

/**
 * One commit on a new branch from the accepted commit, then a pull request
 * into the source branch: the repository's review sees exactly the change.
 */
async function openGithubPull(params: {
  source: Source;
  title: string;
  /** The commit message: the title, and who asked. */
  message: string;
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
    // No author or committer: GitHub signs the commit for the App only then.
    body: {
      message: params.message,
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
}): Promise<
  { number: number; url: string; headSha?: string } | null | undefined
> {
  const owner = params.repo.slice(0, params.repo.indexOf("/"));
  try {
    const pulls = await github<
      Array<{ number?: number; html_url?: string; head?: { sha?: string } }>
    >({
      token: params.token,
      url: `${params.base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${params.head}`)}`,
    });
    const pull = pulls[0];
    return pull?.number && pull.html_url
      ? {
          number: pull.number,
          url: pull.html_url,
          ...(typeof pull.head?.sha === "string"
            ? { headSha: pull.head.sha }
            : {}),
        }
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

async function githubWriter(
  source: Pick<
    Source,
    "organizationId" | "repo" | "githubPatId" | "githubAppConfigId"
  >,
) {
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
